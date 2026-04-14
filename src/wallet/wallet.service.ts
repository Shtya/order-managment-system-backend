import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { defaultCurrency } from "common/healpers";
import { NotificationService } from "src/notifications/notification.service";
import { NotificationType } from "entities/notifications.entity";
import {
  PaymentPurposeEnum,
  TransactionEntity,
  TransactionPaymentMethod,
  TransactionStatus,
  Wallet,
} from "entities/payments.entity";
import { SystemRole, User } from "entities/user.entity";
import { PaymentFactoryService } from "src/payments/providers/PaymentFactoryService";
import { SubscriptionsService } from "src/subscription/subscription.service";
import { TransactionsService } from "src/transactions/transactions.service";
import { DataSource, EntityManager, Repository } from "typeorm";

@Injectable()
export class WalletService {
  constructor(
    @InjectRepository(Wallet) private walletRepo: Repository<Wallet>,
    @Inject(forwardRef(() => TransactionsService))
    private transactionsService: TransactionsService,
    @Inject(forwardRef(() => PaymentFactoryService))
    private paymentFactory: PaymentFactoryService,

    @Inject(forwardRef(() => SubscriptionsService))
    private subscriptionsService: SubscriptionsService,
    private dataSource: DataSource,
    private notificationService: NotificationService,
  ) { }

  private isSuperAdmin(me: User) {
    return me.role?.name === SystemRole.SUPER_ADMIN;
  }

  // ✅ Check if user is admin
  private isAdmin(me: User) {
    return me.role?.name === SystemRole.ADMIN;
  }

  // 1️⃣ Get or Create Wallet (For Admins)
  async getOrCreateWallet(userId: string) {
    let wallet = await this.walletRepo.findOne({ where: { userId } });
    if (!wallet) {
      wallet = this.walletRepo.create({
        userId,
        currentBalance: 0,
        totalCharged: 0,
        totalWithdrawn: 0,
      });
      wallet = await this.walletRepo.save(wallet);
    }
    return wallet;
  }

  // 1️⃣ Get or Create Wallet (For Specific User ID)
  async getOrCreateWalletSuper(me: any, userId: string) {
    if (!this.isSuperAdmin(me)) {
      throw new ForbiddenException("You do not have permission");
    }

    const wallet = await this.getOrCreateWallet(userId);

    return wallet;
  }

  // 2️⃣ Top Up Wallet (Generates Payment Session)
  async topUp(user: User, amount: number) {
    const provider = this.paymentFactory.getProviderByCurrency(defaultCurrency);
    return await this.dataSource.transaction(async (manager) => {
      return await provider.checkout({
        amount,
        currency: defaultCurrency,
        userId: user.id,
        purpose: PaymentPurposeEnum.WALLET_TOP_UP,
        manager,
      });
    });
  }

  // 3️⃣ Manual Control (Super Admin only)
  async adjustBalance(
    superAdmin: User,
    targetUserId: string,
    amount: number,
    note: string,
  ) {
    if (superAdmin.role?.name !== SystemRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        "Only Super Admins can adjust balances manually",
      );
    }

    return await this.dataSource.transaction(async (manager) => {
      const wallet = await this.getOrCreateWallet(targetUserId);

      // Update logic
      const newBalance = Number(wallet.currentBalance) + amount;
      if (newBalance < 0)
        throw new BadRequestException("Resulting balance cannot be negative");

      wallet.currentBalance = newBalance;
      if (amount > 0)
        wallet.totalCharged = Number(wallet.totalCharged) + amount;
      else
        wallet.totalWithdrawn =
          Number(wallet.totalWithdrawn) + Math.abs(amount);

      await manager.save(wallet);

      const number = await this.transactionsService.generateTransactionNumber(
        wallet.userId?.toString(),
      );
      // Record transaction
      const transaction = manager.create(TransactionEntity, {
        userId: targetUserId,
        amount: amount,
        purpose: PaymentPurposeEnum.WALLET_WITHDRAWAL, // Or add ADMIN_ADJUSTMENT to enum
        status: TransactionStatus.SUCCESS,
        paymentMethod: TransactionPaymentMethod.MANUAL_ADJUSTMENT,
        number: number,
        note: note.trim(),
      });
      await manager.save(transaction);

      return wallet;
    });
  }

  async processOrderUsage(
    me: any,
    numberOfOrders: number,
    manager?: EntityManager,
  ) {
    const work = async (m: EntityManager) => {
      try {
        const activeSubscription =
          await this.subscriptionsService.getMyActiveSubscription(me, m);
        const wallet = await this.getOrCreateWallet(me.id);

        if (!activeSubscription) {
          throw new BadRequestException("No active subscription found");
        }

        let remainingToProcess = numberOfOrders;
        const availableIncluded = activeSubscription.includedOrders || 0;

        if (availableIncluded >= remainingToProcess) {
          activeSubscription.includedOrders =
            availableIncluded - remainingToProcess;
          remainingToProcess = 0;
        } else {
          remainingToProcess -= availableIncluded;
          activeSubscription.includedOrders = 0;
        }

        if (remainingToProcess > 0) {
          if (
            activeSubscription.extraOrderFee === null ||
            activeSubscription.extraOrderFee === undefined
          ) {
            throw new BadRequestException(
              "You have used all included orders, and your current plan does not allow for additional orders.",
            );
          }

          const cost =
            remainingToProcess * Number(activeSubscription.extraOrderFee);
          const currentBalance = Number(wallet.currentBalance);

          if (currentBalance < cost) {
            throw new BadRequestException(
              "Insufficient wallet balance for extra orders",
            );
          }

          wallet.currentBalance = currentBalance - cost;
          wallet.totalWithdrawn = Number(wallet.totalWithdrawn) + cost;
        }
        activeSubscription.usedOrders +
          Number(activeSubscription.usedOrders) +
          numberOfOrders;
        await m.save(activeSubscription);
        await m.save(wallet);

        return {
          wallet,
          subscription: activeSubscription,
        };
      } catch (error) {
        await this.notificationService.create({
          userId: me.id,
          type: NotificationType.ORDER_USAGE_FAILED,
          title: "Order Usage Failed",
          message: `Failed to process order usage for ${numberOfOrders} orders: ${error.message}`,
        });
        throw error;
      }
    };

    if (manager) return work(manager);
    return await this.dataSource.transaction(work);
  }
}
