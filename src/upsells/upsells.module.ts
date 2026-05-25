import { Module } from '@nestjs/common';
import { UpsellsService } from './upsells.service';
import { UpsellsController } from './upsells.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Upsell } from 'entities/upsells.entity';
import { ProductEntity, ProductVariantEntity } from 'entities/sku.entity';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Upsell, ProductEntity, ProductVariantEntity]),
    WhatsappModule,
  ],
  controllers: [UpsellsController],
  providers: [UpsellsService],
  exports: [UpsellsService],
})
export class UpsellsModule { }
