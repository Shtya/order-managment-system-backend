import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from 'entities/user.entity';
import { PlansService } from './plans.service';
import { PlansController } from './plans.controller';
import { Plan, Transaction } from '../../entities/plans.entity';

@Module({
	imports: [TypeOrmModule.forFeature([Plan, Transaction, User])],
	providers: [PlansService],
	controllers: [PlansController],
	exports: [PlansService],
})
export class PlansModule { }
