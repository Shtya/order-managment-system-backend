import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { QueueNames, TagAutomationJobs } from "../common/queue.constants";
import { Job, JobState, MetricsTime, Queue } from "bullmq";
import {
  QueueDelayConfig,
  QueueDelayService,
} from "../common/queue-delay.service";
import { TagAutomationEvaluator } from "src/tags/tag-automation.evaluator";

const EVALUATE_ORDER_DELAY_MS = 0;

type EvaluateOrderJobData = {
  orderId: string;
  adminId?: string;
  type: string;
};

@Injectable()
export class TagAutomationQueueService {
  private readonly logger = new Logger(TagAutomationQueueService.name);

  constructor(
    @InjectQueue(QueueNames.TAG_AUTOMATIONS)
    private readonly tagAutomationsQueue: Queue,
  ) {}

  async enqueueEvaluateOrder(orderId: string) {
    if (!orderId) return;

    const jobId = `tag-eval-${orderId}`;

    try {
      await this.tagAutomationsQueue.add(
        TagAutomationJobs.EVALUATE_ORDER,
        {
          orderId,
          type: TagAutomationJobs.EVALUATE_ORDER,
        },
        {
          jobId,
          delay: EVALUATE_ORDER_DELAY_MS,
          removeOnComplete: true,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("already exists")) {
        return;
      }
      this.logger.error(
        `Failed to enqueue tag evaluation for order ${orderId}`,
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }
  }
}

@Processor(QueueNames.TAG_AUTOMATIONS, {
  concurrency: 20,
  maxStartedAttempts: 200,
  metrics: {
    maxDataPoints: MetricsTime.ONE_WEEK * 2,
  },
})
export class TagAutomationWorkerService extends WorkerHost {
  private readonly logger = new Logger(TagAutomationWorkerService.name);
  private readonly queueConfig: Partial<QueueDelayConfig> = {
    keyPrefix: "tag-automations",
    maxPerUser: 5,
  };

  constructor(
    private readonly queueDelayService: QueueDelayService,
    @Inject(forwardRef(() => TagAutomationEvaluator))
    private readonly tagAutomationEvaluator: TagAutomationEvaluator,
  ) {
    super();
  }

  async process(job: Job<EvaluateOrderJobData>, token?: string): Promise<any> {
    const slotKey = job.data.adminId || job.data.orderId;
    return this.queueDelayService.acquireUserSlotAndProcess(
      job,
      token,
      slotKey,
      () => this.handleJob(job),
      this.queueConfig,
    );
  }

  private async handleJob(job: Job<EvaluateOrderJobData>): Promise<any> {
    const { type, orderId } = job.data;
    this.logger.debug(`Processing Job ${job.id} | Type: ${type}`);

    try {
      if (type === TagAutomationJobs.EVALUATE_ORDER && orderId) {
        this.logger.log(
          `=== STARTING Job ${job.id} | Type: ${type} | Evaluating tags for order ${orderId}`,
        );
        await this.tagAutomationEvaluator.processEvaluateOrder(orderId);
        this.logger.log(
          `=== SUCCESS: Finished tag evaluation job ${job.id} (order ${orderId})`,
        );
        return;
      }
    } catch (error) {
      this.logger.error(`=== ERROR processing job ${job.id}:`, error);
      throw error;
    }
  }
}
