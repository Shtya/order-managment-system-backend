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
} from "entities/order.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import { StoresModule } from "src/stores/stores.module";
import { OrderSubscriber } from "./order-subscriber";

@Module({
  imports: [
    forwardRef(() => StoresModule),
    TypeOrmModule.forFeature([
      OrderEntity,
      OrderItemEntity,
      OrderStatusHistoryEntity,
      OrderMessageEntity,
      ProductVariantEntity,
    ]),
  ],
  providers: [OrdersService, OrderSubscriber],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule { }