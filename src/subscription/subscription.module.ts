import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Plan, Subscription, UserFeature } from 'entities/plans.entity';
import { User } from 'entities/user.entity';
import { SubscriptionsService } from './subscription.service';
import { SubscriptionsController } from './subscription.controller';
import { TransactionsModule } from 'src/transactions/transactions.module';
import { TransactionEntity } from 'entities/payments.entity';
import { PaymentsModule } from 'src/payments/payments.module';


@Module({
    imports: [
        forwardRef(() => TransactionsModule),
        forwardRef(() => PaymentsModule),
        TypeOrmModule.forFeature([
            Subscription,
            TransactionEntity,
            User,
            Plan,
            UserFeature
        ]),
    ],
    providers: [SubscriptionsService],
    controllers: [SubscriptionsController],
    exports: [SubscriptionsService],
})
export class SubscriptionsModule { }