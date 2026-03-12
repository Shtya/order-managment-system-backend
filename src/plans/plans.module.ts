import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from 'entities/user.entity';
import { PlansService } from './plans.service';
import { PlansController } from './plans.controller';
import { Plan, Subscription } from '../../entities/plans.entity';
import { TransactionEntity } from 'entities/payments.entity';

@Module({
	imports: [TypeOrmModule.forFeature([Plan, Subscription, TransactionEntity, User])],
	providers: [PlansService],
	controllers: [PlansController],
	exports: [PlansService],
})
export class PlansModule { }
