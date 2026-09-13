import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { deleteFile } from "common/healpers";
import { RedisService } from "common/redis/RedisService";
import { UpsertClientSettingsDto } from "dto/client-settings.dto";
import {
  CampaignOrderPageSettings,
  ClientSettingsEntity,
  DEFAULT_CAMPAIGN_ORDER_PAGE_SETTINGS,
} from "entities/clientSettings.entity";
import { OrphanFileEntity } from "entities/files.entity";
import { OrderStatus } from "entities/order.entity";
import { tenantId } from "src/category/category.service";
import { User } from "entities/user.entity";
import { SEED_DATA } from "src/users/seed-data.config";
import { EntityManager, In, Repository } from "typeorm";

@Injectable()
export class ClientSettingsService {
  constructor(
    @InjectRepository(ClientSettingsEntity)
    private readonly settingsRepo: Repository<ClientSettingsEntity>,
    private readonly redisService: RedisService,
  ) {}

  async upsertSettings(
    me: any,
    dto: UpsertClientSettingsDto,
  ): Promise<ClientSettingsEntity> {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const { orphanFileIds = [], ...settingsDto } = dto;
    const oldFilesToDelete = new Set<string>();

    const saved = await this.settingsRepo.manager.transaction(async (mgr) => {
      const repo = mgr.getRepository(ClientSettingsEntity);
      let settings = await repo.findOneBy({ adminId });
      const campaignOrderPage = this.mergeCampaignOrderPage(
        settings?.campaignOrderPage,
        settingsDto.campaignOrderPage,
      );

      if (settingsDto.campaignOrderPage && settings) {
        const oldLogo = String(settings.campaignOrderPage?.logoUrl || "");
        const nextLogo = String(campaignOrderPage.logoUrl || "");
        const oldIcon = String(settings.campaignOrderPage?.favicon?.icon || "");
        const nextIcon = String(campaignOrderPage.favicon?.icon || "");

        if (
          settingsDto.campaignOrderPage.logoUrl !== undefined &&
          oldLogo &&
          oldLogo !== nextLogo &&
          !oldLogo.startsWith("http")
        ) {
          oldFilesToDelete.add(oldLogo);
        }

        if (
          settingsDto.campaignOrderPage.favicon?.icon !== undefined &&
          oldIcon &&
          oldIcon !== nextIcon &&
          !oldIcon.startsWith("http")
        ) {
          oldFilesToDelete.add(oldIcon);
        }
      }

      if (settings) {
        // Update existing record
        settings = repo.merge(settings, {
          ...settingsDto,
          defaultWhatsAppAccountId:
            settingsDto.defaultWhatsAppAccountId ||
            settings.defaultWhatsAppAccountId ||
            null,
          notificationSettings: {
            ...(settings.notificationSettings ?? {}),
            ...(settingsDto.notificationSettings ?? {}),
          },
          campaignOrderPage,
        });
      } else {
        // Create new record for this admin
        settings = repo.create({
          ...settingsDto,
          adminId,
          notificationSettings: {
            ...(settingsDto.notificationSettings ?? {}),
          },
          campaignOrderPage,
        });
      }

      const savedSettings = await repo.save(settings);
      const cleanOrphanIds = orphanFileIds.filter(
        (id) => typeof id === "string" && id.length > 0,
      );
      if (cleanOrphanIds.length) {
        await mgr.getRepository(OrphanFileEntity).delete({
          adminId: String(adminId),
          id: In(cleanOrphanIds),
        } as any);
      }

      return savedSettings;
    });

    // Invalidate cache
    await Promise.all([
      this.redisService.del(`admin_notification_settings:${adminId}`),
      this.redisService.del(`admin_settings:${adminId}`),
    ]);

    await Promise.all([...oldFilesToDelete].map((url) => deleteFile(url)));

    return saved;
  }

