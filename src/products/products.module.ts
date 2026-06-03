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
import { OrderItemEntity, OrderRetrySettingsEntity } from "entities/order.entity";
import { LowStockService } from "common/background-services/low-stock.service";
import { User } from "entities/user.entity";
import { PurchasesModule } from "src/purchases/purchases.module";
import { OrphanFileEntity } from "entities/files.entity";
import { OrphanFilesModule } from "src/orphan-files/orphan-files.module";
import { ProductSyncStateModule } from "src/product-sync-state/product-sync-state.module";
import { RemoteImageHelper } from "common/emote-image.helper";
import { ProductSyncStateEntity } from "entities/product_sync_error.entity";
import { PurchaseInvoiceItemEntity } from "entities/purchase.entity";
import { PurchaseReturnInvoiceItemEntity } from "entities/purchase_return.entity";
import { OrdersModule } from "src/orders/orders.module";

@Module({
  imports: [
    forwardRef(() => StoresModule),
    forwardRef(() => PurchasesModule),
    forwardRef(() => OrphanFilesModule),
    forwardRef(() => OrdersModule),
    ProductSyncStateModule,
    TypeOrmModule.forFeature([
      ProductEntity,
      ProductVariantEntity,
      CategoryEntity,
      StoreEntity,
      WarehouseEntity,
      OrderItemEntity,
      OrderRetrySettingsEntity,
      User,
      OrphanFileEntity,
      ProductSyncStateEntity,
      PurchaseInvoiceItemEntity,
      PurchaseReturnInvoiceItemEntity,
    ]),
  ],
  providers: [ProductsService, ProductSubscriber, VariantSubscriber, LowStockService, RemoteImageHelper, {
    provide: 'PUBLIC_BASE_URL',
    useValue: '/uploads/products', // القيمة التي تريدها
  },],
  controllers: [ProductsController],
  exports: [ProductsService],
})
export class ProductsModule { }
