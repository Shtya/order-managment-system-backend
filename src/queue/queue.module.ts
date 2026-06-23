import { forwardRef, Global, Injectable, MiddlewareConsumer, Module, NestMiddleware, NestModule, RequestMethod } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express'; // Make sure this is installed

import { QueueNames } from './common/queue.constants';
import { AutoAssignmentQueueService, AutoAssignmentWorkerService } from './queues/auto-assignment.queue';
import { OrdersModule } from 'src/orders/orders.module';
import { OrderAssignmentModule } from 'src/order-assignment/order-assignment.module';
import { OpsController } from './opsController';
import { ProductSyncQueueService, ProductSyncWorkerService } from './queues/product-sync.queue';
import { OrderSyncQueueService, OrderSyncWorkerService } from './queues/order-sync.queue';
import { AutomationQueueService, AutomationWorkerService } from './queues/automations.queue';
import { QueueDelayService } from './common/queue-delay.service';
import { StoresModule } from 'src/stores/stores.module';
import { AutomationModule } from 'src/automation/automation.module';
import { bullQueueConfig } from './common/base-queue.config';
import { BullBoardAuthMiddleware } from './common/bull-board-auth-middleware';
import { AuthModule } from 'src/auth/auth.module';
import { ConfigModule, ConfigService } from '@nestjs/config';

const registeredQueues = Object.values(QueueNames).map((queueName) => ({
  name: queueName,
}));

const registeredBoardQueues = Object.values(QueueNames).map((queueName) => ({
  name: queueName,
  adapter: BullMQAdapter,
}));

@Global()
@Module({
  imports: [
    forwardRef(() => AuthModule),
    forwardRef(() => OrdersModule),
    forwardRef(() => StoresModule),
    forwardRef(() => AutomationModule),
    forwardRef(() => OrderAssignmentModule),
    BullModule.forRootAsync(bullQueueConfig),
    BullModule.registerQueue(...registeredQueues),
    BullBoardModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const frontendUrl = configService.get<string>('FRONTEND_URL');

        return {
          route: '/queues',
          adapter: ExpressAdapter,
          boardOptions: {
            uiConfig: {
              boardTitle: 'Madar Jobs',
              miscLinks: [
                { text: 'Back to Admin Panel', url: '/dashboard/users' },
              ],
              favIcon: {
                default: `${frontendUrl}/favicon.ico`,
                alternative: `${frontendUrl}/favicon.ico`,
              },
              pollingInterval: {
                showSetting: true,     // Let users pause updates manually
              },
              hideDocsLink: true,
              showMetrics: true,
              boardLogo: {
                path: `${frontendUrl}/madaar.svg`,
                width: 30,
                height: 30,
              },
            },
          },
        };
      },
    }),
    BullBoardModule.forFeature(...registeredBoardQueues),
  ],
  providers: [
    AutoAssignmentQueueService,
    AutoAssignmentWorkerService,
    ProductSyncQueueService,
    ProductSyncWorkerService,
    OrderSyncQueueService,
    OrderSyncWorkerService,
    AutomationQueueService,
    AutomationWorkerService,
    QueueDelayService,
  ],
  exports: [
    AutoAssignmentQueueService,
    AutoAssignmentWorkerService,
    ProductSyncQueueService,
    ProductSyncWorkerService,
    OrderSyncQueueService,
    OrderSyncWorkerService,
    AutomationQueueService,
    AutomationWorkerService,
    QueueDelayService,
  ],
  controllers: [OpsController],
})
export class QueueModule implements NestModule {  // ← add NestModule
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(BullBoardAuthMiddleware)
      .forRoutes({ path: 'queues*', method: RequestMethod.ALL }); // covers /queues and all sub-paths
  }
}