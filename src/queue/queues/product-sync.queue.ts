import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { ProductSyncJobs, QueueNames } from "../common/queue.constants";
import { Job, JobsOptions, MetricsTime, Queue } from "bullmq";
import { CategoryEntity } from "entities/categories.entity";
import { StoreEntity, StoreProvider } from "entities/stores.entity";
import { oldBundleDataDto } from "src/stores/storesIntegrations/BaseStoreProvider";
import { StoresService } from "src/stores/stores.service";
import { QueueDelayConfig, QueueDelayService } from "../common/queue-delay.service";



@Injectable()
export class ProductSyncQueueService {
    private productSyncTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private bundleSyncTimeouts: Map<string, NodeJS.Timeout> = new Map();

    constructor(
        @InjectQueue(QueueNames.PRODUCT_SYNC)
        private readonly productSyncQueue: Queue,
    ) { }

    private async addJob(
        adminId: string,
        type: string,
        storeType: StoreProvider,
        data: any,
        options: JobsOptions = {},
    ) {
        if (!adminId) return;

        return await this.productSyncQueue.add(
            type,
            {
                ...data,
                type,
                storeType,
                adminId,
            },
            {
                // jobId: options.jobId,
                ...options,
                jobId: undefined,
            }
        );
    }

    async enqueueCategorySync(
        category: CategoryEntity,
        storeId: string,
        storeType: StoreProvider,
        slug?: string,
    ) {
        const cleanSlug = slug?.trim();
        await this.addJob(category.adminId, ProductSyncJobs.SYNC_CATEGORY, storeType, {
            category,
            storeId,
            slug: cleanSlug,
        }, {
            priority: 1
        });
    }

    async enqueueProductSync(productId: string, adminId: string, storeId: string, storeType: StoreProvider) {
        const jobId = `product:${storeType}:${productId}`;

        if (this.productSyncTimeouts.has(jobId)) {
            clearTimeout(this.productSyncTimeouts.get(jobId));
        }

        const timeout = setTimeout(async () => {
            try {
                this.productSyncTimeouts.delete(jobId);

                await this.addJob(adminId, ProductSyncJobs.SYNC_PRODUCT, storeType, {
                    productId,
                    storeId,
                }, {
                    jobId,
                    priority: 2
                });
            } catch (err: any) {
                console.error(`Failed to add product sync job: ${err.message}`);
            }
        }, 3000);

        this.productSyncTimeouts.set(jobId, timeout);
    }

    async enqueueBundleSync(bundleId: string, adminId: string, storeId: string, storeType: StoreProvider, oldBundleData: oldBundleDataDto) {
        const jobId = `bundle:${storeType}:${bundleId}`;

        if (this.bundleSyncTimeouts.has(jobId)) {
            clearTimeout(this.bundleSyncTimeouts.get(jobId));
        }

        const timeout = setTimeout(async () => {
            try {
                this.bundleSyncTimeouts.delete(jobId);

                await this.addJob(adminId, ProductSyncJobs.SYNC_BUNDLE, storeType, {
                    bundleId,
                    storeId,
                    oldBundleData
                }, {
                    jobId,
                    priority: 3
                });
            } catch (err: any) {
                console.error(`Failed to add bundle sync job: ${err.message}`);
            }
        }, 3000);

        this.bundleSyncTimeouts.set(jobId, timeout);
    }

    async enqueueFullStoreSync(store: StoreEntity, productIds?: string[]) {
        const jobId = `fullSync:${store.provider}:${store.id}`;
        await this.addJob(store.adminId, ProductSyncJobs.FULL_SYNC, store.provider, {
            storeId: store.id,
            productIds,
        }, { jobId, priority: 4 });
    }

    async enqueueFullProductSyncLocally(adminId: string, provider: StoreProvider) {
        const jobId = `syncProductsLocally:${provider}:${adminId}`;
        await this.addJob(adminId, ProductSyncJobs.SYNC_LOCAL, provider, {}, { jobId, priority: 5 });
    }
}

@Processor(QueueNames.PRODUCT_SYNC, {
    concurrency: 20,
    maxStartedAttempts: 200,
    metrics: {
        maxDataPoints: MetricsTime.ONE_WEEK * 2, 
    },
})
export class ProductSyncWorkerService extends WorkerHost {
    private readonly logger = new Logger(ProductSyncWorkerService.name);
    private readonly queueConfig: Partial<QueueDelayConfig> = {
        keyPrefix: 'product-sync',  // ← unique to this worker
        maxPerUser: 2,              // ← 1 product sync per store at a time
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
        // storeId is the "user" here — one sync per store at a time
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

        const result = await this.storesService.processProductSyncJob(job.data);
        return result;
    }
}
