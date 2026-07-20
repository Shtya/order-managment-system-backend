// redis-io.adapter.ts
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, RedisClientOptions } from 'redis';
import { ConfigService } from '@nestjs/config';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;
  private configService: ConfigService;

  constructor(app: any, configService: ConfigService) {
    super(app);
    this.configService = configService;
  }

  async connectToRedis(): Promise<void> {
    const redisConfig = this.configService.get('redis');
    const redisUrl = `redis${redisConfig.useTls ? 's' : ''}://${redisConfig.host}:${redisConfig.port}`;
    
    const clientOptions: RedisClientOptions = {
      url: redisUrl,
      username: redisConfig.username,
      password: redisConfig.password,
      database: redisConfig.db,
      socket: redisConfig.tls ? { tls: true } : undefined,
    };

    const pubClient = createClient(clientOptions);
    const subClient = pubClient.duplicate();

    await Promise.all([pubClient.connect(), subClient.connect()]);

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }
}