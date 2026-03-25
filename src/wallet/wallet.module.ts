import { forwardRef, Module } from "@nestjs/common";
import { WalletService } from "./wallet.service";
import { WalletController } from "./wallet.controller";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TransactionEntity, Wallet } from "entities/payments.entity";
import { User } from "entities/user.entity";
import { PaymentsModule } from "src/payments/payments.module";
import { TransactionsModule } from "src/transactions/transactions.module";
import { SubscriptionsModule } from "src/subscription/subscription.module";

@Module({
  imports: [
    forwardRef(() => PaymentsModule),
    forwardRef(() => TransactionsModule),
    forwardRef(() => SubscriptionsModule),
    TypeOrmModule.forFeature([TransactionEntity, User, Wallet]),
  ],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
