import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { tenantId } from "../category/category.service";
import {
  GettingStartedAchievementEntity,
  GettingStartedAchievementType,
  GettingStartedEventEntity,
  GettingStartedEventType,
  GettingStartedItemEntity,
  GettingStartedStepEntity,
} from "entities/getting-started.entity";
import { CreateEventDto } from "dto/getting-started.dto";
import { TranslationService } from "common/translation.service";
import { OnboardingAchievementService } from "../queue/queues/onboarding-achievement.queue";

@Injectable()
export class GettingStartedService {
  constructor(
    @InjectRepository(GettingStartedItemEntity)
    private readonly itemRepo: Repository<GettingStartedItemEntity>,
    @InjectRepository(GettingStartedStepEntity)
    private readonly stepRepo: Repository<GettingStartedStepEntity>,
    @InjectRepository(GettingStartedAchievementEntity)
    private readonly achievementRepo: Repository<GettingStartedAchievementEntity>,
    @InjectRepository(GettingStartedEventEntity)
    private readonly eventRepo: Repository<GettingStartedEventEntity>,
    private readonly onboardingAchievementService: OnboardingAchievementService,
    private readonly translations: TranslationService,
  ) {}

  async getItems(me: any) {
    const adminId = tenantId(me);
    if (!adminId) return [];

    const items = await this.itemRepo.find({
      where: { isActive: true },
      order: { sortOrder: "ASC" },
      relations: { steps: true },
    });

    const completedByKey = await this.completedByItemKey(adminId, items);

    return items.map((item) => ({
      id: item.id,
      key: item.key,
      title: item.title,
      description: item.description,
      completionType: item.completionType,
      dependsOn: item.dependsOn ?? [],
      sortOrder: item.sortOrder,
      isActive: item.isActive,
      groupNumber: item.groupNumber,
      steps: (item.steps ?? [])
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((step) => ({
          id: step.id,
          key: step.key,
          title: step.title,
          description: step.description,
          target: step.target,
          actionConfig: step.actionConfig,
          sortOrder: step.sortOrder,
        })),
      completed: completedByKey.get(item.key) ?? false,
      available: (item.dependsOn ?? []).every((key) => completedByKey.get(key)),
    }));
  }

  async getStatus(me: any) {
    const adminId = tenantId(me);

    const status: Record<string, boolean> = {};
    for (const type of Object.values(GettingStartedAchievementType)) {
      status[type] = false;
    }

    if (!adminId) return status;

    const achievements = await this.achievementRepo.find({
      where: { adminId },
      select: ["type"],
    });

    for (const achievement of achievements) {
      status[achievement.type] = true;
    }

    return status;
  }

  async logEvent(me: any, dto: CreateEventDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    if (
      dto.type === GettingStartedEventType.STEP_VIEWED &&
      !dto.stepId &&
      !dto.stepKey
    ) {
      throw new BadRequestException(
        this.translations.t("domains.getting_started.step_id_or_key_required"),
      );
    }

    const item = await this.itemRepo.findOne({ where: { id: dto.itemId } });
    if (!item) {
      throw new NotFoundException(
        this.translations.t("domains.getting_started.item_not_found"),
      );
    }

    if (dto.stepId) {
      const step = await this.stepRepo.findOne({ where: { id: dto.stepId } });
      if (!step) {
        throw new NotFoundException(
          this.translations.t("domains.getting_started.step_not_found"),
        );
      }
    }

    await this.eventRepo.save(
      this.eventRepo.create({
        adminId,
        itemId: item.id,
        stepId: dto.stepId ?? null,
        stepKey: dto.stepKey ?? null,
        type: dto.type,
      }),
    );

    return { success: true };
  }

  enqueueAchievement(me: any, type: GettingStartedAchievementType) {
    const adminId = tenantId(me);
    if (!adminId) return;
    this.onboardingAchievementService.enqueueAchievement(adminId, type);
  }

  async getProgress(me: any) {
    const adminId = tenantId(me);
    if (!adminId) return { total: 0, completed: 0, percentage: 0 };

    const items = await this.itemRepo.find({
      where: { isActive: true },
    });

    const achieved = await this.achievedTypes(adminId);

    const total = items.length;
    const completed = items.filter((item) =>
      achieved.has(item.completionType),
    ).length;
    const percentage = total === 0 ? 0 : Math.round((completed / total) * 100);

    return { total, completed, percentage };
  }

  private async achievedTypes(
    adminId: string,
  ): Promise<Set<GettingStartedAchievementType>> {
    const achievements = await this.achievementRepo.find({
      where: { adminId },
      select: ["type"],
    });
    return new Set(achievements.map((achievement) => achievement.type));
  }

  private async completedByItemKey(
    adminId: string,
    items: GettingStartedItemEntity[],
  ): Promise<Map<string, boolean>> {
    const achieved = await this.achievedTypes(adminId);

    const completedByKey = new Map<string, boolean>();
    for (const item of items) {
      completedByKey.set(item.key, achieved.has(item.completionType));
    }
    return completedByKey;
  }
}
