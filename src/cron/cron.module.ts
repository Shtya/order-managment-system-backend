import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentSessionEntity } from 'entities/payments.entity';
import { Subscription, UserFeature } from 'entities/plans.entity';
import { ExpiryCronService } from './ExpiryCronService';
import { OrphanFileEntity } from 'entities/files.entity';
import { OrphanFilesCleanupCronService } from './orphan-files-cleanup.cron';
import { OrderPostponedCronService } from './OrderPostponedCron.service';
import { OrderEntity } from 'entities/order.entity';
import { CronController } from './cronController';

@Module({
  imports: [
    // We only provide the repositories needed for the background tasks here
    TypeOrmModule.forFeature([
      PaymentSessionEntity,
      Subscription,
      UserFeature,
      OrphanFileEntity,
      OrderEntity,
    ]),
  ],
  controllers: [CronController],
  providers: [ExpiryCronService, OrphanFilesCleanupCronService, OrderPostponedCronService],
  exports: [ExpiryCronService], // Export if you need it elsewhere, otherwise keep it private
})
export class CronModule { }