// purchases-return/purchases-return.module.ts
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PurchaseReturnsController } from "./purchases-return.controller";
import { PurchaseReturnsService } from "./purchases-return.service";
import { PurchaseReturnSubscriber } from "./purchase-return-subscriber";
import { PurchaseReturnInvoiceEntity, PurchaseReturnInvoiceItemEntity, PurchaseReturnAuditLogEntity } from "entities/purchase_return.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import { SupplierEntity } from "entities/supplier.entity";

@Module({
  imports: [TypeOrmModule.forFeature([PurchaseReturnInvoiceEntity, PurchaseReturnInvoiceItemEntity, PurchaseReturnAuditLogEntity, ProductVariantEntity, SupplierEntity])],
  providers: [PurchaseReturnsService, PurchaseReturnSubscriber],
  controllers: [PurchaseReturnsController],
  exports: [PurchaseReturnsService],
})
export class PurchasesReturnModule { }
