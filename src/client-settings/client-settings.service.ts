import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { RedisService } from 'common/redis/RedisService';
import { UpsertClientSettingsDto } from 'dto/client-settings.dto';
import { ClientSettingsEntity } from 'entities/clientSettings.entity';
import { OrderStatus } from 'entities/order.entity';
import { tenantId } from 'src/category/category.service';
import { EntityManager, Repository } from 'typeorm';

@Injectable()
export class ClientSettingsService {
  constructor(
     @InjectRepository(ClientSettingsEntity)
    private readonly settingsRepo: Repository<ClientSettingsEntity>,
    private readonly redisService: RedisService,
  ) {
  }

  async upsertSettings(
    me: any,
    dto: UpsertClientSettingsDto,
  ): Promise<ClientSettingsEntity> {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    let settings = await this.settingsRepo.findOneBy({ adminId });

    if (settings) {
      // Update existing record
      settings = this.settingsRepo.merge(settings, {
        ...dto,
        defaultWhatsAppAccountId: dto.defaultWhatsAppAccountId || settings.defaultWhatsAppAccountId || null,
        notificationSettings: {
          ...(settings.notificationSettings ?? {}),
          ...(dto.notificationSettings ?? {}),
        },
      });
    } else {
      // Create new record for this admin
      settings = this.settingsRepo.create({
        ...dto,
        adminId,
        notificationSettings: {
          ...(dto.notificationSettings ?? {}),
        },
      });
    }

    const saved = await this.settingsRepo.save(settings);

    // Invalidate cache
    const cacheKey = `admin_notification_settings:${adminId}`;
    await this.redisService.del(cacheKey);

    return saved;
  }
  async getSettings(me: any, manager?: EntityManager): Promise<ClientSettingsEntity> {
    const adminId = tenantId(me);
    const repo = manager ? manager.getRepository(ClientSettingsEntity) : this.settingsRepo;
    let settings = await repo.findOneBy({ adminId: adminId });

    if (!settings) {
      settings = await this.settingsRepo.save({
        adminId,
        confirmationStatuses: [
          OrderStatus.CANCELLED,
          OrderStatus.CONFIRMED,
          OrderStatus.NO_ANSWER,
          OrderStatus.OUT_OF_DELIVERY_AREA,
          OrderStatus.POSTPONED,
          OrderStatus.WRONG_NUMBER,
          OrderStatus.UNDER_REVIEW,
        ],
        autoMoveStatus: OrderStatus.CANCELLED,
        retryStatuses: [
          OrderStatus.WRONG_NUMBER,
          OrderStatus.UNDER_REVIEW,
        ],
        reservedEnabled: false, // by default false
      });
    }
    await this.redisService.set(`admin_settings:${adminId}`, settings, 3600 * 24);
    // Return existing or a default object to keep frontend stable
    return settings;
  }

  // Local memory cache for settings to optimize loops (TTL: 5 seconds)
  private static localSettingsCache = new Map<string, ClientSettingsEntity>();

  static updateLocalCache(adminId: string, settings: ClientSettingsEntity) {
    this.localSettingsCache.set(adminId, settings);

    // Directly remove after 5 seconds to free memory and ensure freshness
    setTimeout(() => {
      this.localSettingsCache.delete(adminId);
    }, 5000);
  }

  async getCachedSettings(adminId: string): Promise<ClientSettingsEntity> {
    const local = ClientSettingsService.localSettingsCache.get(adminId);

    if (local) {
      return local;
    }

    const cacheKey = `admin_settings:${adminId}`;
    let settings = await this.redisService.get<ClientSettingsEntity>(cacheKey);

    if (!settings || typeof settings === 'string') {
      // Use getSettings logic which also handles creation of default settings
      settings = await this.getSettings({ id: adminId, role: { name: 'admin' } });
    }

    // Update local cache
    ClientSettingsService.updateLocalCache(adminId, settings);

    return settings;
  }
}
