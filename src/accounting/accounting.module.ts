import { Module } from '@nestjs/common';
import { AccountingService } from './services/accounting.service';
import { AccountingController } from './controllers/accounting.controller';
import { ExpensesService } from './services/expenses.service';
import { ExpensesController } from './controllers/expenses.controller';
import { ExpenseCategoriesService } from './services/expense-categories.service';
import { ExpenseCategoriesController } from './controllers/expense-categories.controller';
import { ManualExpenseCategoryEntity, ManualExpenseEntity, SupplierClosingEntity, MonthlyClosingEntity } from 'entities/accounting.entity';
import { PurchaseReturnInvoiceEntity } from 'entities/purchase_return.entity';
import { PurchaseInvoiceEntity } from 'entities/purchase.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEntity, OrderStatusEntity } from 'entities/order.entity';
import { SupplierEntity } from 'entities/supplier.entity';
import { ShipmentEntity } from 'entities/shipping.entity';
import { MonthlyClosingService } from './services/monthly-closing.service';
import { MonthlyClosingController } from './controllers/monthly-closing.controller';

@Module({
  imports: [TypeOrmModule.forFeature([PurchaseInvoiceEntity, PurchaseReturnInvoiceEntity, ManualExpenseEntity, OrderEntity,
    ManualExpenseCategoryEntity, SupplierClosingEntity, SupplierEntity, ShipmentEntity, MonthlyClosingEntity, OrderStatusEntity])],
  controllers: [AccountingController, ExpensesController, ExpenseCategoriesController, MonthlyClosingController],
  providers: [AccountingService, ExpensesService, ExpenseCategoriesService, MonthlyClosingService],
})
export class AccountingModule { }
