import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { AutoAssignmentJobs, QueueNames } from "../common/queue.constants";
import { Job, JobsOptions, MetricsTime, Queue } from "bullmq";
import { AssignmentMode } from "entities/clientSettings.entity";
import { TimeUnit } from "entities/clientSettings.entity";
import { OrdersService } from "src/orders/services/orders.service";
import { OrderAssignmentService } from "src/order-assignment/order-assignment.service";
import { createHash } from "crypto";
import {
  QueueDelayConfig,
  QueueDelayService,
} from "../common/queue-delay.service";
import { ClientSettingsService } from "src/client-settings/client-settings.service";

type ExpireAssignmentJobData = {
  adminId: string;
  orderId: string;
  assignmentId: string;
};

type AssignOrdersJobData = {
  adminId: string;
  orderIds: string[];
};

@Injectable()
export class AutoAssignmentQueueService {
  private readonly log = new Logger(AutoAssignmentQueueService.name);
  constructor(
    @InjectQueue(QueueNames.AUTO_ASSIGNMENT)
    private readonly autoAssignmentQueue: Queue,
    @Inject(forwardRef(() => OrdersService))
    protected readonly ordersService: OrdersService,
    private readonly clientSettingsService: ClientSettingsService,
  ) {}

  async addAutoAssignmentJob(
    data: { adminId: string; orderIds: string[] },
    opts?: JobsOptions,
  ) {
    this.log.debug(
      `Adding Auto Assignment Job for Admin: ${data.adminId} | Orders: ${data.orderIds?.length} ${data.orderIds?.join(", ")}`,
    );
    if (!data?.adminId || !data?.orderIds?.length) return;

    // ⚙️ Load settings (move this outside if you want pure queue layer separation)
    const settings = await this.clientSettingsService.getCachedSettings(
      data.adminId,
    ); // or inject OrdersService

    const assignmentMode = settings.assignmentMode;
    this.log.debug(
      `Auto Assignment Mode for Admin ${data.adminId}: ${assignmentMode}`,
    );
    if (assignmentMode === AssignmentMode.DISABLED) {
      return;
    }

    // ⏱ delay calculation
    let delayMs = 0;

    if (assignmentMode === AssignmentMode.DELAYED) {
      const { assignmentDelay, assignmentDelayUnit } = settings;

      const unitMultiplier = {
        [TimeUnit.MINUTES]: 60 * 1000,
        [TimeUnit.HOURS]: 60 * 60 * 1000,
        [TimeUnit.DAYS]: 24 * 60 * 60 * 1000,
      };

      delayMs = assignmentDelay * (unitMultiplier[assignmentDelayUnit] || 0);
    }
    const orderHash = createHash("sha1")
      .update([...data.orderIds].sort().join(","))
      .digest("hex");
    // 🔑 idempotency key (prevents duplicate enqueue per admin batch)
    const jobId = opts?.jobId ?? `auto-assignment-${data.adminId}-${orderHash}`;

    return this.autoAssignmentQueue.add(
      AutoAssignmentJobs.ASSIGN_ORDERS,
      {
        adminId: data.adminId,
        orderIds: data.orderIds,
      },
      {
        ...opts,
        jobId,
        delay: delayMs,
        // jobId: undefined,
      },
    );
  }

  async enqueueExpireAssignment(
    adminId: string,
    data: { orderId: string; assignmentId: string },
    options?: { delayMs?: number },
  ) {
    if (!adminId || !data?.orderId || !data?.assignmentId) return;

    const delayMs = options?.delayMs ?? 0;
    const jobId = `expire-assignment-${data.assignmentId}`;

    this.log.debug(
      `Enqueue expire assignment ${data.assignmentId} for order ${data.orderId} (delayMs=${delayMs})`,
    );

    await this.autoAssignmentQueue.add(
      AutoAssignmentJobs.EXPIRE_ASSIGNMENT,
      {
        adminId,
        orderId: data.orderId,
        assignmentId: data.assignmentId,
      },
      { jobId, delay: delayMs },
    );
  }
}

@Processor(QueueNames.AUTO_ASSIGNMENT, {
  concurrency: 20,
  metrics: {
    maxDataPoints: MetricsTime.ONE_WEEK * 2,
  },
})
export class AutoAssignmentWorkerService extends WorkerHost {
  private readonly logger = new Logger(AutoAssignmentWorkerService.name);
  private readonly queueConfig: Partial<QueueDelayConfig> = {
    keyPrefix: "auto-assignment",
    maxPerUser: 5,
  };

  constructor(
    @Inject(forwardRef(() => OrderAssignmentService))
    private readonly orderAssignmentService: OrderAssignmentService,
    private readonly queueDelayService: QueueDelayService,
  ) {
    super();
  }

  async process(
    job: Job<AssignOrdersJobData | ExpireAssignmentJobData>,
    token?: string,
  ): Promise<any> {
    const { adminId } = job.data;
    return this.queueDelayService.acquireUserSlotAndProcess(
      job,
      token,
      adminId,
      () => this.handleJob(job),
      this.queueConfig,
    );
  }

  private async handleJob(
    job: Job<AssignOrdersJobData | ExpireAssignmentJobData>,
  ) {
    const { adminId } = job.data;

    try {
      if (job.name === AutoAssignmentJobs.EXPIRE_ASSIGNMENT) {
        const { orderId, assignmentId } = job.data as ExpireAssignmentJobData;
        this.logger.debug(
          `Processing Expire Assignment Job for Admin: ${adminId} | Assignment: ${assignmentId}`,
        );
        return await this.orderAssignmentService.expireAssignment(adminId, {
          orderId,
          assignmentId,
        });
      }

      const { orderIds } = job.data as AssignOrdersJobData;
      this.logger.debug(
        `Processing Assignment Job for Admin: ${adminId} | Orders: ${orderIds?.length}`,
      );
      return await this.orderAssignmentService.processAutoAssignment(
        adminId,
        orderIds,
      );
    } catch (err) {
      this.logger.error(
        `Failed auto-assignment job ${job.name} for admin ${adminId}`,
        err instanceof Error ? err.stack : err,
      );
      throw err; // triggers retry (BullMQ handles it)
    }
  }
}
