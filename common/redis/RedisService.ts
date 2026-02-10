import {
    Inject,
    Injectable,
    OnModuleDestroy,
    OnModuleInit,
    Logger,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

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



}
