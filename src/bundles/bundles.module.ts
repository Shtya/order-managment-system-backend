// --- File: src/bundles/bundles.module.ts ---
import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BundlesService } from "./bundles.service";
import { BundlesController } from "./bundles.controller";
import { BundleSubscriber } from "./bundle-subscriber";

import { BundleEntity, BundleItemEntity } from "entities/bundle.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import { CategoryEntity } from "entities/categories.entity";
import { StoresModule } from "src/stores/stores.module";
import { OrdersModule } from "src/orders/orders.module";
import { OrphanFileEntity } from "entities/files.entity";
import { OrphanFilesModule } from "src/orphan-files/orphan-files.module";

@Module({
  imports: [
    forwardRef(() => OrphanFilesModule),
    forwardRef(() => StoresModule),
     OrdersModule, 
    TypeOrmModule.forFeature([BundleEntity, BundleItemEntity, ProductVariantEntity, OrphanFileEntity, CategoryEntity])],
  providers: [BundlesService, BundleSubscriber],
  controllers: [BundlesController],
  exports: [BundlesService],
})
export class BundlesModule {}
