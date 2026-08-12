import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { GettingStartedJobs, QueueNames } from "../common/queue.constants";
import { Job, JobsOptions, MetricsTime, Queue } from "bullmq";
import { DataSource, QueryFailedError } from "typeorm";
import {
  GettingStartedAchievementEntity,
  GettingStartedAchievementType,
} from "entities/getting-started.entity";
import { NotificationType } from "entities/notifications.entity";
import { ProcessAchievementJobDto } from "dto/getting-started.dto";
import { NotificationService } from "src/notifications/notification.service";
import { I18nKey, RequestTranslationService } from "common/translation.service";
import { AppGateway } from "common/app.gateway";

const ACHIEVEMENT_TRANSLATION_KEYS: Record<GettingStartedAchievementType, I18nKey> = {
    [GettingStartedAchievementType.FIRST_PRODUCT_CREATED]: "domains.getting_started.achievements.first_product_created",
    [GettingStartedAchievementType.FIRST_WAREHOUSE_CREATED]: "domains.getting_started.achievements.first_warehouse_created",
    [GettingStartedAchievementType.FIRST_WAREHOUSE_STOCK_CREATED]: "domains.getting_started.achievements.first_warehouse_stock_created",
    [GettingStartedAchievementType.FIRST_ORDER_CREATED]: "domains.getting_started.achievements.first_order_created",
    [GettingStartedAchievementType.SHIPPING_INTEGRATION_CONNECTED]: "domains.getting_started.achievements.shipping_integration_connected",
    [GettingStartedAchievementType.WHATSAPP_CONNECTED]: "domains.getting_started.achievements.whatsapp_connected",
    [GettingStartedAchievementType.STORE_CONNECTED]: "domains.getting_started.achievements.store_connected",
    [GettingStartedAchievementType.FIRST_TEAM_MEMBER_CREATED]: "domains.getting_started.achievements.first_team_member_created",
    [GettingStartedAchievementType.FIRST_AUTOMATION_CREATED]: "domains.getting_started.achievements.first_automation_created",
    [GettingStartedAchievementType.FIRST_SAFE_CREATED]: "domains.getting_started.achievements.first_safe_created",
    [GettingStartedAchievementType.FIRST_PURCHASE_ACCEPTED]: "domains.getting_started.achievements.first_purchase_accepted",
    [GettingStartedAchievementType.FIRST_SUPPLIER_CREATED]: "domains.getting_started.achievements.first_supplier_created",
    [GettingStartedAchievementType.FIRST_ORDER_ASSIGNMENT_AUTOMATION_RULE_CREATED]: "domains.getting_started.achievements.first_order_assignment_automation_rule_created",
    [GettingStartedAchievementType.FIRST_ORDER_BUNDLE_CREATED]: "domains.getting_started.achievements.first_order_bundle_created",
    [GettingStartedAchievementType.FIRST_CUSTOM_ROLE_CREATED]: "domains.getting_started.achievements.first_custom_role_created",
};

@Injectable()
export class OnboardingAchievementService {
    private readonly logger = new Logger(OnboardingAchievementService.name);

    constructor(
        @InjectQueue(QueueNames.GETTING_STARTED)
        private readonly gettingStartedQueue: Queue,
    ) { }

    enqueueAchievement(adminId: string, type: GettingStartedAchievementType): void {
        if (!adminId) return;

        try {
            this.gettingStartedQueue
                .add(
                    GettingStartedJobs.PROCESS_ACHIEVEMENT,
                    { adminId, type } as ProcessAchievementJobDto,
                    {
                        attempts: 4,
                        backoff: { type: "exponential", delay: 1000 },
                    } as JobsOptions,
                )
                .catch((error) => {
                    this.logger.error(
                        `Failed to add achievement job | Admin: ${adminId} | Type: ${type}: ${error?.message}`,
                    );
                });
        } catch (error) {
            this.logger.error(
                `Failed to add achievement job | Admin: ${adminId} | Type: ${type}: ${error?.message}`,
            );
        }
    }
}

@Processor(QueueNames.GETTING_STARTED, {
    concurrency: 5,
    maxStartedAttempts: 200,
    metrics: {
        maxDataPoints: MetricsTime.ONE_WEEK * 2,
    },
})
export class OnboardingAchievementProcessor extends WorkerHost {
    private readonly logger = new Logger(OnboardingAchievementProcessor.name);

    constructor(
        private readonly dataSource: DataSource,
        private readonly notificationService: NotificationService,
        private readonly requestTranslations: RequestTranslationService,
        private readonly appGateway: AppGateway,
    ) {
        super();
    }

    async process(job: Job<ProcessAchievementJobDto>): Promise<any> {
        const { adminId, type } = job.data;
        this.logger.log(`Processing achievement job ${job.id} | Admin: ${adminId} | Type: ${type}`);

        try {
            const result = await this.dataSource.transaction(async (manager) => {
                const achievementRepo = manager.getRepository(GettingStartedAchievementEntity);

                const existing = await achievementRepo.findOne({
                    where: { adminId, type },
                });

                if (existing) {
                    this.logger.log(`Achievement already recorded, skipping | Admin: ${adminId} | Type: ${type}`);
                    return { recorded: false, reason: "already-recorded" };
                }

                const achievement = await achievementRepo.save(
                    achievementRepo.create({
                        adminId,
                        type,
                        first_completed_at: new Date(),
                    }),
                );
                this.logger.log(`Achievement recorded | Admin: ${adminId} | Type: ${type}`);
                return { recorded: true, reason: "recorded", achievement };
            });

            if (result.recorded) {
                await this.sendAchievementNotification(adminId, type, result.achievement);
            }

            return result;
        } catch (error) {
            if (error instanceof QueryFailedError && (error as any)?.driverError?.code === "23505") {
                this.logger.log(`Achievement already recorded, skipping | Admin: ${adminId} | Type: ${type}`);
                return { recorded: false, reason: "already-recorded" };
            }
            this.logger.error(
                `Failed to process achievement job ${job.id} | Admin: ${adminId} | Type: ${type}`,
                error instanceof Error ? error.stack : error,
            );
            throw error; // rethrow to let BullMQ handle retries
        }
    }

    private async sendAchievementNotification(
        adminId: string,
        type: GettingStartedAchievementType,
        achievement: GettingStartedAchievementEntity,
    ) {
        try {
            const achievementName = await this.requestTranslations.tAsync(
                ACHIEVEMENT_TRANSLATION_KEYS[type],
                adminId,
            );

            const title = await this.requestTranslations.tAsync(
                "domains.getting_started.achievement_title",
                adminId,
                { args: { achievement: achievementName } },
            );
            const message = await this.requestTranslations.tAsync(
                "domains.getting_started.achievement_message",
                adminId,
                { args: { achievement: achievementName } },
            );
            
            this.appGateway.emitGettingStartedAchievement(adminId, {
                achievementId: achievement.id,
                type,
                title,
                message,
            });
            const notification = await this.notificationService.create({
                userId: adminId,
                type: NotificationType.GETTING_STARTED_ACHIEVEMENT,
                title,
                message,
                relatedEntityType: "getting_started_achievements",
                relatedEntityId: String(achievement.id),
            });


            this.logger.log(`Achievement notification sent | Admin: ${adminId} | Type: ${type}`);
        } catch (error) {
            this.logger.error(
                `Failed to send achievement notification | Admin: ${adminId} | Type: ${type}`,
                error instanceof Error ? error.stack : error,
            );
        }
    }
}
