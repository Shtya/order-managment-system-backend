import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderEntity, OrderStatus } from 'entities/order.entity';
import { NotificationType } from 'entities/notifications.entity';
import { Repository, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { NotificationService } from '../notifications/notification.service';

@Injectable()
export class OrderPostponedCronService {
  private readonly logger = new Logger(OrderPostponedCronService.name);

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    private readonly notificationService: NotificationService,
  ) { }

  @Cron(CronExpression.EVERY_HOUR)
  async handlePostponedNotifications() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 1. Notification for TODAY (postponed date reached)
    const ordersDueToday = await this.orderRepo.find({
      where: {
        status: { code: OrderStatus.POSTPONED } as any,
        postponedDate: LessThanOrEqual(now),
        postponedNotificationSent: false,
      },
      relations: ['status'],
    });

    for (const order of ordersDueToday) {
      await this.notificationService.create({
        userId: order.adminId,
        type: NotificationType.ORDER_POSTPONED_REMINDER,
        title: 'Postponed Order Due',
        message: `Order #${order.orderNumber} is scheduled for today.`,
        relatedEntityType: 'order',
        relatedEntityId: order.id,
      });
      order.postponedNotificationSent = true;
      await this.orderRepo.save(order);
      this.logger.log(`Sent today's reminder for postponed order #${order.orderNumber}`);
    }

    // 2. Notification for REMINDER DAYS BEFORE
    const ordersWithReminders = await this.orderRepo
      .createQueryBuilder('o')
      .leftJoinAndSelect('o.status', 'status')
      .where('status.code = :status', {
        status: OrderStatus.POSTPONED,
      })
      .andWhere('o."reminderNotificationSent" = false')
      .andWhere('o."reminderDaysBefore" >= 0')
      .andWhere('o."postponedDate" IS NOT NULL')

      // Core logic:
      .andWhere(`
    NOW() >= (
      o."postponedDate"
      - (o."reminderDaysBefore" * INTERVAL '1 day')
    )
  `)

      .getMany();
    for (const order of ordersWithReminders) {
      if (!order.reminderDaysBefore || !order.postponedDate) continue;

      const reminderDate = new Date(order.postponedDate);
      reminderDate.setDate(reminderDate.getDate() - order.reminderDaysBefore);

      if (now >= reminderDate) {
        await this.notificationService.create({
          userId: order.adminId,
          type: NotificationType.ORDER_POSTPONED_REMINDER,
          title: 'Postponed Order Reminder',
          message: `Reminder for postponed order #${order.orderNumber} (${order.reminderDaysBefore} days before).`,
          relatedEntityType: 'order',
          relatedEntityId: order.id,
        });
        order.reminderNotificationSent = true;
        await this.orderRepo.save(order);
        this.logger.log(`Sent custom reminder for postponed order #${order.orderNumber}`);
      }
    }

    // 3. Notification for TOMORROW (one day before)
    const ordersDueTomorrow = await this.orderRepo.find({
      where: {
        status: { code: OrderStatus.POSTPONED } as any,
        postponedDate: LessThanOrEqual(new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000)), // Within next 24h
        oneDayBeforeNotificationSent: false,
      },
      relations: ['status'],
    });

    for (const order of ordersDueTomorrow) {
      await this.notificationService.create({
        userId: order.adminId,
        type: NotificationType.ORDER_POSTPONED_REMINDER,
        title: 'Postponed Order Reminder',
        message: `Order #${order.orderNumber} is scheduled for tomorrow.`,
        relatedEntityType: 'order',
        relatedEntityId: order.id,
      });
      order.oneDayBeforeNotificationSent = true;
      await this.orderRepo.save(order);
      this.logger.log(`Sent one-day-before reminder for postponed order #${order.orderNumber}`);
    }
  }
}
