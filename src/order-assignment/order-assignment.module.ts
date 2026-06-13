import { forwardRef, Module } from '@nestjs/common';
import { OrderAssignmentService } from './order-assignment.service';
import { OrderAssignmentController } from './order-assignment.controller';
import { RedisModule } from 'common/redis/redis.module';
import { OrderAssignmentEntity, AutoAssignRuleEntity } from 'entities/assignment.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersModule } from 'src/orders/orders.module';
import { User } from 'entities/user.entity';
import { OrderEntity, OrderStatusEntity } from 'entities/order.entity';
import { ProductEntity } from 'entities/sku.entity';
import { CityEntity } from 'entities/cities.entity';
import { ShippingCompanyEntity } from 'entities/shipping.entity';
import { StoreEntity } from 'entities/stores.entity';
import { BullModule } from '@nestjs/bullmq';


@Module({
  imports: [
    forwardRef(() => OrdersModule),
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
      StoreEntity
    ]),

  ],
  controllers: [OrderAssignmentController],
  providers: [OrderAssignmentService],
  exports: [OrderAssignmentService],
})
export class OrderAssignmentModule { }
