import { Queue } from "groupmq";
import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const redis = new Redis(redisUrl);

export const autoAssignmentQueue = new Queue({
    redis,
    namespace: "auto-assignment",
    jobTimeoutMs: 600000, // 10 minutes
    maxAttempts: 3,
    autoBatch: {
        maxWaitMs: 500, // batch jobs arriving within 500ms
        size: 50,       // up to 50 orders at once
    }
});
