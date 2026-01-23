import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role, User } from 'entities/user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { Plan } from '../../entities/plans.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, Role, Plan])],
  providers: [UsersService],
  controllers: [UsersController],
})
export class UsersModule {}
