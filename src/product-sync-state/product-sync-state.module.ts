import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductSyncStateController } from './product-sync-state.controller';
import { ProductSyncStateService } from './product-sync-state.service';
import { ProductSyncStateEntity, ProductSyncErrorLogEntity } from 'entities/product_sync_error.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ProductSyncStateEntity, ProductSyncErrorLogEntity])],
  controllers: [ProductSyncStateController],
  providers: [ProductSyncStateService],
  exports: [ProductSyncStateService],
})
export class ProductSyncStateModule { }
