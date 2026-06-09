import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { Worker, ReservedJob } from "groupmq";
import { autoAssignmentQueue } from "./queues";
import { OrderAssignmentService } from "./order-assignment.service";
import { RedisService } from "common/redis/RedisService";
import Redis from "ioredis";

@Injectable()
export class AssignmentWorkerService implements OnModuleInit, OnModuleDestroy {
    protected readonly logger = new Logger(this.constructor.name);
    private worker: Worker;

    constructor(
        private readonly orderAssignmentService: OrderAssignmentService,
        private readonly redisService: RedisService,
    ) { }

    async onModuleInit() {
        this.logger.log(`Starting Worker for Queue: [${autoAssignmentQueue.namespace}]`);

        const namespace = autoAssignmentQueue.namespace || 'auto-assignment';
        const redis = (autoAssignmentQueue as any).redis as Redis;

        if (redis) {
            const deleted = await this.redisService.clearQueueRecoveryKeys(namespace, redis);
            if (deleted > 0) {
                this.logger.warn(`[Recovery] Cleared ${deleted} orphaned locks for ${namespace}`);
            }
        }

        this.worker = new Worker({
            queue: autoAssignmentQueue,
            concurrency: 10, // process up to 10 admins in parallel
            maxAttempts: 3,
            blockingTimeoutSec: 10,
            handler: async (job: ReservedJob) => {
                const { adminId, orderIds } = job.data;
                this.logger.debug(`Processing Assignment Job for Admin: ${adminId} | Orders: ${orderIds?.length}`);

                try {
                    await this.orderAssignmentService.processAutoAssignment(adminId, orderIds);
                } catch (err) {
                    this.logger.error(`Failed to process auto-assignment for admin ${adminId}`, err);
                    throw err; // retry if allowed
                }
            },
            onError: (err, job) => {
                this.logger.error(
                    `[Assignment Worker Error] Job: ${job?.id} | Group: ${job?.groupId}`,
                    err instanceof Error ? err.stack : err
                );
            },
        });

        this.worker.run();
    }

    onModuleDestroy() {
        this.logger.log("Stopping Assignment Worker...");
        this.worker?.close();
    }
}
