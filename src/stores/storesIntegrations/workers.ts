
import { Repository } from "typeorm";
import { InjectRepository } from "@nestjs/typeorm";
import { storeSyncQueue } from "./queues";
import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";
import { BundleEntity } from "entities/bundle.entity";
import { OrderEntity } from "entities/order.entity";
import { IBundleSyncProvider } from "./BaseStoreProvider";
import { StoreEntity, StoreProvider } from "entities/stores.entity";
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { Worker, Queue, ReservedJob } from "groupmq";
import { ShopifyService } from "./ShopifyService";
import { EasyOrderService } from "./EasyOrderService";
import { BaseStoreProvider } from "./BaseStoreProvider";
import WooCommerceService from "./WooCommerce";
import { StoresService } from "../stores.service";
import { RedisService } from "common/redis/RedisService";
import { ProductSyncStateEntity } from "entities/product_sync_error.entity";


@Injectable()
export class StoreWorkerService implements OnModuleInit, OnModuleDestroy {
    protected readonly logger = new Logger(this.constructor.name);
    private worker: Worker;


    constructor(
        private readonly shopifyService: ShopifyService,
        private readonly redisService: RedisService,
        private readonly easyOrderService: EasyOrderService,
        private readonly woocommerceService: WooCommerceService,
        private readonly storesService: StoresService, // StoresService injected for retry handler

        @InjectRepository(StoreEntity)
        private readonly storesRepo: Repository<StoreEntity>,
        @InjectRepository(ProductEntity)
        private readonly prodRepo: Repository<ProductEntity>,
        @InjectRepository(BundleEntity)
        private readonly bundleRepo: Repository<BundleEntity>,

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

    async onModuleInit() {
        this.logger.log(`Starting Worker for Queue: [${storeSyncQueue.name || 'unknown'}] with concurrency: ${150}`);
        const namespace = storeSyncQueue.namespace || 'groupmq';
        const deleted = await this.redisService.clearQueueRecoveryKeys(namespace, storeSyncQueue.redis);

        if (deleted > 0) {
            this.logger.warn(`[Recovery] Cleared ${deleted} orphaned locks for ${namespace}`);
        }
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
    protected getErrorMessage(error: any): string {
        return error?.response?.data?.message || error?.response?.message || error?.message || 'Unknown error';
    }

    protected async processJob(payload: any): Promise<void> {
        const { type, storeType, storeId, newStatusId, productId, bundleId, category, slug, orderId } = payload;

        try {
            // 1. Resolve which service to use
            const service = this.getService(storeType);

            switch (type) {
                case "sync-category":
                    // [2025-12-24] Ensure slug/title is trimmed inside the specific service
                    await service.syncCategory({ category, slug });
                    this.logger.log(`[Category Sync] Provider: ${storeType} | Job: ${type} | Successfully processed: ${category?.trim()}`);
                    break;

                case "sync-product":
                    const product = await this.prodRepo.findOne({
                        where: { id: productId },
                        relations: ['category', 'store']
                    });

                    if (!product || !product.isActive) return;

                    // All services share this method signature via BaseStoreProvider
                    await service.syncProduct({ productId });
                    this.logger.log(`[Product Sync] Provider: ${storeType} | Job: ${type} | Successfully processed: ${productId}`);
                    break;

                case "sync-bundle":
                    const bundle = await this.bundleRepo.findOne({
                        where: { id: bundleId },
                        relations: ['variant', 'variant.product', 'items', 'items.variant', 'items.variant.product']
                    });
                    if (!bundle || !bundle.isActive) return;

                    // Ensure syncBundle is called if the service supports it
                    if ('syncBundle' in service) {
                        await (service as IBundleSyncProvider).syncBundle(bundle);
                        this.logger.log(`[Bundle Sync] Provider: ${storeType} | Job: ${type} | Successfully processed: ${bundleId}`);
                    }
                    break;

                case "sync-order-status":
                    const order = await this.orderRepo.findOne({
                        where: {
                            id: orderId,
                        },
                    });
                    if (order) {
                        await service.syncOrderStatus(order, newStatusId);
                        this.logger.log(`[Order Status Sync] Provider: ${storeType} | Job: ${type} | Successfully processed: ${orderId}`);
                    }
                    break;

                case "sync-full-store":
                    const store = await this.storesRepo.findOneBy({ id: storeId });
                    if (store) {
                        await service.syncFullStore(store);
                        this.logger.log(`[Full Store Sync] Provider: ${storeType} | Job: ${type} | Successfully processed: ${storeId}`);
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
        } catch (error: any) {
            const message = this.getErrorMessage(error);
            const stack = error instanceof Error ? error.stack : 'No stack trace available';

            // Passing stack as the second argument ensures it's formatted correctly by the logger
            this.logger.error(
                `[Worker Error] Provider: ${storeType} | Job: ${type} | ${message}`,
                stack
            );
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