import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import * as crypto from 'crypto';
import { PaymentProvider, PaymentProviderEnum, PaymentPurposeEnum, PaymentSessionEntity, PaymentSessionStatusEnum, TransactionEntity, TransactionStatus, Wallet, WebhookEvents } from 'entities/payments.entity';
import queryString from 'query-string';
import { KashierProvider } from './providers/kashierProvider';
import { TransactionsService } from 'src/transactions/transactions.service';
import { PlanDuration, Subscription, SubscriptionStatus, UserFeature } from 'entities/plans.entity';
import { SubscriptionUtils } from 'common/healpers';
import { Notification, NotificationType } from 'entities/notifications.entity';
import { SystemRole, User } from 'entities/user.entity';

@Injectable()
export class PaymentsService {
    private readonly logger = new Logger(PaymentsService.name);

    constructor(
        @InjectRepository(WebhookEvents)
        private readonly webhookEventRepo: Repository<WebhookEvents>,
        @InjectRepository(TransactionEntity) private readonly transactionRepo: Repository<TransactionEntity>,

        @InjectRepository(PaymentSessionEntity)
        private readonly sessionRepo: Repository<PaymentSessionEntity>,
        private readonly dataSource: DataSource, // For transaction manager
        private readonly kashierProvider: KashierProvider,
        private readonly transactionsService: TransactionsService,
    ) { }


    private isSuperAdmin(me: User) {
        return me.role?.name === SystemRole.SUPER_ADMIN;
    }

    // ✅ Check if user is admin
    private isAdmin(me: User) {
        return me.role?.name === SystemRole.ADMIN;
    }
    // Helper to get the correct provider instance
    private getProvider(name: PaymentProviderEnum): PaymentProvider {
        if (name === PaymentProviderEnum.KASHIER) return this.kashierProvider;
        throw new Error(`Provider ${name} not supported`);
    }

    async processWebhook(providerName: PaymentProviderEnum, headers: any, body: any) {
        const provider = this.getProvider(providerName);

        // 1. Generic Signature Validation
        if (!provider.verifyWebhookSignature(headers, body)) {
            throw new Error(`Invalid signature for ${providerName}`);
        }

        const webhookData = provider.parseWebhookPayload(body);

        // 2. Idempotency Check
        const alreadyProcessed = await this.webhookEventRepo.findOne({
            where: { provider: providerName, externalTransactionId: webhookData.externalTransactionId, status: PaymentSessionStatusEnum.SUCCESS }
        });
        if (alreadyProcessed) {
            this.logger.log(`Webhook already processed for session: ${alreadyProcessed.id}`);
            return;
        }

        // 3. Log Webhook
        await this.webhookEventRepo.save({
            provider: providerName,
            externalTransactionId: webhookData.externalTransactionId,
            status: webhookData.status,
            payload: body
        });

        // 4. Update Session and Business Logic
        const session = await this.sessionRepo.findOne({ where: { id: webhookData.internalSessionId }, relations: ['user'] });
        if (!session) return;

        await this.dataSource.transaction(async (manager) => {
            session.status = webhookData.status;
            session.externalSessionId = webhookData.externalTransactionId;
            await manager.save(session);

            const number = await this.transactionsService.generateTransactionNumber(session.userId?.toString())

            const transaction = manager.create(TransactionEntity, {
                number, // Provider's external ID
                userId: session.userId,
                sessionId: session.id,
                purpose: session.purpose,
                subscriptionId: session.subscriptionId ? session.subscriptionId : null,
                userFeatureId: session.userFeatureId ? session.userFeatureId : null,
                amount: session.amount,
                status: this.mapToTransactionStatus(webhookData.status),
                paymentMethod: webhookData.paymentMethod,
            });
            await manager.save(transaction);

            if (webhookData.status === PaymentSessionStatusEnum.SUCCESS) {
                await this.handlePaymentSuccessLogic(session, transaction, manager);
            } else {
                await this.handlePaymentFailLogic(session, transaction, manager);

            }
        });
    }

    private mapToTransactionStatus(status: PaymentSessionStatusEnum): TransactionStatus {
        switch (status) {
            case PaymentSessionStatusEnum.SUCCESS: return TransactionStatus.SUCCESS;
            case PaymentSessionStatusEnum.FAILED: return TransactionStatus.FAILED;
            case PaymentSessionStatusEnum.CANCELLED: return TransactionStatus.CANCELLED;
            default: return TransactionStatus.PENDING;
        }
    }

    public async handlePaymentFailLogic(
        session: PaymentSessionEntity,
        transaction: TransactionEntity,
        manager: EntityManager
    ) {
        let itemName = 'Payment';
        let relatedEntityType = 'transactions';
        let relatedEntityId = String(transaction.id);

        switch (session.purpose) {
            case PaymentPurposeEnum.SUBSCRIPTION_PAYMENT:
                itemName = 'Subscription';
                relatedEntityType = 'subscriptions';
                relatedEntityId = String(session.subscriptionId);
                break;
            case PaymentPurposeEnum.FEATURE_PURCHASE:
                itemName = 'Add-on Feature';
                relatedEntityType = 'userFeatures';
                relatedEntityId = String(session.userFeatureId);
                break;
            case PaymentPurposeEnum.WALLET_TOP_UP:
                itemName = 'Wallet Top-up';
                relatedEntityType = 'wallet';
                relatedEntityId = String(session.userId);
                break;
        }

        // 3. Send Notification in English
        await manager.save(Notification, {
            userId: session.userId,
            type: NotificationType.PAYMENT_FAILED,
            title: 'Payment Failed',
            message: `Sorry, the payment of ${session.amount} ${session.currency} for ${itemName} was not successful. Please try again.`,
            relatedEntityType: relatedEntityType,
            relatedEntityId: relatedEntityId,
        });
    }

    public async handlePaymentSuccessLogic(
        session: PaymentSessionEntity,
        transaction: TransactionEntity,
        manager: EntityManager
    ) {
        const notificationPromises = [];
        const paidAmount = Number(transaction.amount);
        const requiredAmount = Number(session.amount);

        // 1️⃣ Helper to redirect funds to wallet if the amount is insufficient
        const redirectToWallet = async (reason: string) => {
            await this.applyWalletTopUp(manager, session.userId, paidAmount);

            // Update transaction and session to reflect the change
            transaction.purpose = PaymentPurposeEnum.WALLET_TOP_UP;
            transaction.notes = reason;
            await manager.save(transaction);

            notificationPromises.push(
                manager.save(Notification, {
                    userId: session.userId,
                    type: NotificationType.WALLET_CREDIT,
                    title: 'Payment Credited to Wallet',
                    message: `Your payment of ${paidAmount} ${session.currency} was added to your wallet balance. Reason: ${reason}`,
                    relatedEntityType: 'wallet',
                    relatedEntityId: String(session.userId),
                })
            );
        };

        switch (session.purpose) {
            case PaymentPurposeEnum.SUBSCRIPTION_PAYMENT:
                if (paidAmount < requiredAmount) {
                    await redirectToWallet('Insufficient amount for subscription.');
                    break;
                }

                const sub = await manager.findOne(Subscription, {
                    where: { id: session.subscriptionId },
                    relations: ['plan']
                });

                if (sub && sub.status === SubscriptionStatus.PENDING) {
                    const hasActive = await manager.findOne(Subscription, {
                        where: { userId: session.userId, status: SubscriptionStatus.ACTIVE }
                    });

                    if (!hasActive) {
                        const now = new Date();
                        sub.status = SubscriptionStatus.ACTIVE;
                        sub.startDate = now;
                        sub.endDate = SubscriptionUtils.calculateEndDate(now, sub.plan.duration, sub.plan.durationIndays);
                        await manager.save(sub);
                        const expiryText = sub.endDate ? ` until ${sub.endDate.toLocaleDateString()}` : '';
                        notificationPromises.push(
                            manager.save(Notification, {
                                userId: session.userId,
                                type: NotificationType.SUBSCRIPTION_ACTIVATED,
                                title: `Subscription Active: ${sub.plan.name}`,
                                message: `Your ${sub.plan.name} (${sub.planType}) plan is now active${expiryText}.`,
                                relatedEntityType: 'Subscription',
                                relatedEntityId: String(sub.id),
                            })
                        );
                    } else {
                        await redirectToWallet('You already has active subscription.');
                    }
                }
                break;

            case PaymentPurposeEnum.FEATURE_PURCHASE:
                if (paidAmount < requiredAmount) {
                    await redirectToWallet('Insufficient amount for feature purchase.');
                    break;
                }

                const userFeat = await manager.findOne(UserFeature, {
                    where: { id: session.userFeatureId },
                    relations: ['feature']
                });

                if (userFeat && userFeat.status === SubscriptionStatus.PENDING) {
                    userFeat.status = SubscriptionStatus.ACTIVE;
                    userFeat.startDate = new Date();
                    // Features follow a standard 30-day month logic
                    await manager.save(userFeat);
                    notificationPromises.push(
                        manager.save(Notification, {
                            userId: session.userId,
                            type: NotificationType.FEATURE_ACTIVATED,
                            title: `Add-on Ready: ${userFeat.feature.name}`,
                            message: `The ${userFeat.feature.name} feature has been successfully activated.`,
                            relatedEntityType: 'UserFeature',
                            relatedEntityId: String(userFeat.id),
                        })
                    );
                } else {
                    await redirectToWallet('This feature is already active or the purchase session has expired.');
                }
                break;

            case PaymentPurposeEnum.WALLET_TOP_UP:
                await this.applyWalletTopUp(manager, session.userId, paidAmount);

                notificationPromises.push(
                    manager.save(Notification, {
                        userId: session.userId,
                        type: NotificationType.WALLET_TOP_UP,
                        title: 'Wallet Balance Updated',
                        message: `Successfully added ${paidAmount} ${session.currency} to your wallet. Your new balance is ready to use.`,
                        relatedEntityType: 'Wallet',
                        relatedEntityId: String(session.userId),
                    })
                );
                break;
        }

        // Execute all notifications after database changes are finalized
        if (notificationPromises.length > 0) {
            await Promise.all(notificationPromises);
        }
    }

    /**
     * Shared logic to handle the actual wallet balance increment
     */
    private async applyWalletTopUp(manager: EntityManager, userId: string, amount: number) {
        let wallet = await manager.findOne(Wallet, { where: { userId } });
        if (!wallet) {
            wallet = manager.create(Wallet, { userId, currentBalance: 0, totalCharged: 0, totalWithdrawn: 0 });
        }

        wallet.currentBalance = Number(wallet.currentBalance) + amount;
        wallet.totalCharged = Number(wallet.totalCharged) + amount;

        await manager.save(wallet);
    }

    async processRedirect(providerName: PaymentProviderEnum, query: any) {
        const provider = this.getProvider(providerName);

        // Parse the query parameters using the specific provider's logic
        const { status, sessionId } = provider.parseRedirectQuery(query);

        if (!sessionId) {
            this.logger.warn(`Redirect query missing session ID for provider ${providerName}`);
        }

        return { status, sessionId };
    }

    async getPaymentSessionById(me: any, id: string) {


        const session = await this.sessionRepo.createQueryBuilder('session')
            // 1. Load User Details
            .leftJoinAndSelect('session.user', 'user')
            .leftJoinAndSelect('user.role', 'role') // التصحيح هنا: نربط الدور من خلال علاقة المستخدم

            // 2. ربط الاشتراك والخطة
            .leftJoinAndSelect('session.subscription', 'sub')
            .leftJoinAndSelect('sub.plan', 'plan')

            // 3. ربط الميزات المشتراة (تكملة الجزء المقطوع)
            .leftJoinAndSelect('session.userFeature', 'userFeature')
            .leftJoinAndSelect('userFeature.feature', 'feature')
            .select([
                'session',
                'user.id', 'user.name', 'user.email', 'user.onboardingStatus',
                'role.id', 'role.name',
                'sub', 'plan',
                'userFeature', 'feature'
            ])
            .where('session.id = :id', { id })
            .getOne();

        if (!session) {
            throw new NotFoundException(`Payment session with ID ${id} not found`);
        }
        const isOwner = session.userId === me.id;
        if (!this.isSuperAdmin(me) && !isOwner) {
            throw new ForbiddenException('You do not have permission');
        }

        return session; return session;
    }
}