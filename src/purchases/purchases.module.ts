// purchases/purchases.module.ts
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PurchasesController } from "./purchases.controller";
import { PurchasesService } from "./purchases.service";
import { PurchaseSubscriber } from "./purchase-subscriber";
import {
  PurchaseInvoiceEntity,
  PurchaseInvoiceItemEntity,
  PurchaseAuditLogEntity,
} from "entities/purchase.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import { SupplierEntity } from "../../entities/supplier.entity";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PurchaseInvoiceEntity,
      PurchaseInvoiceItemEntity,
      PurchaseAuditLogEntity,
      ProductVariantEntity,
      SupplierEntity
    ]),
  ],
  providers: [PurchasesService, PurchaseSubscriber],
  controllers: [PurchasesController],
  exports: [PurchasesService],
})
export class PurchasesModule { }
