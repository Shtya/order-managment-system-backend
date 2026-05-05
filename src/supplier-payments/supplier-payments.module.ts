import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SupplierPaymentsService } from './supplier-payments.service';
import { SupplierPaymentsController } from './supplier-payments.controller';
import { SupplierPaymentEntity, SupplierPaymentAllocationEntity } from 'entities/supplier_payments.entity';
import { SupplierEntity } from 'entities/supplier.entity';
import { PurchaseInvoiceEntity } from 'entities/purchase.entity';
import { Account } from 'entities/safe.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SupplierPaymentEntity,
      SupplierPaymentAllocationEntity,
      SupplierEntity,
      PurchaseInvoiceEntity,
      Account
    ])
  ],
  controllers: [SupplierPaymentsController],
  providers: [SupplierPaymentsService],
})
export class SupplierPaymentsModule { }
