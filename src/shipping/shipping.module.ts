// --- File: backend/src/shipping/shipping.module.ts ---
import { forwardRef, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { ShippingController } from './shipping.controller';
import { ShippingWebhookController } from './shipping.webhook.controller';
import { ShippingService } from './shipping.service';

import { ShippingCompanyEntity } from '../../entities/shipping.entity';
import { ShipmentEntity, ShippingIntegrationEntity, ShipmentEventEntity } from '../../entities/shipping.entity';

import { BostaProvider } from './providers/bosta.provider';
import { JtProvider } from './providers/jt.provider';
import { TurboProvider } from './providers/turbo.provider';
import { OrderEntity } from 'entities/order.entity';
import { OrdersModule } from 'src/orders/orders.module';
import { ShippingQueueService } from './queues/shipping.queues';
import { ShippingWorkerService } from './queues/shipping.workers';
import { WebSocketModule } from '../../common/websocket.module';

@Module({
  imports: [
    HttpModule,
    AuthModule,
    forwardRef(() => OrdersModule),
    WebSocketModule,
    TypeOrmModule.forFeature([ShippingCompanyEntity, ShippingIntegrationEntity, ShipmentEntity, ShipmentEventEntity, OrderEntity]),
  ],
  controllers: [ShippingController, ShippingWebhookController],
  providers: [ShippingService, BostaProvider, JtProvider, TurboProvider, ShippingQueueService, ShippingWorkerService],
  exports: [ShippingService, ShippingQueueService],
})
export class ShippingModule { }
