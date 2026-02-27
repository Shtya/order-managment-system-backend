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
    jobTimeoutMs: 300_000,   // optional timeout 5m
    maxAttempts: 0,         // max 1 retry per job
});


@Injectable()
export class StoreQueueService {
    //
    private async addJob(adminId: string, type: string, storeType: StoreProvider, data: any, options: any = {}) {
        if (!adminId) return;

        return await storeSyncQueue.add({
            groupId: `admin:${adminId}`,
            data: {
                ...data,
                type,
                storeType,
                adminId,
            },
            orderMs: Date.now(),
            maxAttempts: options.maxAttempts ?? 0,
            jobId: options.jobId,
            delay: options.delay,
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

    async enqueueProductSync(productId: number, adminId: string, storeId: number, storeType: StoreProvider, slug?: string) {
        const jobId = `product:${storeType}:${productId}`;
        await storeSyncQueue.remove(jobId);

        await this.addJob(adminId, "sync-product", storeType, {
            productId,
            storeId,
            slug: slug?.trim(),
        }, { jobId, delay: 3000 });
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