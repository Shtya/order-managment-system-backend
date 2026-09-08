import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { DelayedError, Job, MetricsTime, Queue } from "bullmq";
import { CampaignJobs, QueueNames } from "../common/queue.constants";
import {
  QueueDelayConfig,
  QueueDelayService,
} from "../common/queue-delay.service";
import { CampaignsService } from "src/campaigns/campaigns.service";
import { CampaignWebhookEventsService } from "src/campaigns/campaign-webhook-events.service";
import { CampaignRecipientDeliveryStatus } from "entities/campaigns.entity";

export type CampaignWebhookEventKind = "delivery" | "reply" | "link";

export type CampaignJobData = {
  type: string;
  adminId: string;
  campaignId?: string;
  kind?: CampaignWebhookEventKind;
  providerMessageId?: string;
  campaignRecipientId?: string;
  status?: CampaignRecipientDeliveryStatus;
  at?: string;
  failureReason?: string | null;
  whatsappMessageId?: string;
  buttonText?: string | null;
  buttonId?: string | null;
};

export type CampaignSendTickResult = {
  action: "sent" | "failed" | "idle" | "deferral";
  delayMs?: number;
  campaignId?: string;
  recipientId?: string;
  durationMs?: number;
};

export type CampaignSenderSlot = <T>(fn: () => Promise<T>) => Promise<T>;

const SEND_LOOP_JOB_ID = (campaignId: string) =>
  `campaign-send-loop-${campaignId}`;

const WHATSAPP_SENDER_SLOT: Partial<QueueDelayConfig> = {
  keyPrefix: "campaign-whatsapp",
  maxPerUser: 1,
  lockTimeout: 5 * 60 * 1000,
};

@Injectable()
export class CampaignQueueService {
  private readonly logger = new Logger(CampaignQueueService.name);

  constructor(
    @InjectQueue(QueueNames.CAMPAIGNS)
    private readonly campaignsQueue: Queue,
  ) {}

