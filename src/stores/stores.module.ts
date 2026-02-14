import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { StoreEntity } from "entities/stores.entity";
import { StoresService } from "./stores.service";
import { StoresController } from "./stores.controller";
import { EncryptionService } from "common/encryption.service";
import { EasyOrderService } from "./storesIntegrations/EasyOrderService";
import { CategoryEntity } from "entities/categories.entity";
import { StoreQueueService } from "./storesIntegrations/queues";
import { StoreWorkerService } from "./storesIntegrations/workers";
import { StoreSubscriber } from "./store-subscriber";
import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";
import { OrderEntity, OrderStatusEntity } from "entities/order.entity";
import { RedisService } from "common/redis/RedisService";
import { RedisModule } from "common/redis/redis.module";
import { OrdersModule } from "src/orders/orders.module";
import { ProductsModule } from "src/products/products.module";
import { CategoryModule } from "src/category/category.module";
import { ShopifyService } from "./storesIntegrations/ShopifyService";
import { StoreWebhooksController } from "./webhooks.controller";
import { WooCommerceService } from "./storesIntegrations/WooCommerce";

@Module({
  imports: [
    RedisModule,
    forwardRef(() => OrdersModule),
    forwardRef(() => ProductsModule),
    forwardRef(() => CategoryModule),

    TypeOrmModule.forFeature([StoreEntity, CategoryEntity, ProductEntity, ProductVariantEntity, OrderEntity, OrderStatusEntity]),
  ],
  providers: [
    StoresService,
    StoreSubscriber,
    EncryptionService,
    EasyOrderService,      // The API Logic + Bottleneck
    ShopifyService,
    WooCommerceService,
    StoreQueueService, // The Producer
    StoreWorkerService,
  ],
  controllers: [StoresController, StoreWebhooksController],
  exports: [StoresService, EasyOrderService, WooCommerceService],
})
export class StoresModule { }
