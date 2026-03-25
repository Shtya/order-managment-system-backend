// --- File: src/products/products.module.ts ---
import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { ProductEntity, ProductVariantEntity } from "../../entities/sku.entity";
import { CategoryEntity } from "entities/categories.entity";
import { StoreEntity } from "entities/stores.entity";
import { WarehouseEntity } from "entities/warehouses.entity";

import { ProductsService } from "./products.service";
import { ProductsController } from "./products.controller";
import { ProductSubscriber, VariantSubscriber } from "./product-subscriber";
import { StoresModule } from "src/stores/stores.module";
import { OrderItemEntity } from "entities/order.entity";
import { LowStockService } from "common/background-services/low-stock.service";
import { User } from "entities/user.entity";

@Module({
  imports: [
    forwardRef(() => StoresModule),
    TypeOrmModule.forFeature([
      ProductEntity,
      ProductVariantEntity,
      CategoryEntity,
      StoreEntity,
      WarehouseEntity,
      OrderItemEntity,
      User
    ]),
  ],
  providers: [ProductsService, ProductSubscriber, VariantSubscriber, LowStockService],
  controllers: [ProductsController],
  exports: [ProductsService],
})
export class ProductsModule { }
