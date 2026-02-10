import { Queue } from "groupmq";
import Redis from "ioredis";
import { Injectable } from "@nestjs/common";
import { CategoryEntity } from "entities/categories.entity";
import { ProductEntity } from "entities/sku.entity";
import { OrderEntity } from "entities/order.entity";
import { StoreEntity } from "entities/stores.entity";



const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const redis = new Redis(redisUrl);

export const easyOrderQueue = new Queue({
    redis,
    namespace: "easyorder", // prefix keys in Redis
    jobTimeoutMs: 30_000,   // optional timeout
    maxAttempts: 0,         // max 1 retry per job
});


@Injectable()
export class EasyOrderQueueService {
    async enqueueCategorySync(
        category: CategoryEntity,
        storeId: number,
        slug?: string
    ) {
        const adminId = category.adminId;
        if (!adminId) return;

        // GroupMQ automatically serializes jobs within this groupId
        await easyOrderQueue.add({
            groupId: `admin:${adminId}`, // THIS is the "Virtual Queue" per admin
            data: {
                type: "sync-category",
                category: category,
                storeId,
                slug,
                adminId
            },
            orderMs: Date.now(),
            maxAttempts: 0,
        });
    }


    async enqueueProductSync(
        productId: number,
        adminId: string,
        storeId: number,
        slug?: string,
    ) {

        if (!adminId) return;
        const jobId = `product:${productId}`
        await easyOrderQueue.remove(jobId);

        await easyOrderQueue.add({
            groupId: `admin:${adminId}`,
            data: {
                type: "sync-product",
                productId,
                storeId,
                slug,
                adminId
            },
            orderMs: Date.now(),
            delay: 3000,
            maxAttempts: 0,
            jobId
        });

    }


    async enqueueOrderStatusSync(
        order: OrderEntity,
        storeId: number,
    ) {
        const adminId = order.adminId;
        if (!adminId) return;

        await easyOrderQueue.add({
            groupId: `admin:${adminId}`,
            data: {
                type: "sync-order-status",
                orderId: order.id,
                storeId,
                adminId
            },
            orderMs: Date.now(),
            maxAttempts: 0,
        });
    }

    async enqueueFullStoreSync(store: StoreEntity) {
        const adminId = store.adminId;
        if (!adminId) return;
        const jobId = `syncFullStore`
        await easyOrderQueue.add({
            groupId: `admin:${adminId}`,
            data: {
                type: "sync-full-store",
                storeId: store.id,
                adminId
            },
            orderMs: Date.now(),
            maxAttempts: 0,
            jobId
        });
    }
}