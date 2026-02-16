// orders/orders.module.ts
import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import {
  OrderEntity,
  OrderItemEntity,
  OrderStatusHistoryEntity,
  OrderMessageEntity,
  OrderStatusEntity,
  OrderRetrySettingsEntity,
} from "entities/order.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import { StoresModule } from "src/stores/stores.module";
import { OrderSubscriber } from "./order-subscriber";
import { ShippingCompanyEntity } from "entities/shipping.entity";
import { User } from "entities/user.entity";
import { AuthModule } from "src/auth/auth.module";

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
    ]),
  ],
  providers: [OrdersService, OrderSubscriber],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule { }