import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Plan, Subscription } from 'entities/plans.entity';
import { User } from 'entities/user.entity';
import { Transaction } from 'typeorm';
import { SubscriptionsService } from './subscription.service';
import { SubscriptionsController } from './subscription.controller';
import { TransactionsModule } from 'src/transactions/transactions.module';


@Module({
    imports: [
        TypeOrmModule.forFeature([
            Subscription,
            User,
            Plan,
        ]),
    ],
    providers: [SubscriptionsService],
    controllers: [SubscriptionsController],
    exports: [SubscriptionsService],
})
export class SubscriptionsModule { }