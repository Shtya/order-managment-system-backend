import { ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { RedisService } from "common/redis/RedisService";
import { TranslationService } from "common/translation.service";
import { UpdateAdminSettingsDto } from "dto/adminSettings.dto";
import { AdminSettingsEntity } from "entities/adminSettings.entity";
import { SystemRole, User } from "entities/user.entity";
import { Repository } from "typeorm";

@Injectable()
export class AdminSettingsService {
  private static readonly CACHE_KEY = "global_admin_settings";
  //7 days
  private static readonly CACHE_TTL_SECONDS = 3600 * 24 * 7;
  private memoryCache: AdminSettingsEntity | null = null;
  private cacheRevision = 0;

  constructor(
    @InjectRepository(AdminSettingsEntity)
    private readonly settingsRepo: Repository<AdminSettingsEntity>,
    private readonly translations: TranslationService,
    private readonly redisService: RedisService,
  ) {}
  private isSuperAdmin(me: User) {
    return me.role?.name === SystemRole.SUPER_ADMIN;
  }

  private async cacheSettings(settings: AdminSettingsEntity): Promise<void> {
    await this.redisService.set(
      AdminSettingsService.CACHE_KEY,
      settings,
      AdminSettingsService.CACHE_TTL_SECONDS,
    );
  }

  private async loadOrCreateSettings(): Promise<AdminSettingsEntity> {
    let settings = await this.settingsRepo.findOne({ where: {} });

    if (!settings) {
      settings = this.settingsRepo.create({
        email: "",
        whatsapp: "",
        socials: {},
        billing: {
          aiDecision: {
            tokenPrice: 0.5,
            allowance: null,
          },
        },
      });
      await this.settingsRepo.save(settings);
    }

    return settings;
  }

  getCacheRevision(): number {
    return this.cacheRevision;
  }

  // Retrieves the global settings or creates a blank one if it's the first run
  async getSettings(): Promise<AdminSettingsEntity> {
    if (this.memoryCache) {
      return this.memoryCache;
    }

    const cached = await this.redisService.get<AdminSettingsEntity>(
      AdminSettingsService.CACHE_KEY,
    );
    if (cached && typeof cached !== "string") {
      this.memoryCache = cached;
      return cached;
    }

    const settings = await this.loadOrCreateSettings();
    this.memoryCache = settings;
    await this.cacheSettings(settings);
    return settings;
  }

  // Updates the global settings
  async updateSettings(
    dto: UpdateAdminSettingsDto,
    me: any,
  ): Promise<AdminSettingsEntity> {
    if (!this.isSuperAdmin(me)) {
      throw new ForbiddenException(
        this.translations.t("common.permission_denied_action"),
      );
    }

    const settings = await this.loadOrCreateSettings();

    // Merge incoming socials with existing ones so we don't accidentally delete omitted fields
    const updatedSocials = {
      ...settings.socials,
      ...(dto.socials || {}),
    };

    // Merge billing subtree so omitted prices are preserved.
    // Explicit null allowance means unlimited (not limited).
    let updatedBilling = settings.billing;
    if (dto.billing) {
      const incomingAllowance =
        dto.billing?.aiDecision && "allowance" in dto.billing.aiDecision
          ? (dto.billing.aiDecision as any).allowance
          : undefined;
      const existingAi = { ...(settings.billing?.aiDecision || {}) };
      const incomingAi = { ...(dto.billing?.aiDecision || {}) };
      updatedBilling = {
        ...(settings.billing || {}),
        ...(dto.billing || {}),
        aiDecision: {
          ...existingAi,
          ...incomingAi,
          allowance:
            incomingAllowance === null
              ? null
              : incomingAllowance === undefined
                ? (existingAi as any)?.allowance ?? null
                : {
                    ...((existingAi as any)?.allowance || {}),
                    ...incomingAllowance,
                  },
        },
      };
    }

    // Update entity properties
    Object.assign(settings, {
      ...dto,
      socials: updatedSocials,
      billing: updatedBilling,
    });

    const saved = await this.settingsRepo.save(settings);
    this.memoryCache = saved;
    this.cacheRevision += 1;
    await this.cacheSettings(saved);
    return saved;
  }
}
