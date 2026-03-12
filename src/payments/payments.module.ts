import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PaymentFactoryService } from './providers/PaymentFactoryService';
import { KashierProvider } from './providers/kashierProvider';
import { PaymentSessionEntity, TransactionEntity, WebhookEvents, } from 'entities/payments.entity';
import { User } from 'entities/user.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionsModule } from 'src/transactions/transactions.module';
import { UserFeature } from 'entities/plans.entity';

@Module({
  imports: [TransactionsModule, TypeOrmModule.forFeature([WebhookEvents, TransactionEntity, User, PaymentSessionEntity, UserFeature])],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentFactoryService, KashierProvider],
  exports: [PaymentsService, PaymentFactoryService, KashierProvider],
})
export class PaymentsModule { }
