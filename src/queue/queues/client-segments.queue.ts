import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { Job, MetricsTime, Queue } from "bullmq";
import { ClientSegmentJobs, QueueNames } from "../common/queue.constants";
import { ClientSegmentsService } from "src/client-segments/client-segments.service";

export type FreezeClientSegmentJobData = {
  adminId: string;
  segmentId: string;
  userId?: string;
};

@Injectable()
export class ClientSegmentQueueService {
  private readonly logger = new Logger(ClientSegmentQueueService.name);

  constructor(
    @InjectQueue(QueueNames.CLIENT_SEGMENTS)
    private readonly clientSegmentsQueue: Queue,
  ) {}

  async enqueueFreeze(adminId: string, segmentId: string, userId?: string) {
    if (!adminId || !segmentId) return;

    const jobId = `freeze-${segmentId}`;

    try {
      await this.clientSegmentsQueue.add(
        ClientSegmentJobs.FREEZE,
        { adminId, segmentId, userId } satisfies FreezeClientSegmentJobData,
        {
          jobId,
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("already exists")) {
        return;
      }
      this.logger.error(
        `Failed to enqueue freeze for segment ${segmentId}`,
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }
  }
}

@Processor(QueueNames.CLIENT_SEGMENTS, {
  concurrency: 2,
  maxStartedAttempts: 200,
  metrics: {
    maxDataPoints: MetricsTime.ONE_WEEK * 2,
  },
})
export class ClientSegmentWorkerService extends WorkerHost {
  private readonly logger = new Logger(ClientSegmentWorkerService.name);

  constructor(
    @Inject(forwardRef(() => ClientSegmentsService))
    private readonly clientSegmentsService: ClientSegmentsService,
  ) {
    super();
  }

  async process(job: Job<FreezeClientSegmentJobData>) {
    const { adminId, segmentId, userId } = job.data;
    this.logger.log(
      `Freezing segment ${segmentId} | Admin: ${adminId} | Job: ${job.id}`,
    );

    try {
      await this.clientSegmentsService.processFreezeJob(adminId, segmentId, userId);
    } catch (error) {
      const maxAttempts = Number(job.opts.attempts ?? 1);
      if (job.attemptsMade + 1 >= maxAttempts) {
        await this.clientSegmentsService.markFreezeFailed(adminId, segmentId, userId);
      }
      throw error;
    }
  }
}
