// purchases-return/purchases-return.module.ts
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PurchaseReturnsController } from "./purchases-return.controller";
import { PurchaseReturnsService } from "./purchases-return.service";
import { PurchaseReturnInvoiceEntity, PurchaseReturnInvoiceItemEntity } from "entities/purchase_return.entity";

@Module({
  imports: [TypeOrmModule.forFeature([PurchaseReturnInvoiceEntity, PurchaseReturnInvoiceItemEntity])],
  providers: [PurchaseReturnsService],
  controllers: [PurchaseReturnsController],
  exports: [PurchaseReturnsService],
})
export class PurchasesReturnModule {}
