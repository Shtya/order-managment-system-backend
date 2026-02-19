import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Notification } from 'entities/notifications.entity';
import { Brackets, Repository } from 'typeorm';

@Injectable()
export class NotificationService {

    constructor(
        @InjectRepository(Notification)
        private notificationRepo: Repository<Notification>,
    ) {

    }
    async list(me: any, q?: any) {
        const userId = me?.id; // Notifications are personal to the logged-in user

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();
        const isRead = q?.isRead !== undefined ? q.isRead === 'true' : undefined;

        const qb = this.notificationRepo
            .createQueryBuilder("n")
            .where("n.userId = :userId", { userId });

        // Filter by read/unread status
        if (isRead !== undefined) {
            qb.andWhere("n.isRead = :isRead", { isRead });
        }

        // Search in title or message
        if (search) {
            qb.andWhere(
                new Brackets((sq) => {
                    sq.where("n.title ILIKE :s", { s: `%${search}%` })
                        .orWhere("n.message ILIKE :s", { s: `%${search}%` });
                })
            );
        }

        // Sort: Unread first, then by date
        qb.orderBy("n.isRead", "ASC")
            .addOrderBy("n.createdAt", "DESC");

        const [records, total] = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getManyAndCount();

        return {
            total_records: total,
            current_page: page,
            per_page: limit,
            records,
        };
    }

    async markAsRead(userId: number, id: number) {
        // Check if notification exists and belongs to the user
        const notification = await this.notificationRepo.findOne({
            where: { id, userId }
        });

        if (!notification) {
            throw new NotFoundException("Notification not found or access denied");
        }

        return this.notificationRepo.update(id, { isRead: true });
    }

    async markAllAsRead(userId: number) {
        return this.notificationRepo.update(
            { userId, isRead: false }, // Filter: only unread ones for this user
            { isRead: true }           // Action: mark as read
        );
    }
    async getUnreadCount(userId: number) {
        // Fetch the user directly to get the cached count
        const count = await this.notificationRepo.count({
            where: { userId: Number(userId), isRead: false },
        });

        return {
            unreadCount: count || 0
        };
    }

}
