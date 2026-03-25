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
  OrderScanLogEntity,
  ShipmentManifestEntity,
  OrderActionLogEntity,
  ReturnRequestEntity,
} from "entities/order.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import { StoresModule } from "src/stores/stores.module";
import { OrderSubscriber } from "./order-subscriber";
import { User } from "entities/user.entity";
import { AuthModule } from "src/auth/auth.module";
import { BulkUploadUsage } from "dto/plans.dto";

import { ShippingSeedService } from "../shipping/shipping.seed";
import { Notification } from "entities/notifications.entity";
import {
  ShippingCompanyEntity,
  ShippingIntegrationEntity,
} from "entities/shipping.entity";
import { StoreEntity } from "entities/stores.entity";
import { OrderReplacemetsController } from "./controllers/order-replacements.controller";
import { OrderReplacementService } from "./services/order-replacements.service";
import { OrderCollectionEntity } from "entities/order-collection.entity";
import { ShippingModule } from "src/shipping/shipping.module";
import { OrderReturnService } from "./services/order-return.service";
import { OrderReturnsController } from "./controllers/order-return.controller";
import { SubscriptionsModule } from "src/subscription/subscription.module";
import { WalletModule } from "src/wallet/wallet.module";

@Module({
  imports: [
    forwardRef(() => StoresModule),
    forwardRef(() => ShippingModule),
    forwardRef(() => WalletModule),
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
      ShippingIntegrationEntity,
      OrderCollectionEntity,
      OrderScanLogEntity,
      ShipmentManifestEntity,
      OrderActionLogEntity,
      ReturnRequestEntity,
    ]),
  ],
  providers: [
    OrdersService,
    OrderSubscriber,
    ShippingSeedService,
    OrderReplacementService,
    OrderReturnService,
  ],
  controllers: [
    OrdersController,
    OrderReplacemetsController,
    OrderReturnsController,
  ],
  exports: [OrdersService],
})
export class OrdersModule {}
