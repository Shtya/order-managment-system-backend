
import { Repository } from "typeorm";
import { InjectRepository } from "@nestjs/typeorm";
import { storeSyncQueue } from "./queues";
import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";
import { OrderEntity } from "entities/order.entity";
import { StoreEntity, StoreProvider } from "entities/stores.entity";
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { Worker, Queue, ReservedJob } from "groupmq";
import { ShopifyService } from "./ShopifyService";
import { EasyOrderService } from "./EasyOrderService";
import { BaseStoreProvider } from "./BaseStoreProvider";
import { WooCommerceService } from "./WooCommerce";
import { StoresService } from "../stores.service";


@Injectable()
export class StoreWorkerService implements OnModuleInit, OnModuleDestroy {
    protected readonly logger = new Logger(this.constructor.name);
    private worker: Worker;


    constructor(
        private readonly shopifyService: ShopifyService,
        private readonly easyOrderService: EasyOrderService,
        private readonly woocommerceService: WooCommerceService,
        private readonly storesService: StoresService, // StoresService injected for retry handler

        @InjectRepository(StoreEntity)
        private readonly storesRepo: Repository<StoreEntity>,
        @InjectRepository(ProductEntity)
        private readonly prodRepo: Repository<ProductEntity>,
        @InjectRepository(ProductVariantEntity)
        private readonly pvRepo: Repository<ProductVariantEntity>,
        @InjectRepository(OrderEntity)
        private readonly orderRepo: Repository<OrderEntity>,
    ) {

    }

    /**
     * Private Strategy Selector
     * Returns the service instance based on the provider
     */
    private getService(provider: string | StoreProvider): BaseStoreProvider {
        switch (provider) {
            case StoreProvider.SHOPIFY:
                return this.shopifyService;
            case StoreProvider.EASYORDER:
                return this.easyOrderService;
            case StoreProvider.WOOCOMMERCE:
                return this.woocommerceService;
            default:
                throw new Error(`Unsupported Store Provider: ${provider}`);
        }
    }

    // workers.ts

    private async cleanupStalledLocks() {
        try {
            const redis = storeSyncQueue.redis;
            const namespace = storeSyncQueue.namespace || 'groupmq';

            // We need to clean Group locks, Processing locks, and Unique locks
            const patterns = [
                `${namespace}:g:*:active`,    // Group locks (Sequential blocking)
                `${namespace}:processing:*`,  // Job-level active markers
                `${namespace}:unique:*`       // Duplicate prevention markers
            ];

            let totalDeleted = 0;

            for (const pattern of patterns) {
                let cursor = '0';
                this.logger.log(`[Recovery] Scanning: ${pattern}`);

                do {
                    const [newCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
                    cursor = newCursor;

                    if (keys.length > 0) {
                        await redis.del(...keys);
                        totalDeleted += keys.length;
                    }
                } while (cursor !== '0');
            }

            if (totalDeleted > 0) {
                this.logger.warn(`[Recovery] ✓ Cleared ${totalDeleted} orphaned locks/markers.`);
            }
        } catch (error) {
            this.logger.error("[Recovery] ✗ Failed to cleanup stalled locks:", error);
        }
    }

    async onModuleInit() {
        this.logger.log(`Starting Worker for Queue: [${storeSyncQueue.name || 'unknown'}] with concurrency: ${150}`);
        await this.cleanupStalledLocks();
        this.worker = new Worker({
            queue: storeSyncQueue,
            concurrency: 4,
            maxAttempts: 3, // Default to 0 retries for API calls
            blockingTimeoutSec: 10,
            stalledInterval: 30000,
            maxStalledCount: 1,          // Fail after 1 stall
            stalledGracePeriod: 0,

            // 2. The logic wrapper
            handler: async (job: ReservedJob) => {
                this.logger.debug(`Processing Job ${job.id} | Group: ${job.groupId}`);
                return this.processJob(job.data);
            },

            // 3. Error Hook
            onError: (err, job) => {
                this.logger.error(
                    `[Worker Error] Queue: ${storeSyncQueue.name} | Job: ${job?.id} | Group: ${job?.groupId}`,
                    err instanceof Error ? err.stack : err
                );
            },
        });

        this.worker.on('stalled', (jobId, groupId) => {
            console.warn(`Job ${jobId} from group ${groupId} was stalled`)

            this.logger.warn(`Job ${jobId} from group ${groupId} was stalled`);

            // Note: Job has already been recovered automatically
        })

        this.worker.run();
    }

    protected async processJob(payload: any): Promise<void> {
        const { type, storeType, storeId, productId, category, slug, orderId } = payload;

        try {
            // 1. Resolve which service to use
            const service = this.getService(storeType);

            switch (type) {
                case "sync-category":
                    // [2025-12-24] Ensure slug/title is trimmed inside the specific service
                    await service.syncCategory({ category, slug });
                    break;

                case "sync-product":
                    const product = await this.prodRepo.findOne({
                        where: { id: productId },
                        relations: ['category', 'store']
                    });
                    if (!product) return;

                    const variants = await this.pvRepo.find({ where: { productId: product.id } });

                    // All services share this method signature via BaseStoreProvider
                    await service.syncProduct({ product, variants, slug });
                    break;

                case "sync-order-status":
                    const order = await this.orderRepo.findOne({
                        where: {
                            id: orderId,
                        },
                        relations: ['status']
                    });
                    if (order) {
                        await service.syncOrderStatus(order);
                    }
                    break;

                case "sync-full-store":
                    const store = await this.storesRepo.findOneBy({ id: storeId });
                    if (store) {
                        await service.syncFullStore(store);
                    }
                    break;


                case "retry-failed-order":
                    const { failureId, adminId } = payload;
                    if (failureId && adminId) {
                        const mockUser = { id: adminId, role: { name: 'admin' } };
                        const result = await this.storesService.retryFailedOrder(mockUser, failureId);
                        this.logger.log(`[Retry Failed Order] Processed failureId=${failureId}, result=${JSON.stringify(result)}`);
                    }
                    break;

                default:
                    this.logger.warn(`Unknown job type: ${type} for provider: ${storeType}`);
            }
        } catch (error) {
            this.logger.error(`[Worker Error] Provider: ${storeType} | Job: ${type} | ${error.message}`);
            // Catching here prevents the worker from crashing or getting stuck
        }
    }

    /**
    * NestJS Lifecycle: Stops the worker cleanly when the app shuts down
    */
    onModuleDestroy() {
        this.logger.log("Stopping Worker...");
        this.worker?.close();
    }
}