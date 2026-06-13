import {
    Inject,
    Injectable,
    OnModuleDestroy,
    OnModuleInit,
    Logger,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import RedisClass from "ioredis";
import * as Redis from 'ioredis';
import redisConfig from './redis.config';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RedisService.name);

    // This will be our Redis client instance, accessible throughout the service
    public redisClient: Redis.Redis;

    constructor(
        @Inject(redisConfig.KEY)
        // We're injecting the Redis config from our config file
        private readonly redisConfiguration: ConfigType<typeof redisConfig>,
    ) { }

    onModuleInit() {
        // This is where we build the configuration object for Redis
        const config = {
            host: this.redisConfiguration.host,
            port: this.redisConfiguration.port,
            // username: this.redisConfiguration.username,
            // password: this.redisConfiguration.password,
            // url: this.redisConfiguration.url,
            retryDelayOnFailover: 100, // Retry delay when failover happens
            enableReadyCheck: true,    // Ensures Redis is ready before proceeding
            maxRetriesPerRequest: 3,   // Limits retry attempts to avoid hanging,
            retryStrategy: (times) => {
                // Delay starts at 50ms, then 100ms, 200ms... up to 3000ms (3 seconds)
                const delay = Math.min(times * 50, 3000);

                // Only log a warning on the first attempt or every 20th attempt to reduce noise
                if (times === 1 || times % 20 === 0) {
                    this.logger.warn(`Redis disconnected. Retrying attempt #${times} in ${delay}ms...`);
                }

                return delay;
            },
        };

        this.logger.log('Connecting to Redis...', config);

        // Initialize the Redis client
        this.redisClient = new Redis.Redis(config);

        // Log when connected
        this.redisClient.on('connect', () => {
            this.logger.log('Redis client connected successfully');
        });

        // Log errors during connection or operation
        this.redisClient.on('error', (error: any) => {
            // These errors are common during disconnection/reconnection cycles.
            // We ignore them because 'retryStrategy' is already handling the situation.
            const isConnectionNoise =
                error.code === 'ECONNRESET' ||
                error.code === 'ECONNREFUSED' ||
                (error.message && error.message.includes('AggregateError'));

            if (!isConnectionNoise) {
                // Only log genuine, unexpected application errors
                this.logger.error('Redis client error:', error);
            }
        });
    }

    onModuleDestroy() {
        // Properly close the Redis connection when the app shuts down
        this.redisClient.quit();
        this.logger.log('Redis connection closed');
    }

    /**
     * Set a value in Redis under the given key.
     * If the value is an object, we convert it to a JSON string before saving.
     * Supports optional TTL (in seconds).
     */
    async set(key: string, value: any, ttl?: number): Promise<string> {
        try {
            const stringValue =
                typeof value === 'object' ? JSON.stringify(value) : String(value);

            if (ttl) {
                // Equivalent to: SET key value EX ttl
                return await this.redisClient.set(key, stringValue, 'EX', ttl);
            }

            return await this.redisClient.set(key, stringValue);
        } catch (error) {
            this.logger.error(`Error setting key "${key}":`, error);
            throw error;
        }
    }


    /**
     * Get a value from Redis.
     * Automatically parses JSON if possible.
     */
    async get<T = any>(key: string): Promise<T | string | null> {
        try {
            const value = await this.redisClient.get(key);
            if (!value) return null;

            try {
                return JSON.parse(value);
            } catch {
                return value;
            }
        } catch (error) {
            this.logger.error(`Error getting key "${key}":`, error);
            return null;
        }
    }

    /**
     * Delete a key from Redis.
     */
    async del(key: string): Promise<number> {
        try {
            return await this.redisClient.del(key);
        } catch (error) {
            this.logger.error(`Error deleting key "${key}":`, error);
            throw error;
        }
    }

    /**
     * Check if a key exists.
     */
    async exists(key: string): Promise<boolean> {
        try {
            const result = await this.redisClient.exists(key);
            return result === 1;
        } catch (error) {
            this.logger.error(`Error checking existence of key "${key}":`, error);
            return false;
        }
    }

    /**
     * Set expiration time (TTL) for a key.
     */
    async expire(key: string, ttl: number): Promise<boolean> {
        try {
            const result = await this.redisClient.expire(key, ttl);
            return result === 1;
        } catch (error) {
            this.logger.error(`Error setting TTL for key "${key}":`, error);
            return false;
        }
    }

    /**
     * Get TTL (time-to-live) of a key.
     */
    async ttl(key: string): Promise<number> {
        try {
            return await this.redisClient.ttl(key);
        } catch (error) {
            this.logger.error(`Error getting TTL for key "${key}":`, error);
            return -2; // -2 means key does not exist
        }
    }

    async setNx(key: string, value: string): Promise<boolean> {
        try {
            // This uses the overload: set(key, value, nx: "NX")
            const result = await this.redisClient.set(key, value, "NX");
            return result === "OK"; // "OK" if set, null if key already exists
        } catch (error) {
            this.logger.error(`Error acquiring lock for key "${key}":`, error);
            return false;
        }
    }

    async setNxWithTtl(key: string, value: string, ttlSeconds: number): Promise<boolean> {
        try {
            const result = await this.redisClient.set(key, value, "NX");
            if (result === "OK") {
                await this.redisClient.expire(key, ttlSeconds); // set TTL separately
                return true;
            }
            return false;
        } catch (error) {
            this.logger.error(`Error acquiring lock with TTL for key "${key}":`, error);
            return false;
        }
    }


    async clearQueueRecoveryKeys(namespace: string, redis): Promise<number> {
        try {
            // Define the specific patterns used by your queue library/logic
            const patterns = [
                `${namespace}:g:*:active`,    // Group locks
                `${namespace}:processing:*`,  // Job markers
                // `${namespace}:unique:*`       // Duplicate markers
            ];

            let totalDeleted = 0;

            for (const pattern of patterns) {
                let cursor = '0';

                do {
                    // Scan for keys matching the pattern in batches of 100
                    const [newCursor, keys] = await redis.scan(
                        cursor,
                        'MATCH', pattern,
                        'COUNT', 100
                    );

                    cursor = newCursor;

                    if (keys.length > 0) {
                        await redis.del(...keys);
                        totalDeleted += keys.length;
                    }
                } while (cursor !== '0');
            }

            return totalDeleted;
        } catch (error) {
            this.logger.error(`[Redis] Failed to clear recovery keys for namespace: ${namespace}`, error);
            throw error;
        }
    }


    /**
     * Remove all stale group active locks for a queue namespace.
     * This unlocks groups so worker can pick up jobs again.
     * 
     * @param namespace - The queue namespace (e.g., 'flow-execution')
     * @returns Number of locks removed
     */
    async removeStaleLocks(namespace: string, redis: RedisClass): Promise<number> {
        const ns = `groupmq:${namespace}`;
        const pattern = `${ns}:g:*:active`;

        this.logger.log(
            `🔓 Removing stale group locks for namespace: ${namespace}`,
        );

        let cursor = '0';
        let totalCleaned = 0;

        try {
            do {
                // Scan for all :active keys
                const [newCursor, keys] = await redis.scan(
                    cursor,
                    'MATCH',
                    pattern,
                    'COUNT',
                    100,
                );

                cursor = newCursor;

                if (keys && keys.length > 0) {
                    // Delete all found active lists
                    await redis.del(...keys);
                    totalCleaned += keys.length;

                    this.logger.debug(
                        `Removed ${keys.length} locks in this batch (${keys.join(', ')})`,
                    );
                }
            } while (cursor !== '0');

            this.logger.log(
                `✅ Successfully removed ${totalCleaned} stale group locks`,
            );
            return totalCleaned;
        } catch (error) {
            this.logger.error(
                `❌ Failed to remove stale locks for namespace ${namespace}:`,
                error,
            );
            throw error;
        }
    }

    /**
     * Get detailed info about stalled jobs in the queue
     * 
     * @param namespace - The queue namespace
     * @returns Object with stalled job details
     */
    async getStalledJobsInfo(
        namespace: string,
        redis: RedisClass
    ): Promise<{
        stalledJobsInProcessing: string[];
        groupsWithActiveLocks: string[];
        locksCount: number;
    }> {
        const ns = `groupmq:${namespace}`;

        try {
            // Get all jobs currently in processing
            const processingJobs = await redis.zrange(
                `${ns}:processing`,
                0,
                -1,
            );

            // Get all group active lists
            const activeLocks: string[] = [];
            let cursor = '0';

            do {
                const [newCursor, keys] = await redis.scan(
                    cursor,
                    'MATCH',
                    `${ns}:g:*:active`,
                    'COUNT',
                    100,
                );

                cursor = newCursor;
                if (keys && keys.length > 0) {
                    activeLocks.push(...keys);
                }
            } while (cursor !== '0');

            // Extract group IDs from active lock keys
            const groupsWithActiveLocks = activeLocks.map((key) => {
                // Format: groupmq:flow-execution:g:GROUPID:active
                const parts = key.split(':');
                return parts.slice(3, -1).join(':'); // Extract groupId
            });

            this.logger.debug(
                `Stalled jobs info - Processing: ${processingJobs.length}, Active locks: ${activeLocks.length}`,
            );

            return {
                stalledJobsInProcessing: processingJobs,
                groupsWithActiveLocks,
                locksCount: activeLocks.length,
            };
        } catch (error) {
            this.logger.error(
                `Failed to get stalled jobs info for namespace ${namespace}:`,
                error,
            );
            throw error;
        }
    }

    /**
     * Manual recovery: move stalled jobs from processing back to waiting
     * This is called by stalled checker automatically, but can be called manually too
     * 
     * @param namespace - The queue namespace
     * @returns Number of jobs recovered
     */
    async recoverStalledJobs(namespace: string, redis: RedisClass): Promise<number> {
        const ns = `groupmq:${namespace}`;
        const processingKey = `${ns}:processing`;
        const now = Date.now();
        const gracePeriod = 5000; // 5 seconds grace period

        this.logger.log(`⚡ Manually recovering stalled jobs for ${namespace}`);

        try {
            // Get jobs whose deadline has passed
            const stalledJobs = await redis.zrangebyscore(
                processingKey,
                0,
                now - gracePeriod,
            );

            if (stalledJobs.length === 0) {
                this.logger.log('✅ No stalled jobs found');
                return 0;
            }

            let recovered = 0;

            for (const jobId of stalledJobs) {
                try {
                    const jobKey = `${ns}:job:${jobId}`;
                    const groupId = await redis.hget(jobKey, 'groupId');
                    const score = await redis.hget(jobKey, 'score');

                    if (groupId && score) {
                        // Remove from processing
                        await redis.zrem(processingKey, jobId);
                        await redis.del(`${ns}:processing:${jobId}`);

                        // Move back to group queue
                        const groupKey = `${ns}:g:${groupId}`;
                        await redis.zadd(groupKey, parseInt(score), jobId);

                        // Add group back to ready
                        const readyKey = `${ns}:ready`;
                        await redis.zadd(readyKey, parseInt(score), groupId);

                        // Remove from active list
                        const groupActiveKey = `${ns}:g:${groupId}:active`;
                        await redis.lrem(groupActiveKey, 1, jobId);

                        // Update job status
                        await redis.hset(jobKey, 'status', 'waiting');

                        recovered++;
                        this.logger.debug(
                            `Recovered job ${jobId} from group ${groupId}`,
                        );
                    }
                } catch (err) {
                    this.logger.warn(`Failed to recover job ${jobId}:`, err);
                }
            }

            this.logger.log(`✅ Recovered ${recovered} stalled jobs`);
            return recovered;
        } catch (error) {
            this.logger.error(
                `Failed to recover stalled jobs for namespace ${namespace}:`,
                error,
            );
            throw error;
        }
    }

    async fullStalledJobsRecovery(name: string, redis: RedisClass) {
        this.logger.log(`Starting full stalled jobs recovery for queue: ${name}`);

        const ns = `groupmq:${name}`;
        const now = Date.now();

        // Reset the stalled check throttle
        await redis.del(`${ns}:stalled:lastcheck`);

        const processingJobs = await redis.zrange(
            `${ns}:processing`,
            0,
            -1,
            'WITHSCORES'
        );

        let orphanedCount = 0;
        const jobsToRestore: Array<{ jobId: string; groupId: string; score: string; reasons: string[] }> = [];

        // ⭐ Phase 1: DETECT all orphaned jobs
        for (let i = 0; i < processingJobs.length; i += 2) {
            const jobId = processingJobs[i];
            const deadline = Number(processingJobs[i + 1]);
            const jobKey = `${ns}:job:${jobId}`;
            const groupId = await redis.hget(jobKey, 'groupId');
            const jobStatus = await redis.hget(jobKey, 'status');
            const score = await redis.hget(jobKey, 'score');

            if (!groupId || !score) continue;

            const groupActiveKey = `${ns}:g:${groupId}:active`;
            const activeList = await redis.lrange(groupActiveKey, 0, -1);

            const reasons = [];
            let isOrphaned = false;

            // 🔧 Condition 1: Job NOT in active list (already stuck from before)
            if (!activeList.includes(jobId)) {
                reasons.push('not_in_active');
                isOrphaned = true;
            }

            // 🔧 Condition 2: Job IS in active list BUT deadline has passed
            // This means handler crashed/stalled while processing
            if (activeList.includes(jobId) && now > deadline) {
                reasons.push('deadline_exceeded_while_active');
                isOrphaned = true;
            }

            if (activeList.includes(jobId) && now <= deadline) {
                reasons.push('stuck_in_active_no_recent_activity');
                isOrphaned = true;
            }

            if (isOrphaned) {
                this.logger.warn(
                    `🔴 ORPHANED: ${jobId} in ${groupId} [${reasons.join(',')}]`
                );
                jobsToRestore.push({ jobId, groupId, score, reasons });
            }
        }

        const activeLockKeysToDelete = new Set<string>();

        // ⭐ Phase 2: RESTORE all orphaned jobs
        for (const job of jobsToRestore) {
            const jobKey = `${ns}:job:${job.jobId}`;
            const groupActiveKey = `${ns}:g:${job.groupId}:active`;
            const groupKey = `${ns}:g:${job.groupId}`;
            const readyKey = `${ns}:ready`;

            // Remove from processing
            await redis.zrem(`${ns}:processing`, job.jobId);
            await redis.del(`${ns}:processing:${job.jobId}`);

            // Remove from active list (even if it's there)
            await redis.lrem(groupActiveKey, 0, job.jobId);

            // Track this active key for cleanup
            activeLockKeysToDelete.add(groupActiveKey);

            // Move back to group queue
            await redis.zadd(groupKey, parseInt(job.score), job.jobId);

            // Update job status
            await redis.hset(jobKey, 'status', 'waiting');

            // Add group back to ready queue
            await redis.zadd(readyKey, parseInt(job.score), job.groupId);

            orphanedCount++;
            this.logger.log(`✅ FIXED ${job.jobId} [${job.reasons.join(',')}]`);
        }

        if (activeLockKeysToDelete.size > 0) {
            try {
                await redis.del(...Array.from(activeLockKeysToDelete));
                this.logger.log(`✓ Removed ${activeLockKeysToDelete.size} stale group locks`);
            } catch (err) {
                this.logger.error(`Failed to remove active locks:`, err);
            }
        }

        this.logger.log(`🔧 Fixed ${orphanedCount} orphaned jobs`);
        this.logger.log(`✅ Recovery complete!`);
    }
}

