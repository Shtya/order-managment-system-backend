
import { EasyOrderService } from "./EasyOrderService";
import { CategoryEntity } from "entities/categories.entity";
import { Repository } from "typeorm";
import { InjectRepository } from "@nestjs/typeorm";
import { easyOrderQueue } from "./queues";
import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";
import { OrderEntity } from "entities/order.entity";
import { StoreEntity } from "entities/stores.entity";
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { Worker, Queue, BackoffStrategy, ReservedJob } from "groupmq";



export interface WorkerConfig {
    concurrency?: number;
    maxAttempts?: number;
    blockingTimeoutSec?: number; // Useful for keeping the Redis connection active
}
@Injectable()
export abstract class BaseWorkerService<T = any> implements OnModuleInit, OnModuleDestroy {
    // Dynamic logger that uses the Child Class name (e.g. "EasyOrderWorkerService")
    protected readonly logger = new Logger(this.constructor.name);
    private worker: Worker;

    constructor(
        private readonly queue: Queue,
        private readonly config: WorkerConfig = {}
    ) { }

    /**
     * NestJS Lifecycle: Starts the worker automatically when the app starts
     */
    async onModuleInit() {
        this.logger.log(`Starting Worker for Queue: [${this.queue.name || 'unknown'}] with concurrency: ${this.config.concurrency || 50}`);
        await this.cleanupStalledLocks();
        this.worker = new Worker({
            queue: this.queue,
            concurrency: this.config.concurrency ?? 50,
            maxAttempts: this.config.maxAttempts ?? 0, // Default to 0 retries for API calls
            blockingTimeoutSec: this.config.blockingTimeoutSec ?? 5,


            // 2. The logic wrapper
            handler: async (job: ReservedJob<T>) => {
                this.logger.debug(`Processing Job ${job.id} | Group: ${job.groupId}`);
                return this.processJob(job.data, job.groupId);
            },

            // 3. Error Hook
            onError: (err, job) => {
                this.logger.error(
                    `[Worker Error] Queue: ${this.queue.name} | Job: ${job?.id} | Group: ${job?.groupId}`,
                    err instanceof Error ? err.stack : err
                );
            },
        });

        this.worker.run();
    }

    //Clean locked jobs at redis
    private async cleanupStalledLocks() {
        try {
            const redis = (this.queue as any).redis;
            const namespace = (this.queue as any).namespace || 'groupmq';

            const pattern = `${namespace}:g:*:active`;

            this.logger.log(`Scanning for stalled locks with pattern: ${pattern}`);

            let cursor = '0';
            let deletedCount = 0;

            do {
                const [newCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
                cursor = newCursor;

                if (keys.length > 0) {
                    await redis.del(...keys);
                    deletedCount += keys.length;
                }
            } while (cursor !== '0');

            if (deletedCount > 0) {
                this.logger.warn(`Successfully cleared ${deletedCount} stalled group locks.`);
            }
        } catch (error) {
            this.logger.error("Failed to cleanup stalled locks:", error);
        }
    }

    /**
     * NestJS Lifecycle: Stops the worker cleanly when the app shuts down
     */
    onModuleDestroy() {
        this.logger.log("Stopping Worker...");
        this.worker?.close();
    }

    /**
     * ABSTRACT METHOD: The Child must implement this.
     * This is where your specific logic (syncCategory, etc.) goes.
     */
    protected abstract processJob(payload: any, groupId: string): Promise<void>;
}

@Injectable()
export class EasyOrderWorkerService extends BaseWorkerService {
    constructor(
        private readonly easyOrderService: EasyOrderService,

        @InjectRepository(ProductEntity)
        private prodRepo: Repository<ProductEntity>,

        @InjectRepository(ProductVariantEntity)
        private pvRepo: Repository<ProductVariantEntity>,

        @InjectRepository(OrderEntity)
        private orderRepo: Repository<OrderEntity>,
        @InjectRepository(StoreEntity)
        private storesRepo: Repository<StoreEntity>,
    ) {
        super(easyOrderQueue, {
            concurrency: 100, // Handle 100 parallel admin groups
            blockingTimeoutSec: 10, // Wait 10s for new jobs before reconnecting
        });
    }

    /**
     * NestJS Lifecycle: Recovery on app startup
     * Overrides parent onModuleInit to add recovery logic
     */
    async onModuleInit() {
        this.logger.log(`Starting EasyOrder Worker Service...`);

        // Recovery: Clean up any stores stuck in SYNCING status from previous crashes
        const recoveredCount = await this.easyOrderService.recoverStuckSyncs();
        if (recoveredCount > 0) {
            this.logger.warn(`[Startup] Recovered ${recoveredCount} store(s) from crashed sync`);
        }

        // Then start the parent worker
        await super.onModuleInit();
    }

    protected async processJob(payload: any, groupId): Promise<void> {
        try {
            const { type, productId, storeId, category, slug } = payload;

            switch (type) {
                case "sync-category":
                    await this.easyOrderService.syncCategory({ category, slug });
                    break;

                case "sync-product":
                    // 1. Fetch Full Product with Relations
                    const product = await this.prodRepo.findOne({
                        where: { id: productId },
                        relations: ['category', 'store']
                    });

                    if (!product) return;

                    // 2. Fetch Variants
                    const variants = await this.pvRepo.find({ where: { productId: product.id } });

                    // 3. Sync
                    await this.easyOrderService.syncProduct({ product, variants, slug });
                    break;

                case "sync-order-status":
                    // update remote status
                    const order = await this.orderRepo.findOneBy({ id: payload.orderId });
                    if (order) {
                        await this.easyOrderService.syncOrderStatus(order);
                    }
                    break;

                case "sync-full-store":
                    const store = await this.storesRepo.findOneBy({ id: storeId });
                    if (store) {
                        await this.easyOrderService.syncFullStore(store);
                    }
                    break;

                default:
                    this.logger.warn(`Unknown job type: ${type}`);
            }


        }
        catch (error) {
            this.logger.error(`[Job Error] Group: ${groupId} | Type: ${payload?.type} | ${error?.message}`);
            // We do NOT re-throw
            return;
        }

    }
}