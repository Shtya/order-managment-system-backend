import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { StoreEntity } from "entities/stores.entity";
import { StoresService } from "./stores.service";
import { StoresController } from "./stores.controller";
import { EncryptionService } from "common/encryption.service";
import { EasyOrderService } from "./storesIntegrations/EasyOrderService";
import { CategoryEntity } from "entities/categories.entity";
import { EasyOrderQueueService } from "./storesIntegrations/queues";
import { EasyOrderWorkerService } from "./storesIntegrations/workers";
import { StoreSubscriber } from "./store-subscriber";
import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";
import { OrderEntity } from "entities/order.entity";
import { RedisService } from "common/redis/RedisService";
import { RedisModule } from "common/redis/redis.module";
import { OrdersModule } from "src/orders/orders.module";
import { ProductsModule } from "src/products/products.module";
import { CategoryModule } from "src/category/category.module";

@Module({
  imports: [
    RedisModule,
    forwardRef(() => OrdersModule),
    forwardRef(() => ProductsModule),
    forwardRef(() => CategoryModule),

    TypeOrmModule.forFeature([StoreEntity, CategoryEntity, ProductEntity, ProductVariantEntity, OrderEntity]),
  ],
  providers: [
    StoresService,
    StoreSubscriber,
    EncryptionService,
    EasyOrderService,      // The API Logic + Bottleneck
    EasyOrderQueueService, // The Producer
    EasyOrderWorkerService],
  controllers: [StoresController],
  exports: [StoresService, EasyOrderService],
})
export class StoresModule { }
