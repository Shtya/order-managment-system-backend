// --- File: src/bundles/bundles.module.ts ---
import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BundlesService } from "./bundles.service";
import { BundlesController } from "./bundles.controller";
import { BundleSubscriber } from "./bundle-subscriber";

import { BundleEntity, BundleItemEntity } from "entities/bundle.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import { StoresModule } from "src/stores/stores.module";

@Module({
  imports: [ forwardRef(() => StoresModule),TypeOrmModule.forFeature([BundleEntity, BundleItemEntity, ProductVariantEntity])],
  providers: [BundlesService, BundleSubscriber],
  controllers: [BundlesController],
  exports: [BundlesService],
})
export class BundlesModule {}
