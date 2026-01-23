import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Permission, Role, User } from 'entities/user.entity';
import { LookupsController } from './lookups.controller';
import { LookupsService } from './lookups.service';
import { CategoryEntity } from '../../entities/categories.entity';
import { StoreEntity } from '../../entities/stores.entity';
import { WarehouseEntity } from '../../entities/warehouses.entity';
import { SupplierEntity } from '../../entities/supplier.entity';
import { ProductEntity, ProductVariantEntity } from '../../entities/sku.entity';

@Module({
	imports: [TypeOrmModule.forFeature([User, Role, Permission, CategoryEntity,
		StoreEntity, 
      ProductEntity,
      ProductVariantEntity,
      SupplierEntity,
		WarehouseEntity,])],
	controllers: [LookupsController],
	providers: [LookupsService],
})
export class LookupsModule { }
