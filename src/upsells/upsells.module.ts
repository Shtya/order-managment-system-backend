import { forwardRef, Module } from '@nestjs/common';
import { UpsellsService } from './upsells.service';
import { UpsellsController } from './upsells.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Upsell, UpsellHistory } from 'entities/upsells.entity';
import { ProductEntity, ProductVariantEntity } from 'entities/sku.entity';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { OrdersModule } from '../orders/orders.module';
import { WhatsappAccountEntity } from 'entities/whatsapp.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Upsell, UpsellHistory, ProductEntity, ProductVariantEntity, WhatsappAccountEntity]),
    forwardRef(() => WhatsappModule),
    forwardRef(() => OrdersModule),
  ],
  controllers: [UpsellsController],
  providers: [UpsellsService],
  exports: [UpsellsService],
})
export class UpsellsModule { }
