import { Queue } from "groupmq";
import Redis from "ioredis";
import { Injectable } from "@nestjs/common";
import { CategoryEntity } from "entities/categories.entity";
import { ProductEntity } from "entities/sku.entity";
import { OrderEntity } from "entities/order.entity";
import { StoreEntity, StoreProvider } from "entities/stores.entity";



const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const redis = new Redis(redisUrl);

export const storeSyncQueue = new Queue({
    redis,
    namespace: "store-sync", // prefix keys in Redis
    jobTimeoutMs: 300000,   // optional timeout 5m
    maxAttempts: 3,         // max 1 retry per job
    autoBatch: {
        maxWaitMs: 100, // wait up to 100ms to batch jobs
        size: 10,    // batch up to 10 jobs together
    }
});


@Injectable()
export class StoreQueueService {
    // Map to track timeouts for product sync jobs
    private productSyncTimeouts: Map<string, NodeJS.Timeout> = new Map();

    private async addJob(adminId: string, type: string, storeType: StoreProvider, data: any, options: any = {}) {
        if (!adminId) return;

        const groupId = options.groupId ?? `admin:${adminId}`;
        return await storeSyncQueue.add({
            groupId,
            data: {
                ...data,
                type,
                storeType,
                adminId,
            },
            orderMs: Date.now(),
            maxAttempts: options.maxAttempts ?? 3,
            jobId: options.jobId,
        });
    }

    async enqueueCategorySync(category: CategoryEntity, storeId: number, storeType: StoreProvider, slug?: string) {

        const cleanSlug = slug?.trim();
        await this.addJob(category.adminId, "sync-category", storeType, {
            category,
            storeId,
            slug: cleanSlug,
        });
    }

    /** Product sync uses its own group (admin:${adminId}:product) so it is not blocked by full-store sync or other admin jobs. */
    // queues.ts

    async enqueueProductSync(productId: number, adminId: string, storeId: number, storeType: StoreProvider, slug?: string) {
        const jobId = `product:${storeType}:${productId}`;
        const cleanSlug = slug?.trim(); // [2025-12-24] Trim slug

        // STOP: Don't call storeSyncQueue.remove(jobId) here. 
        // If it's active, remove() will break the group lock.

        if (this.productSyncTimeouts.has(jobId)) {
            clearTimeout(this.productSyncTimeouts.get(jobId));
        }

        const timeout = setTimeout(async () => {
            try {
                this.productSyncTimeouts.delete(jobId);

                await this.addJob(adminId, "sync-product", storeType, {
                    productId,
                    storeId,
                    slug: cleanSlug,
                }, {
                    jobId,
                    groupId: `admin:${adminId}:product`, // Using a specific sub-group
                    maxAttempts: 3
                });
            } catch (err) {
                console.error(`Failed to add job: ${err.message}`);
            }
        }, 3000);

        this.productSyncTimeouts.set(jobId, timeout);
    }

    async enqueueOrderStatusSync(order: OrderEntity, storeId: number, storeType: StoreProvider) {
        await this.addJob(order.adminId, "sync-order-status", storeType, {
            orderId: order.id,
            storeId,
        });
    }

    async enqueueFullStoreSync(store: StoreEntity) {
        const jobId = `fullSync:${store.provider}:${store.id}`;
        await this.addJob(store.adminId, "sync-full-store", store.provider, {
            storeId: store.id,
        }, { jobId });
    }

    async enqueueRetryFailedOrder(adminId: string, failureId: number, provider: StoreProvider) {
        const jobId = `retry-failed-order:${failureId}`;
        await this.addJob(adminId, "retry-failed-order", provider, {
            failureId,
        }, { jobId });
    }
}