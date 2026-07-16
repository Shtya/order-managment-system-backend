// src/config/bull.config.ts
import { SharedBullAsyncConfiguration } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

export const bullQueueConfig: SharedBullAsyncConfiguration = {
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: async (configService: ConfigService) => {
    const useTls =
      configService.get<string>('REDIS_USE_TLS') === 'true' ||
      (configService.get<boolean>('REDIS_USE_TLS') as any) === true;
    const username = (configService.get<string>('REDIS_USERNAME') || '').trim() || undefined;
    const password = (configService.get<string>('REDIS_PASSWORD') || '').trim() || undefined;

    return {
      connection: {
        host: configService.get<string>('REDIS_HOST'),
        port: Number(configService.get<number>('REDIS_PORT') || 6379),
        username,
        password,
        db: Number(configService.get<number>('REDIS_DB') || 0),
        ...(useTls && { tls: {} }),
      },
      defaultJobOptions: {
        attempts: Number(configService.get<number>('QUEUE_DEFAULT_ATTEMPTS') || 1),
        backoff: { type: 'exponential', delay: 3000 },
        // removeOnComplete: true,
         removeOnComplete: {
          age: 24 * 3600, // Keep for 24 hours (in seconds)
          count: 1000,    // Keep a maximum of 1000 jobs
        },
        
        // 👇 CHANGED: Keep failed jobs longer so you can inspect the error logs
        // removeOnFail: true,
        removeOnFail: {
          age: 7 * 24 * 3600, // Keep failed jobs for 7 days
          count: 2000,        // Keep a maximum of 2000 failed jobs
        },
      },
    };
  },
};