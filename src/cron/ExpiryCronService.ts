import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { PaymentSessionEntity, PaymentSessionStatusEnum } from 'entities/payments.entity';
import { Subscription, SubscriptionStatus } from 'entities/plans.entity';
import { LessThan, Repository, Not } from 'typeorm';


@Injectable()
export class ExpiryCronService {
    private readonly logger = new Logger(ExpiryCronService.name);

    constructor(
        @InjectRepository(PaymentSessionEntity)
        private readonly sessionRepo: Repository<PaymentSessionEntity>,
        @InjectRepository(Subscription)
        private readonly subRepo: Repository<Subscription>,
    ) { }

    /**
     * Task 1: Expire Payment Sessions
     * Runs every 5 minutes
     */
    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    async handlePaymentSessionExpiry() {
        const now = new Date();

        const result = await this.sessionRepo
            .createQueryBuilder()
            .update(PaymentSessionEntity)
            .set({ status: PaymentSessionStatusEnum.EXPIRED })
            .where('status = :status', { status: PaymentSessionStatusEnum.PENDING })
            .andWhere('expireAt < :now', { now })
            .execute();

        if (result.affected > 0) {
            this.logger.log(`Expired ${result.affected} payment sessions.`);
        }
    }

    /**
     * Task 2: Expire Subscriptions
     * Runs every hour (or at midnight)
     */
    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    async handleSubscriptionExpiry() {
        const now = new Date();

        const result = await this.subRepo
            .createQueryBuilder()
            .update(Subscription)
            .set({ status: SubscriptionStatus.EXPIRED })
            .where('status = :status', { status: SubscriptionStatus.ACTIVE })
            .andWhere('endDate IS NOT NULL')
            .andWhere('endDate < :now', { now })
            .execute();

        if (result.affected > 0) {
            this.logger.log(`Marked ${result.affected} subscriptions as EXPIRED.`);
        }
    }
}