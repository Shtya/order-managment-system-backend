import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role, User } from 'entities/user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { Plan, Subscription } from '../../entities/plans.entity';
import { SubscriptionsModule } from 'src/subscription/subscription.module';

@Module({
  imports: [forwardRef(() => SubscriptionsModule), TypeOrmModule.forFeature([User, Role, Plan, Subscription])],
  providers: [UsersService],
  controllers: [UsersController],
})
export class UsersModule { }
