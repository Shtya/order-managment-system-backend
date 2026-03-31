import { forwardRef, Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company, Role, User } from 'entities/user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { Plan, Subscription } from '../../entities/plans.entity';
import { SubscriptionsModule } from 'src/subscription/subscription.module';

@Global()
@Module({
  imports: [forwardRef(() => SubscriptionsModule), TypeOrmModule.forFeature([User, Role, Plan, Subscription, Company])],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService]
})
export class UsersModule { }
