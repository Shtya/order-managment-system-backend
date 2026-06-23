import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { OrderSyncJobs, QueueNames } from "../common/queue.constants";
import { Job, JobsOptions, MetricsTime, Queue } from "bullmq";
import { OrderEntity } from "entities/order.entity";
import { StoresService } from "src/stores/stores.service";
import { QueueDelayConfig, QueueDelayService } from "../common/queue-delay.service";
import { StoreProvider } from "entities/stores.entity";
import { ProviderCode } from "src/shipping/providers/shipping-provider.interface";
import { BulkAssignOrderDto } from "src/shipping/shipping.dto";

@Injectable()
export class OrderSyncQueueService {
  constructor(
    @InjectQueue(QueueNames.ORDER_SYNC)
    private readonly orderSyncQueue: Queue,
  ) { }

  private async addJob(
    adminId: string,
    type: string,
    storeType: StoreProvider,
    data: any,
    options: JobsOptions = {},
  ) {
    if (!adminId) return;

    return await this.orderSyncQueue.add(
      type,
      {
        ...data,
        type,
        storeType,
        adminId,
      },
      {
        jobId: options.jobId,
        ...options
      }
    );
  }

  async enqueueBulkOrderCreate(
    adminId: string,
    orders: any[],
  ) {
    if (!orders?.length) return;

    const jobId = `bulk-orders::${adminId}:${Date.now()}`;

    await this.addJob(
      adminId,
      OrderSyncJobs.BULK_CREATE_ORDERS,
      null,
      {
        orders,
        adminId,
      },
      {
        jobId,
      }
    );
  }

  async enqueueOrderStatusSync(order: OrderEntity, storeId: string, storeType: StoreProvider, newStatusId: string, oldStatusId?: string) {
    await this.addJob(order.adminId, OrderSyncJobs.SYNC_ORDER_STATUS, storeType, {
      orderId: order.id,
      newStatusId,
      storeId,
      oldStatusId,
    });
  }

  async enqueueRetryFailedOrder(adminId: string, failureId: string, provider: StoreProvider) {
    const jobId = `retry-failed-order:${failureId}`;
    await this.addJob(adminId, OrderSyncJobs.RETRY_FAILED_ORDER, provider, {
      failureId,
    }, { jobId });
  }

  async enqueueBulkShippingTasks(
    adminId: string,
    provider: ProviderCode,
    dto: BulkAssignOrderDto,
  ) {
    if (!dto?.items?.length) return;

    const jobId = `bulk-shipping:${adminId}:${Date.now()}`;

    await this.addJob(
      adminId,
      OrderSyncJobs.BULK_SHIPPING,
      null,
      {
        adminId,
        provider,
        items: dto.items,
      },
      {
        jobId,
      }
    );
  }
}

@Processor(QueueNames.ORDER_SYNC, {
  concurrency: 10,
  maxStartedAttempts: 200,
  metrics: {
    maxDataPoints: MetricsTime.ONE_WEEK * 2,
  },
})
export class OrderSyncWorkerService extends WorkerHost {
  private readonly logger = new Logger(OrderSyncWorkerService.name);
  private readonly queueConfig: Partial<QueueDelayConfig> = {
    keyPrefix: 'order-sync',
    maxPerUser: 3,
  };

  constructor(
    private readonly queueDelayService: QueueDelayService,
    @Inject(forwardRef(() => StoresService))
    private readonly storesService: StoresService,
  ) {
    super();
  }

  async process(job: Job, token?: string): Promise<any> {
    const { adminId } = job.data;
    return this.queueDelayService.acquireUserSlotAndProcess(
      job,
      token,
      adminId,
      () => this.handleJob(job),
      this.queueConfig,
    );
  }

  private async handleJob(job: Job): Promise<any> {
    const { type } = job.data;
    this.logger.debug(`Processing Job ${job.id} | Type: ${type}`);
    await this.storesService.processOrderSyncJob(job.data);
  }
}
