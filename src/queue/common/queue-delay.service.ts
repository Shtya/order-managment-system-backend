import { Injectable } from '@nestjs/common';
import { Semaphore } from 'redis-semaphore';
import { RedisService } from 'common/redis/RedisService';
import { Job, DelayedError } from 'bullmq';

export interface QueueDelayConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
  maxPerUser: number;
  lockTimeout: number;
  keyPrefix: string;
}

const DEFAULT_CONFIG: QueueDelayConfig = {
  baseDelayMs: 600,
  maxDelayMs: 5000,
  jitterFactor: 0.3,
  maxPerUser: 1,
  lockTimeout: 60000,
   keyPrefix: 'user-slot',
};

@Injectable()
export class QueueDelayService {
  constructor(private readonly redisService: RedisService) {}

  private calcDelay(attemptsMade: number, config: QueueDelayConfig): number {
    const exp = config.baseDelayMs * Math.pow(2, attemptsMade);
    const capped = Math.min(exp, config.maxDelayMs);
    const jitter = Math.floor(Math.random() * (capped * config.jitterFactor));
    return capped + jitter;
  }

  async acquireUserSlotAndProcess(
    job: Job,
    token: string | undefined,
    userId: string,
    processFn: () => Promise<any>,
    config?: Partial<QueueDelayConfig>,
  ): Promise<any> {
    const mergedConfig: QueueDelayConfig = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    const semaphoreKey = `${mergedConfig.keyPrefix}:${userId}`;  // ← uses config
    const semaphore = new Semaphore(
      this.redisService.redisClient,
      semaphoreKey,
      mergedConfig.maxPerUser,
      {
        lockTimeout: mergedConfig.lockTimeout,
        acquireAttemptsLimit: 1,
      },
    );

    const acquired = await semaphore.tryAcquire();

    if (!acquired) {
      const delay = this.calcDelay(job.attemptsMade, mergedConfig);
      await job.moveToDelayed(Date.now() + delay, token);
      throw new DelayedError();
    }

    try {
      return await processFn();
    } finally {
      await semaphore.release();
    }
  }
}
