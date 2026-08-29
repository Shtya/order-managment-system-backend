import { forwardRef, Module } from "@nestjs/common";
import { OrderAssignmentService } from "./order-assignment.service";
import { OrderAssignmentController } from "./order-assignment.controller";
import { OrderAssignmentSubscriber } from "./order-assignment.subscriber";
import { RedisModule } from "common/redis/redis.module";
import {
  OrderAssignmentEntity,
  AutoAssignRuleEntity,
} from "entities/assignment.entity";
import { TypeOrmModule } from "@nestjs/typeorm";
import { OrdersModule } from "src/orders/orders.module";
import { User } from "entities/user.entity";
import { OrderEntity, OrderStatusEntity } from "entities/order.entity";
import { ProductEntity } from "entities/sku.entity";
import { CityEntity } from "entities/cities.entity";
import { ShippingCompanyEntity } from "entities/shipping.entity";
import { StoreEntity } from "entities/stores.entity";
import { TagsModule } from "src/tags/tags.module";
import { AutomationModule } from "src/automation/automation.module";

@Module({
  imports: [
    forwardRef(() => OrdersModule),
    forwardRef(() => TagsModule),
    forwardRef(() => AutomationModule),
    RedisModule,
    TypeOrmModule.forFeature([
      OrderAssignmentEntity,
      AutoAssignRuleEntity,
      User,
      OrderEntity,
      OrderStatusEntity,
      ProductEntity,
      CityEntity,
      ShippingCompanyEntity,
      StoreEntity,
    ]),
  ],
  controllers: [OrderAssignmentController],
  providers: [OrderAssignmentService, OrderAssignmentSubscriber],
  exports: [OrderAssignmentService],
})
export class OrderAssignmentModule {}
