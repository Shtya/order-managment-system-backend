import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { In, LessThan, Repository } from "typeorm";
import { ShipmentEntity, ShipmentStatus } from "../../entities/shipping.entity";
import { ClientSettingsEntity } from "../../entities/clientSettings.entity";
import { NotificationService } from "src/notifications/notification.service";
import { NotificationType } from "entities/notifications.entity";
import { RequestTranslationService } from "common/translation.service";
import { ClientSettingsService } from "src/client-settings/client-settings.service";

@Injectable()
export class ReturnShipmentCheckerService {
  private readonly logger = new Logger(ReturnShipmentCheckerService.name);

  private readonly RETURN_STATUSES: ShipmentStatus[] = [
    ShipmentStatus.CUSTOMER_NOT_RESPOND,
    ShipmentStatus.CUSTOMER_DATA_WRONG,
    ShipmentStatus.CUSTOMER_REFUSED,
    ShipmentStatus.CANCELLED,
    ShipmentStatus.FAILED,
  ];

  constructor(
    @InjectRepository(ShipmentEntity)
    private readonly shipmentsRepo: Repository<ShipmentEntity>,
    @InjectRepository(ClientSettingsEntity)
    private readonly settingsRepo: Repository<ClientSettingsEntity>,
    private readonly clientSettingsService: ClientSettingsService,
    private readonly notificationService: NotificationService,
    private readonly requestTranslations: RequestTranslationService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_10AM)
  async handleReturnReminders() {
    this.logger.log("Checking for shipments needing return reminders...");

    try {
      const shipments = await this.shipmentsRepo.find({
        where: { status: In(this.RETURN_STATUSES) },
        relations: ["order"],
      });

      if (shipments.length === 0) {
        this.logger.log("No shipments pending return found.");
        return;
      }

      const groupedByAdmin = shipments.reduce(
        (acc, shipment) => {
          if (!shipment.adminId) return acc;
          if (!acc[shipment.adminId]) acc[shipment.adminId] = [];
          acc[shipment.adminId].push(shipment);
          return acc;
        },
        {} as Record<string, ShipmentEntity[]>,
      );

      for (const [adminId, adminShipments] of Object.entries(groupedByAdmin)) {
        const settings =
          await this.clientSettingsService.getCachedSettings(adminId);

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const title = await this.requestTranslations.tAsync(
          "domains.shipping.returnReminders.title",
          adminId,
        );

        let message: string;
        if (adminShipments.length === 1) {
          const orderNumber =
            adminShipments[0].order?.orderNumber || adminShipments[0].orderId;
          message = await this.requestTranslations.tAsync(
            "domains.shipping.returnReminders.single_message",
            adminId,
            {
              args: { orderNumber },
            },
          );
        } else {
          message = await this.requestTranslations.tAsync(
            "domains.shipping.returnReminders.multiple_message",
            adminId,
            {
              args: { count: adminShipments.length },
            },
          );
        }

        await this.notificationService.create({
          userId: adminId,
          type: NotificationType.RETURN_SHIPMENT_REMINDER,
          title,
          message,
          relatedEntityType: "shipment",
        });

        await this.settingsRepo.update(
          { adminId },
          { returnNotificationLastSentAt: new Date() },
        );
      }

      this.logger.log(
        `Return reminder check completed. Notified ${Object.keys(groupedByAdmin).length} admins.`,
      );
    } catch (error) {
      this.logger.error("Error checking for return shipment reminders", error);
    }
  }
}