  private mergeCampaignOrderPage(
    current?: CampaignOrderPageSettings | null,
    next?: UpsertClientSettingsDto["campaignOrderPage"],
  ): CampaignOrderPageSettings {
    return {
      ...DEFAULT_CAMPAIGN_ORDER_PAGE_SETTINGS,
      ...(current ?? {}),
      ...(next ?? {}),
      favicon: {
        ...DEFAULT_CAMPAIGN_ORDER_PAGE_SETTINGS.favicon,
        ...(current?.favicon ?? {}),
        ...(next?.favicon ?? {}),
      },
    };
  }
  async getSettings(
    me: any,
    manager?: EntityManager,
  ): Promise<ClientSettingsEntity> {
    const adminId = tenantId(me);
    const repo = manager
      ? manager.getRepository(ClientSettingsEntity)
      : this.settingsRepo;
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
        retryStatuses: [OrderStatus.WRONG_NUMBER, OrderStatus.UNDER_REVIEW],
        reservedEnabled: false, // by default false
        campaignOrderPage: DEFAULT_CAMPAIGN_ORDER_PAGE_SETTINGS,
      });
    }
    await this.redisService.set(
      `admin_settings:${adminId}`,
      settings,
      3600 * 24,
    );
    // Return existing or a default object to keep frontend stable
    return settings;
  }

  async getCampaignOrderPreview(me: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const settings = await this.getSettings(me);
    const branding = {
      ...DEFAULT_CAMPAIGN_ORDER_PAGE_SETTINGS,
      ...(settings.campaignOrderPage ?? {}),
      favicon: {
        ...DEFAULT_CAMPAIGN_ORDER_PAGE_SETTINGS.favicon,
        ...(settings.campaignOrderPage?.favicon ?? {}),
      },
    };

    const admin = await this.settingsRepo.manager.getRepository(User).findOne({
      where: { id: adminId },
      relations: { company: true },
    });
    const currency = String(admin?.company?.currency || "EGP").trim();

    const products = SEED_DATA.products.slice(0, 2).map((product, index) => ({
      name: product.name,
      sku: product.sku,
      image: product.mainImage,
      quantity: index === 0 ? 2 : 1,
      price: Number(product.salePrice || 0),
    }));
    const shippingPrice = 75;
    const total = products.reduce(
      (sum, product) => sum + product.price * product.quantity,
      shippingPrice,
    );

    return {
      preview: true,
      alreadyOrdered: false,
      orderNumber: null,
      customerName: "Ahmed Ali",
      phoneNumber: "01000000000",
      address: "Street 12, Building 5",
      city: "Cairo",
      cityId: null,
      area: "Nasr City",
      areaId: null,
      landmark: "Near the mall",
      customerNotes: "Please call before delivery",
      shippingPrice,
      products,
      total,
      currency,
      branding,
    };
  }

  // Local memory cache for settings to optimize loops (TTL: 5 seconds)
  private static localSettingsCache = new Map<string, ClientSettingsEntity>();

  static updateLocalCache(adminId: string, settings: ClientSettingsEntity) {
    this.localSettingsCache.set(adminId, settings);

    // Directly remove after 5 seconds to free memory and ensure freshness
    setTimeout(() => {
      this.localSettingsCache.delete(adminId);
    }, 15000);
  }

  async getCachedSettings(adminId: string): Promise<ClientSettingsEntity> {
    const local = ClientSettingsService.localSettingsCache.get(adminId);

    if (local) {
      return local;
    }

    const cacheKey = `admin_settings:${adminId}`;
    let settings = await this.redisService.get<ClientSettingsEntity>(cacheKey);

    if (!settings || typeof settings === "string") {
      // Use getSettings logic which also handles creation of default settings
      settings = await this.getSettings({
        id: adminId,
        role: { name: "admin" },
      });
    }

    // Update local cache
    ClientSettingsService.updateLocalCache(adminId, settings);

    return settings;
  }
}
