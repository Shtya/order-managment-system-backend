import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { Plan } from 'entities/plans.entity';
import { User } from 'entities/user.entity';
import { TransactionEntity } from 'entities/payments.entity';

@Module({

	imports: [TypeOrmModule.forFeature([Plan, TransactionEntity, User])],
	providers: [TransactionsService],
	controllers: [TransactionsController],
	exports: [TransactionsService],
})
export class TransactionsModule { }
