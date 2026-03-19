import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { Worker, ReservedJob } from "groupmq";
import { shippingQueue, ShippingJobType } from "./shipping.queues";
import { ShippingService } from "../shipping.service";
import { RedisService } from "common/redis/RedisService";

@Injectable()
export class ShippingWorkerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(this.constructor.name);
    private worker: Worker;

    constructor(private readonly shippingService: ShippingService, private readonly redisService: RedisService) { }

    async onModuleInit() {
        const namespace = shippingQueue.namespace || 'groupmq';
        const deleted = await this.redisService.clearQueueRecoveryKeys(namespace, shippingQueue.redis);

        if (deleted > 0) {
            this.logger.warn(`[Recovery] Cleared ${deleted} orphaned locks for ${namespace}`);
        }

        this.worker = new Worker({
            queue: shippingQueue,
            concurrency: 10, // Process 10 shipments across all admins simultaneously
            handler: async (job: ReservedJob) => {
                return this.processShippingJob(job.data);
            },
            onError: (err, job) => {
                this.logger.error(`[Shipping Worker Error] Job: ${job?.id}`, err);
            },
        });
        this.worker.run();
    }

    private async processShippingJob(payload: any) {
        const { type, me, orderId, provider, dto } = payload;

        switch (type) {
            case ShippingJobType.CREATE:
                // We call a specific internal method that handles the API call
                // and DB updates without the risk of request timeout.
                await this.shippingService.createShipment(
                    me,
                    provider,
                    dto,
                    orderId
                );
                break;

            case ShippingJobType.CANCEL:
                // Future scalability: await this.shippingService.executeCancel(...)
                break;

            default:
                this.logger.warn(`Unknown shipping job type: ${type}`);
        }
    }

    onModuleDestroy() {
        this.worker?.close();
    }
}