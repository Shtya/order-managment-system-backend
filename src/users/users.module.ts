import { forwardRef, Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company, Role, User } from 'entities/user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { Plan, Subscription } from '../../entities/plans.entity';
import { SubscriptionsModule } from 'src/subscription/subscription.module';
import { SeedService } from './initial-seed.service';
import { CategoryModule } from '../category/category.module';
import { SupplierCategoriesModule } from '../supplier/categories/categories.module';
import { SuppliersModule } from '../supplier/supplier.module';
import { ProductsModule } from '../products/products.module';
import { ProductEntity } from 'entities/sku.entity';

@Global()
@Module({
  imports: [
    forwardRef(() => SubscriptionsModule),
    TypeOrmModule.forFeature([User, Role, Plan, Subscription, Company, ProductEntity]),
    forwardRef(() => CategoryModule),
    forwardRef(() => SupplierCategoriesModule),
    forwardRef(() => SuppliersModule),
    forwardRef(() => ProductsModule),
  ],
  providers: [UsersService, SeedService],
  controllers: [UsersController],
  exports: [UsersService]
})
export class UsersModule { }
