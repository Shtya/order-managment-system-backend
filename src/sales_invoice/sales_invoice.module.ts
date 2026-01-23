// sales-invoices/sales-invoices.module.ts
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm"; 
import { SalesInvoiceEntity, SalesInvoiceItemEntity } from "entities/sales_invoice.entity";
import { SalesInvoicesService } from "./sales_invoice.service";
import { SalesInvoicesController } from "./sales_invoice.controller";

@Module({
  imports: [TypeOrmModule.forFeature([SalesInvoiceEntity, SalesInvoiceItemEntity])],
  providers: [SalesInvoicesService],
  controllers: [SalesInvoicesController],
  exports: [SalesInvoicesService],
})
export class SalesInvoiceModule {}
