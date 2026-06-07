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
import { CitiesSyncService } from 'src/cities/cities-sync.logic';
import { CityEntity, ProviderLocationEntity } from 'entities/cities.entity';

@Module({
  imports: [
    // We only provide the repositories needed for the background tasks here
    TypeOrmModule.forFeature([
      PaymentSessionEntity,
      Subscription,
      UserFeature,
      OrphanFileEntity,
      OrderEntity,
      CityEntity,
      ProviderLocationEntity
    ]),
  ],
  controllers: [CronController],
  providers: [ExpiryCronService, OrphanFilesCleanupCronService, OrderPostponedCronService, CitiesSyncService],
  exports: [ExpiryCronService], // Export if you need it elsewhere, otherwise keep it private
})
export class CronModule { }