import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { QueryFailedErrorFilter } from "common/QueryFailedErrorFilter";
import { AuthModule } from "./auth/auth.module";
import { Permission, Role, User } from "../entities/user.entity";
import { UsersModule } from "./users/users.module";
import { PermissionsModule } from "./permissions/permissions.module";
import { RolesModule } from "./roles/roles.module";
import { LookupsModule } from './lookups/lookups.module';
import { PlansModule } from './plans/plans.module';
import { TransactionsModule } from './transactions/transactions.module';
import { Plan, Transaction } from "../entities/plans.entity";
import { StoresModule } from './stores/stores.module';
import { WarehousesModule } from './warehouse/warehouse.module';
import { CategoryModule } from './category/category.module';
import { ProductsModule } from './products/products.module';
import { CategoryEntity } from "../entities/categories.entity";
import { StoreEntity } from "../entities/stores.entity";
import { WarehouseEntity } from "../entities/warehouses.entity";
import { Asset } from "../entities/assets.entity";
import { AssetModule } from "./asset/asset.module";

import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";
import { SuppliersModule } from "./supplier/supplier.module";
import { SupplierCategoriesModule } from "./supplier/categories/categories.module";
import { SupplierCategoryEntity, SupplierEntity } from "../entities/supplier.entity";
import { PurchasesModule } from './purchases/purchases.module';
import { PurchasesReturnModule } from './purchases-return/purchases-return.module';
import { OrdersModule } from './orders/orders.module';
import { SalesInvoiceModule } from './sales_invoice/sales_invoice.module';
import { BundlesModule } from './bundles/bundles.module';
import { EncryptionService } from "common/encryption.service";
import { BullModule } from '@nestjs/bull';
import { ShippingCompaniesModule } from "./shipping/shipping.module";

@Module({
	imports: [
		ConfigModule.forRoot(),
		TypeOrmModule.forRoot({
			type: "postgres",
			host: process.env.DATABASE_HOST,
			port: parseInt(process.env.DATABASE_PORT, 10),
			username: process.env.DATABASE_USER,
			password: process.env.DATABASE_PASSWORD,
			database: process.env.DATABASE_NAME,
			entities: [__dirname + '/../**/*.entity{.ts,.js}'],
			// entities: [User, Role, Permission, SupplierEntity, SupplierCategoryEntity ,ProductVariantEntity, Plan, Transaction, CategoryEntity, StoreEntity, WarehouseEntity, ProductEntity, Asset],
			synchronize: true
		}),
		BullModule.registerQueue({ name: 'store-sync' }),
		AuthModule,
		RolesModule,
		PermissionsModule,
		UsersModule,
		LookupsModule,
		PlansModule,
		TransactionsModule,
		StoresModule,
		WarehousesModule,
		CategoryModule,
		ProductsModule,
		AssetModule,
		SuppliersModule,
		SupplierCategoriesModule,
		PurchasesModule,
		PurchasesReturnModule,
		OrdersModule,
		SalesInvoiceModule,
		BundlesModule,
		ShippingCompaniesModule
	],
	providers: [
		QueryFailedErrorFilter, EncryptionService
	],
	exports: [],
})
export class AppModule { }
