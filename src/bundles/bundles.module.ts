// --- File: src/bundles/bundles.module.ts ---
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BundlesService } from "./bundles.service";
import { BundlesController } from "./bundles.controller";

import { BundleEntity, BundleItemEntity } from "entities/bundle.entity";
import { ProductVariantEntity } from "entities/sku.entity";

@Module({
  imports: [TypeOrmModule.forFeature([BundleEntity, BundleItemEntity, ProductVariantEntity])],
  providers: [BundlesService],
  controllers: [BundlesController],
  exports: [BundlesService],
})
export class BundlesModule {}
