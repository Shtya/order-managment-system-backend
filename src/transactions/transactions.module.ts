import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { Plan, Transaction } from 'entities/plans.entity';
import { User } from 'entities/user.entity';

@Module({
	imports: [TypeOrmModule.forFeature([Plan, Transaction, User])],
	providers: [TransactionsService],
	controllers: [TransactionsController],
	exports: [TransactionsService],
})
export class TransactionsModule { }
