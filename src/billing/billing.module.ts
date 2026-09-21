import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  BillingAllowanceUsageEntity,
  BillingAuthorizationEntity,
  BillingChargeEntity,
} from "entities/billing.entity";
import { AdminSettingsModule } from "src/admin-settings/admin-settings.module";
import { AllowanceService } from "./allowance/allowance.service";
import { BillingService } from "./billing.service";
import { BillingExpirySweeper } from "./billing-expiry.sweeper";
import {
  billingOperationProviders,
  BillingOperationRegistry,
} from "./operations/billing-operation.registry";
import { WalletModule } from "src/wallet/wallet.module";

@Module({
  imports: [
    AdminSettingsModule,
    WalletModule,
    TypeOrmModule.forFeature([
      BillingAuthorizationEntity,
      BillingChargeEntity,
      BillingAllowanceUsageEntity,
    ]),
  ],
  providers: [
    ...billingOperationProviders,
    BillingOperationRegistry,
    AllowanceService,
    BillingService,
    BillingExpirySweeper,
  ],
  exports: [BillingOperationRegistry, BillingService],
})
export class BillingModule {}
