import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { Type } from 'class-transformer';
import { OrderEntity, OrderStatusEntity } from 'entities/order.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from 'entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([OrderEntity, OrderStatusEntity, User])],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule { }
