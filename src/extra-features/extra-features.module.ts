import { forwardRef, Module } from '@nestjs/common';
import { ExtraFeaturesService } from './extra-features.service';
import { ExtraFeaturesController } from './extra-features.controller';
import { TransactionsModule } from 'src/transactions/transactions.module';
import { PaymentsModule } from 'src/payments/payments.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionEntity } from 'entities/payments.entity';
import { User } from 'entities/user.entity';
import { Feature, UserFeature } from 'entities/plans.entity';
import { FeatureSeedService } from './feature-seed.service';

@Module({
  imports: [
    forwardRef(() => TransactionsModule),
    forwardRef(() => PaymentsModule),
    TypeOrmModule.forFeature([
      TransactionEntity,
      User,
      UserFeature,
      Feature
    ]),
  ],
  controllers: [ExtraFeaturesController],
  providers: [ExtraFeaturesService, FeatureSeedService],
})
export class ExtraFeaturesModule { }
