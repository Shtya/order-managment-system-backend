// src/config/bull.config.ts
import { ConfigModule, ConfigService } from '@nestjs/config';

export const bullQueueConfig = {
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: async (configService: ConfigService) => {
    const useTls =
      configService.get<string>('REDIS_USE_TLS') === 'true' ||
      (configService.get<boolean>('REDIS_USE_TLS') as any) === true;

    return {
      connection: {
        host: configService.get<string>('REDIS_HOST'),
        port: Number(configService.get<number>('REDIS_PORT')),
        password: configService.get<string>('REDIS_PASSWORD') || undefined,
        db: Number(configService.get<number>('REDIS_DB') || 0),
        ...(useTls && { tls: {} }),
      },
      defaultJobOptions: {
        attempts: Number(configService.get<number>('QUEUE_DEFAULT_ATTEMPTS') || 1),
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    };
  },
};