// orders/orders.module.ts
import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { OrdersController } from "./controllers/orders.controller";
import { OrdersService } from "./services/orders.service";
import {
  OrderEntity,
  OrderItemEntity,
  OrderStatusHistoryEntity,
  OrderMessageEntity,
  OrderStatusEntity,
  OrderRetrySettingsEntity,
  OrderReplacementEntity,
} from "entities/order.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import { StoresModule } from "src/stores/stores.module";
import { OrderSubscriber } from "./order-subscriber";
import { User } from "entities/user.entity";
import { AuthModule } from "src/auth/auth.module";
import { BulkUploadUsage } from "dto/plans.dto";

import { ShippingSeedService } from "../shipping/shipping.seed";
import { Notification } from "entities/notifications.entity";
import { ShippingCompanyEntity, ShippingIntegrationEntity } from "entities/shipping.entity";
import { StoreEntity } from "entities/stores.entity";
import { OrderReplacemetsController } from "./controllers/order-replacements.controller";
import { OrderReplacementService } from "./services/order-replacements.service";




@Module({
  imports: [
    forwardRef(() => StoresModule),
    forwardRef(() => AuthModule),
    TypeOrmModule.forFeature([
      OrderEntity,
      OrderItemEntity,
      OrderStatusEntity,
      OrderStatusHistoryEntity,
      OrderMessageEntity,
      ProductVariantEntity,
      ShippingCompanyEntity,
      OrderRetrySettingsEntity,
      User,
      BulkUploadUsage,
      Notification,
      StoreEntity,
      OrderReplacementEntity,
      ShippingIntegrationEntity
    ]),
  ],
  providers: [OrdersService, OrderSubscriber, ShippingSeedService, OrderReplacementService],
  controllers: [OrdersController, OrderReplacemetsController],
  exports: [OrdersService],
})
export class OrdersModule { }