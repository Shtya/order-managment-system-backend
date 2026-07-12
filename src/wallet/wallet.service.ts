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
import { RequestTranslationService, TranslationService } from "common/translation.service";
import { tenantId } from "src/category/category.service";

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
    private translations: TranslationService,
    private requestTranslations: RequestTranslationService,
  ) { }

  private isSuperAdmin(me: User) {
    return me.role?.name === SystemRole.SUPER_ADMIN;
  }

  // ✅ Check if user is admin
  private isAdmin(me: User) {
    return me.role?.name === SystemRole.ADMIN;
  }

  // 1️⃣ Get or Create Wallet (For Admins)
  async getOrCreateWallet(userId: string, manager?: EntityManager) {
    const repo = manager ? manager.getRepository(Wallet) : this.walletRepo;
    let wallet = await repo.findOne({ where: { userId } });
    if (!wallet) {
      wallet = repo.create({
        userId,
        currentBalance: 0,
        totalCharged: 0,
        totalWithdrawn: 0,
      });
      wallet = await repo.save(wallet);
    }
    return wallet;
  }

  // 1️⃣ Get or Create Wallet (For Specific User ID)
  async getOrCreateWalletSuper(me: any, userId: string) {
    if (!this.isSuperAdmin(me)) {
      throw new ForbiddenException(this.translations.t("common.permission_denied"));
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

  // 2️⃣ Apply Wallet Top Up (Shared logic)
  async applyWalletTopUp(userId: string, amount: number, manager: EntityManager) {
    const wallet = await this.getOrCreateWallet(userId, manager);

    wallet.currentBalance = Number(wallet.currentBalance) + amount;
    wallet.totalCharged = Number(wallet.totalCharged) + amount;

    await manager.save(wallet);
    return wallet;
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
        this.translations.t("common.permission_denied"),
      );
    }

    return await this.dataSource.transaction(async (manager) => {
      const wallet = await this.getOrCreateWallet(targetUserId);

      // Update logic
      const newBalance = Number(wallet.currentBalance) + amount;
      if (newBalance < 0)
        throw new BadRequestException(this.translations.t("common.resulting_balance_cannot_be_negative"));

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
        amountInDollars: amount,
        purpose: amount > 0 ? PaymentPurposeEnum.WALLET_TOP_UP : PaymentPurposeEnum.WALLET_WITHDRAWAL,
        status: TransactionStatus.SUCCESS,
        paymentMethod: TransactionPaymentMethod.MANUAL_ADJUSTMENT,
        number: number,
        notes: note.trim(),
      });
      await manager.save(transaction);

      return wallet;
    });
  }

  async processOrderUsage(
    me: any,
    numberOfOrders: number,
    manager?: EntityManager,
    orderNumber?: string,
    orderId?: string,
  ) {
    const adminId = tenantId(me);
    const work = async (m: EntityManager) => {
      try {
        const activeSubscription =
          await this.subscriptionsService.getMyActiveSubscription(me, m);

        const wallet = await this.getOrCreateWallet(me.id, m);

        if (!activeSubscription) {
          throw new BadRequestException(
            this.translations.t(
              "domains.subscriptions.no_active_subscription_found",
            ),
          );
        }

        const limit = activeSubscription.includedOrders;
        const currentUsed = Number(activeSubscription.usedOrders || 0);
        const newTotalUsed = currentUsed + numberOfOrders;

        let transaction = null;

        if (limit !== null) {
          const allowedLimit = Number(limit);

          let extraOrders = 0;

          if (newTotalUsed > allowedLimit) {
            const alreadyExceededBefore = Math.max(
              0,
              currentUsed - allowedLimit,
            );
            const totalExceededNow = newTotalUsed - allowedLimit;
            extraOrders = totalExceededNow - alreadyExceededBefore;
          }

          if (extraOrders > 0) {
            if (
              activeSubscription.extraOrderFee === null ||
              activeSubscription.extraOrderFee === undefined
            ) {
              throw new BadRequestException(
                this.translations.t(
                  "domains.subscriptions.additional_orders_not_enabled",
                ),
              );
            }

            const cost =
              extraOrders * Number(activeSubscription.extraOrderFee);
            const currentBalance = Number(wallet.currentBalance);

            if (currentBalance < cost) {
              throw new BadRequestException(
                this.translations.t(
                  "domains.subscriptions.insufficient_wallet_balance_for_extra_orders",
                ),
              );
            }

            wallet.currentBalance = currentBalance - cost;
            wallet.totalWithdrawn =
              Number(wallet.totalWithdrawn) + cost;

            const number =
              await this.transactionsService.generateTransactionNumber(
                wallet.userId?.toString(),
              );
              
        
            transaction = m.create(TransactionEntity, {
              userId: me.id,
              amount: cost,
              currency: "USD",
              amountInDollars: cost,
              purpose: PaymentPurposeEnum.WALLET_WITHDRAWAL,
              status: TransactionStatus.SUCCESS,
              paymentMethod: TransactionPaymentMethod.OTHER,
              number,
              orderId,
              notes: await this.requestTranslations.tAsync(
                "domains.subscriptions.auto_deduction_for_extra_orders",
                adminId,
                {
                  args: {
                    extraOrders,
                    orderNumber: orderNumber || "—",
                  },
                },
              ),
            });

            await m.save(transaction);
          }
        }

        activeSubscription.usedOrders = newTotalUsed;

        await m.save(activeSubscription);
        await m.save(wallet);

        return {
          wallet,
          subscription: activeSubscription,
          transaction,
        };
      } catch (error) {
        await this.notificationService.create({
          userId: me.id,
          type: NotificationType.ORDER_USAGE_FAILED,
          title: await this.requestTranslations.tAsync(
            "domains.subscriptions.order_usage_failed",
            adminId,
          ),
          message: await this.requestTranslations.tAsync(
            "domains.subscriptions.failed_to_process_order_usage",
            adminId,
            {
              args: {
                error: error.message,
              },
            },
          ),
        });

        throw error;
      }
    };

    if (manager) return work(manager);
    return await this.dataSource.transaction(work);
  }
}
