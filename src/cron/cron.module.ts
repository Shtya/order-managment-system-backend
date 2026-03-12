import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentSessionEntity } from 'entities/payments.entity';
import { Subscription, UserFeature } from 'entities/plans.entity';
import { ExpiryCronService } from './ExpiryCronService';

@Module({
  imports: [
    // We only provide the repositories needed for the background tasks here
    TypeOrmModule.forFeature([
      PaymentSessionEntity,
      Subscription,
      UserFeature
    ]),
  ],
  providers: [ExpiryCronService],
  exports: [ExpiryCronService], // Export if you need it elsewhere, otherwise keep it private
})
export class CronModule { }