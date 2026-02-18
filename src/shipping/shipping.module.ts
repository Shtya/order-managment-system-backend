import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { ShippingController } from './shipping.controller';
import { ShippingWebhookController } from './shipping.webhook.controller';
import { ShippingService } from './shipping.service';

import { ShippingCompanyEntity } from '../../entities/shipping.entity';
import { ShipmentEntity, ShippingIntegrationEntity, ShipmentEventEntity } from './shipping.entity';

import { BostaProvider } from './providers/bosta.provider';

@Module({
  imports: [
    HttpModule,
    AuthModule,
    TypeOrmModule.forFeature([ShippingCompanyEntity, ShippingIntegrationEntity, ShipmentEntity, ShipmentEventEntity]),
  ],
  controllers: [ShippingController, ShippingWebhookController],
  providers: [ShippingService, BostaProvider],
})
export class ShippingModule {}
