import { Queue } from "groupmq";
import Redis from "ioredis";
import { Injectable } from "@nestjs/common";
import { ProviderCode } from "../providers/shipping-provider.interface";
import { BulkAssignOrderDto } from "../shipping.dto";
import { tenantId } from "src/category/category.service";

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const redis = new Redis(redisUrl);

export enum ShippingJobType {
    CREATE = "create-shipment",
    CANCEL = "cancel-shipment",
    TRACK = "track-update"
}

export const shippingQueue = new Queue({
    redis,
    namespace: "shipping-tasks",
    jobTimeoutMs: 60000, // 1 minute per shipment API call
    maxAttempts: 1,
    autoBatch: {
        maxWaitMs: 50,
        size: 5,
    }
});

@Injectable()
export class ShippingQueueService {
    private getBusyKey(orderId: string | string) {
        if (!orderId) return null;
        return `shipping:busy:${orderId}`;
    }
    async attachIsAssigningState(records: any[]): Promise<void> {
        if (!records || records.length === 0) return;

        const prefix = "groupmq:shipping-tasks:job:shipping:busy:";
        const keys = records.map(o => `${prefix}${o.id || o.orderId}`);

        try {
            // 1. Create a Redis pipeline
            const pipeline = shippingQueue.redis.pipeline();

            // 2. Queue up an 'exists' check for every key
            keys.forEach(key => pipeline.exists(key));

            // 3. Execute the pipeline all at once
            // ioredis exec() returns an array of tuples: [[error, result], [error, result]]
            const results = await pipeline.exec();

            // 4. Map the results back to the records
            records.forEach((order, index) => {
                // results[index][1] is the actual result of the EXISTS command (1 = true, 0 = false)
                const exists = results && results[index] && results[index][1] === 1;
                (order as any).isAssigning = exists;
            });

        } catch (error) {
            console.error("Redis Pipeline failed in attachIsAssigningState:", error);
            // Fallback: set all to false so the UI doesn't break
            records.forEach(o => (o as any).isAssigning = false);
        }
    }

    async enqueueShippingTask(
        me: any,
        type: ShippingJobType,
        data: any
    ) {
        const { orderId } = data;
        const adminId = tenantId(me)
        return await shippingQueue.add({
            groupId: `shipping:admin:${adminId}`, // Sequential per admin
            data: {
                ...data,
                type,
                me,
            },
            orderMs: Date.now(),
            jobId: this.getBusyKey(orderId),
        });
    }


    async enqueueBulkShippingTasks(
        me: any,
        provider: ProviderCode,
        dto: BulkAssignOrderDto
    ) {
        const { items } = dto;

        // Process all items in parallel to minimize API latency
        const enqueuePromises = items.map((item) => {
            const { orderId, ...individualDto } = item;

            return this.enqueueShippingTask(
                me,
                ShippingJobType.CREATE,
                {
                    provider,
                    orderId,
                    dto: individualDto // Specific details for this specific order
                }
            );
        });

        await Promise.all(enqueuePromises);
        return {
            success: true,
            message: `Successfully enqueued ${items.length} unique shipping tasks.`,
            count: items.length
        };
    }
}