  async enqueueMaterialize(adminId: string, campaignId: string) {
    if (!adminId || !campaignId) return;
    const jobId = `campaign-materialize-${campaignId}`;
    try {
      await this.campaignsQueue.add(
        CampaignJobs.MATERIALIZE,
        { adminId, campaignId, type: CampaignJobs.MATERIALIZE },
        {
          jobId,
          priority: 10,
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (error) {
      if (String(error?.message ?? error).toLowerCase().includes("already exists")) {
        return;
      }
      throw error;
    }
  }

  async enqueueScheduleCheck(
    adminId: string,
    campaignId: string,
    delayMs: number,
  ) {
    if (!adminId || !campaignId || delayMs <= 0) return;
    const jobId = `campaign-schedule-${campaignId}`;
    try {
      await this.campaignsQueue.add(
        CampaignJobs.SCHEDULE_CHECK,
        { adminId, campaignId, type: CampaignJobs.SCHEDULE_CHECK },
        {
          jobId,
          delay: delayMs,
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (error) {
      if (String(error?.message ?? error).toLowerCase().includes("already exists")) {
        return;
      }
      throw error;
    }
  }

  // One SEND_NEXT job per campaign. Never inspect or remove another
  // campaign's loop. Live jobs are left alone; only the finishing tick
  // may replace its own jobId.
  async ensureSendLoop(
    adminId: string,
    campaignId: string,
    delayMs = 0,
    replaceJobId?: string,
  ) {
    if (!adminId || !campaignId) return;
    const jobId = SEND_LOOP_JOB_ID(campaignId);
    const existing = await this.campaignsQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      const replaceOwnFinishedJob =
        !!replaceJobId && existing.id === replaceJobId;
      if (!replaceOwnFinishedJob) {
        if (
          state === "completed" ||
          state === "failed"
        ) {
          try {
            await existing.remove();
          } catch (error) {
            this.logger.warn(
              `Failed to remove leftover send-loop job for campaign ${campaignId}: ${error instanceof Error ? error.message : error}`,
            );
            return;
          }
        } else {
          return;
        }
      } else {
        try {
          await existing.remove();
        } catch (error) {
          this.logger.warn(
            `Failed to replace send-loop job for campaign ${campaignId}: ${error instanceof Error ? error.message : error}`,
          );
          return;
        }
      }
    }
    try {
      await this.campaignsQueue.add(
        CampaignJobs.SEND_NEXT,
        { adminId, campaignId, type: CampaignJobs.SEND_NEXT },
        {
          jobId,
          delay: delayMs > 0 ? delayMs : undefined,
          priority: 1,
          attempts: 5,
          backoff: { type: "exponential", delay: 10000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (error) {
      if (String(error?.message ?? error).toLowerCase().includes("already exists")) {
        return;
      }
      throw error;
    }
  }

  async removeScheduledJob(campaignId: string) {
    await this.removeJobById(`campaign-schedule-${campaignId}`);
  }

  async removeMaterializeJob(campaignId: string) {
    await this.removeJobById(`campaign-materialize-${campaignId}`);
  }

  async removeSendLoop(campaignId: string) {
    await this.removeJobById(SEND_LOOP_JOB_ID(campaignId));
  }

  async enqueueWebhookEvent(data: Omit<CampaignJobData, "type">) {
    if (!data.adminId) return;
    const jobId = this.webhookEventJobId(data);
    try {
      await this.campaignsQueue.add(
        CampaignJobs.WEBHOOK_EVENT,
        { ...data, type: CampaignJobs.WEBHOOK_EVENT },
        {
          jobId,
          priority: 5,
          attempts: 5,
          backoff: { type: "exponential", delay: 3000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (error) {
      if (String(error?.message ?? error).toLowerCase().includes("already exists")) {
        return;
      }
      throw error;
    }
  }

  private webhookEventJobId(data: Omit<CampaignJobData, "type">) {
    if (data.kind === "link" && data.campaignRecipientId) {
      return `campaign-event-link-${data.campaignRecipientId}`;
    }
    if (data.kind === "reply" && data.providerMessageId) {
      return `campaign-event-reply-${data.adminId}-${data.providerMessageId}`;
    }
    if (data.kind === "delivery" && data.providerMessageId && data.status) {
      return `campaign-event-delivery-${data.adminId}-${data.providerMessageId}-${data.status}`;
    }
    return undefined;
  }

  async removeCampaignJobs(campaignId: string) {
    await Promise.all([
      this.removeMaterializeJob(campaignId),
      this.removeScheduledJob(campaignId),
      this.removeSendLoop(campaignId),
    ]);
  }

  private async removeJobById(jobId: string) {
    try {
      const job = await this.campaignsQueue.getJob(jobId);
      if (job) await job.remove();
    } catch (error) {
      this.logger.warn(
        `Failed to remove campaign job ${jobId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

@Processor(QueueNames.CAMPAIGNS, {
  concurrency: 10,
  metrics: {
    maxDataPoints: MetricsTime.ONE_WEEK * 2,
  },
})
export class CampaignWorkerService extends WorkerHost {
  private readonly logger = new Logger(CampaignWorkerService.name);

  constructor(
    @Inject(forwardRef(() => CampaignsService))
    private readonly campaignsService: CampaignsService,
    @Inject(forwardRef(() => CampaignQueueService))
    private readonly campaignQueue: CampaignQueueService,
    private readonly campaignWebhookEvents: CampaignWebhookEventsService,
    private readonly queueDelayService: QueueDelayService,
  ) {
    super();
  }

  async process(job: Job<CampaignJobData>, token?: string): Promise<any> {
    const { type, adminId, campaignId } = job.data ?? {};
    try {
      if (type === CampaignJobs.MATERIALIZE && campaignId) {
        return await this.campaignsService.materializeCampaign(
          adminId,
          campaignId,
        );
      }
      if (type === CampaignJobs.SCHEDULE_CHECK && campaignId) {
        return await this.campaignsService.runScheduledCampaign(
          adminId,
          campaignId,
        );
      }
      if (type === CampaignJobs.WEBHOOK_EVENT && adminId) {
        return await this.processWebhookEvent(job.data);
      }
      if (type === CampaignJobs.SEND_NEXT && adminId && campaignId) {
        const sendWithSenderSlot: CampaignSenderSlot = (fn) =>
          this.queueDelayService.acquireUserSlotAndProcess(
            job,
            token,
            adminId,
            fn,
            WHATSAPP_SENDER_SLOT,
          );
        return await this.campaignsService.advanceCampaignSend(
          adminId,
          campaignId,
          sendWithSenderSlot,
        );
      }
      this.logger.warn(`Unknown campaign job type: ${type}`);
    } catch (error) {
      if (error instanceof DelayedError) throw error;
      this.logger.error(
        `Campaign job ${job.id} failed: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  private async processWebhookEvent(data: CampaignJobData) {
    const at = data.at ? new Date(data.at) : new Date();
    if (data.kind === "link") {
      if (!data.campaignRecipientId || !data.whatsappMessageId) return;
      await this.campaignWebhookEvents.linkWhatsappMessage({
        campaignRecipientId: data.campaignRecipientId,
        whatsappMessageId: data.whatsappMessageId,
      });
      return;
    }
    if (data.kind === "reply" && data.providerMessageId) {
      await this.campaignWebhookEvents.applyReplyEvent({
        adminId: data.adminId,
        providerMessageId: data.providerMessageId,
        at,
        buttonText: data.buttonText,
        buttonId: data.buttonId,
      });
      return;
    }
    if (data.kind === "delivery" && data.status) {
      await this.campaignWebhookEvents.applyDeliveryEvent({
        adminId: data.adminId,
        providerMessageId: data.providerMessageId,
        campaignRecipientId: data.campaignRecipientId,
        status: data.status,
        at,
        failureReason: data.failureReason,
      });
    }
  }

  @OnWorkerEvent("completed")
  async onCompleted(job: Job<CampaignJobData>, result: CampaignSendTickResult) {
    if (job.data?.type !== CampaignJobs.SEND_NEXT) return;
    if (!result || result.action === "idle") return;
    const campaignId = job.data.campaignId;
    if (!campaignId) return;
    await this.campaignQueue.ensureSendLoop(
      job.data.adminId,
      campaignId,
      result.delayMs ?? 0,
      job.id,
    );
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job<CampaignJobData>, error: Error) {
    if (error instanceof DelayedError) return;
    if (
      job?.data?.type !== CampaignJobs.SEND_NEXT ||
      !job.data.adminId ||
      !job.data.campaignId
    ) {
      return;
    }
    const maxAttempts = job.opts.attempts ?? 1;
    if ((job.attemptsMade ?? 0) < maxAttempts) return;
    this.logger.error(
      `Campaign send-loop exhausted retries for campaign ${job.data.campaignId}: ${error?.message ?? error}`,
    );
    await this.campaignsService.failInFlightSending(
      job.data.adminId,
      job.data.campaignId,
    );
    await this.campaignQueue.ensureSendLoop(
      job.data.adminId,
      job.data.campaignId,
      0,
      job.id,
    );
  }
}
