import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Notification, NotificationType } from "entities/notifications.entity";
import { OrderRetrySettingsEntity } from "entities/order.entity";
import { User } from "entities/user.entity";
import { RedisService } from "common/redis/RedisService";
import { Brackets, EntityManager, Repository } from "typeorm";

@Injectable()
export class NotificationService {
  constructor(
    @InjectRepository(Notification)
    private notificationRepo: Repository<Notification>,
    @InjectRepository(OrderRetrySettingsEntity)
    private retrySettingsRepo: Repository<OrderRetrySettingsEntity>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private redisService: RedisService,
  ) { }
  async list(me: any, q?: any) {
    const userId = me?.id; // Notifications are personal to the logged-in user

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? "").trim();
    const isRead = q?.isRead !== undefined ? q.isRead === "true" : undefined;

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
          sq.where("n.title ILIKE :s", { s: `%${search}%` }).orWhere(
            "n.message ILIKE :s",
            { s: `%${search}%` },
          );
        }),
      );
    }

    // Sort: Unread first, then by date
    qb.orderBy("n.isRead", "ASC").addOrderBy("n.createdAt", "DESC");

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

  async markAsRead(userId: string, id: string) {
    // Check if notification exists and belongs to the user
    const notification = await this.notificationRepo.findOne({
      where: { id, userId },
    });

    if (!notification) {
      throw new NotFoundException("Notification not found or access denied");
    }

    if (notification.isRead) {
      throw new BadRequestException("Notification is already marked as read");
    }

    return this.notificationRepo.update(id, { isRead: true });
  }

  async markAllAsRead(userId: string) {
    return this.notificationRepo.update(
      { userId, isRead: false }, // Filter: only unread ones for this user
      { isRead: true }, // Action: mark as read
    );
  }
  async getUnreadCount(userId: string) {
    // Fetch the user directly to get the cached count
    const count = await this.notificationRepo.count({
      where: { userId: userId, isRead: false },
    });

    return {
      unreadCount: count || 0,
    };
  }

  private async getUserSettings(userId: string, manager: EntityManager = null) {
    const userCacheKey = `user_admin_id:${userId}`;
    const retrySettingsRepo = manager ? manager.getRepository(OrderRetrySettingsEntity) : this.retrySettingsRepo;
    const userRepo = manager ? manager.getRepository(User) : this.userRepo;
    // 1. Get Admin ID (from cache or DB)
    let adminId = await this.redisService.get<string>(userCacheKey);

    if (!adminId) {
      const user = await userRepo.findOne({
        where: { id: userId },
        relations: ["role"],
      });

      if (!user) return null;

      if (user.role?.name === "admin") {
        adminId = String(user.id);
      } else if (user.adminId) {
        adminId = String(user.adminId);
      }

      if (adminId) {
        await this.redisService.set(userCacheKey, adminId, 3600);
      }
    }

    if (!adminId) return null;

    // 2. Get Settings (from cache or DB)
    const settingsCacheKey = `admin_notification_settings:${adminId}`;
    let settings = await this.redisService.get<OrderRetrySettingsEntity>(settingsCacheKey);

    if (!settings) {
      settings = await retrySettingsRepo.findOneBy({ adminId });
      if (settings) {
        await this.redisService.set(settingsCacheKey, settings, 3600);
      }
    }

    return settings;
  }

  private getSettingField(type: NotificationType): string | null {
    switch (type) {
      case NotificationType.ORDER_STATUS_UPDATE:
      case NotificationType.ORDER_UPDATED:
      case NotificationType.ORDER_REJECTED:
      case NotificationType.ORDER_RECONFIRMED:
      case NotificationType.ORDER_DELETED:
      case NotificationType.ORDER_STATUS_CREATED:
      case NotificationType.ORDER_STATUS_SETTINGS_UPDATED:
      case NotificationType.SHIPPING_AUTO_SENT:
      case NotificationType.SHIPPING_AUTO_FAILED:
      case NotificationType.SHIPMENT_CREATED:
      case NotificationType.SHIPMENT_CANCELLED:
      case NotificationType.REPLACEMENT_CREATED:
      case NotificationType.RETURN_REQUEST_CREATED:
        return "notifyOrderUpdates";
      case NotificationType.PRODUCT_CREATED:
      case NotificationType.COLLECTION_CREATED:
        return "notifyNewProducts";
      case NotificationType.LOW_STOCK_ALERT:
        return "notifyLowStock";
      case NotificationType.MARKETING_MESSAGE:
        return "notifyMarketing";
      default:
        return null;
    }
  }

  async create(data: {
    userId: string;
    type: NotificationType;
    title: string;
    message: string;
    relatedEntityType?: string;
    relatedEntityId?: string;
  }, manager: EntityManager = null) {
    // Check user preferences
    const notificationRepo = manager ? manager.getRepository(Notification) : this.notificationRepo;
    const settings = await this.getUserSettings(data.userId, manager);
    if (settings) {
      const field = this.getSettingField(data.type);
      if (field && settings[field] === false) {
        // Notification type is disabled by user/admin
        return null;
      }
    }

    const notification = notificationRepo.create({
      ...data,
      isRead: false,
    });

    return notificationRepo.save(notification);
  }
}
