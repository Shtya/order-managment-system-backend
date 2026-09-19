import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  CampaignEntity,
  CampaignRecipientDeliveryStatus,
  CampaignRecipientEntity,
} from "entities/campaigns.entity";
import { AppGateway } from "common/app.gateway";
import { WhatsappMessageCostService } from "src/whatsapp/services/whatsapp-message-cost.service";
import { WhatsappService } from "src/whatsapp/whatsapp.service";
import { hydrateCampaignPlaceholders } from "./campaign-placeholders";
import {
  buildCampaignOrderUrl,
  substituteFollowupOrderUrl,
} from "./campaign-order-url";

export type CampaignDeliveryEventStatus =
  | CampaignRecipientDeliveryStatus.SENT
  | CampaignRecipientDeliveryStatus.DELIVERED
  | CampaignRecipientDeliveryStatus.READ
  | CampaignRecipientDeliveryStatus.FAILED;

@Injectable()
export class CampaignWebhookEventsService {
  private readonly logger = new Logger(CampaignWebhookEventsService.name);

  constructor(
    @InjectRepository(CampaignEntity)
    private readonly campaignRepo: Repository<CampaignEntity>,
    @InjectRepository(CampaignRecipientEntity)
    private readonly recipientRepo: Repository<CampaignRecipientEntity>,
    private readonly appGateway: AppGateway,
    private readonly messageCostService: WhatsappMessageCostService,
    @Inject(forwardRef(() => WhatsappService))
    private readonly whatsappService: WhatsappService,
  ) {}

  async applyDeliveryEvent(input: {
    adminId: string;
    providerMessageId: string;
    campaignRecipientId?: string | null;
    status: CampaignDeliveryEventStatus | string;
    at: Date;
    failureReason?: string | null;
  }): Promise<void> {
    const recipientId = await this.resolveRecipientId(
      input.adminId,
      input.providerMessageId,
      input.campaignRecipientId,
    );
    if (!recipientId) return;

    const status = input.status as CampaignRecipientDeliveryStatus;
    try {
      if (status === CampaignRecipientDeliveryStatus.SENT) {
        await this.recipientRepo.query(
          `
          UPDATE campaign_recipients
          SET "deliveryStatus" = $2, "updatedAt" = NOW()
          WHERE id = $1 AND "deliveryStatus" IN ($3, $4)
          `,
          [
            recipientId,
            CampaignRecipientDeliveryStatus.SENT,
            CampaignRecipientDeliveryStatus.ACCEPTED,
            CampaignRecipientDeliveryStatus.SENDING,
          ],
        );
        await this.emitCampaignLive(input.adminId, recipientId, "recipient");
        return;
      }

      if (status === CampaignRecipientDeliveryStatus.DELIVERED) {
        await this.markDelivered(recipientId, input.at);
        await this.messageCostService.syncRecipientByProviderMessageId(
          input.providerMessageId,
        );
        await this.emitCampaignLive(input.adminId, recipientId, "recipient");
        return;
      }

      if (status === CampaignRecipientDeliveryStatus.READ) {
        await this.markDelivered(recipientId, input.at);
        await this.markRead(recipientId, input.at);
        await this.messageCostService.syncRecipientByProviderMessageId(
          input.providerMessageId,
        );
        await this.emitCampaignLive(input.adminId, recipientId, "recipient");
        return;
      }

      if (status === CampaignRecipientDeliveryStatus.FAILED) {
        await this.recipientRepo.query(
          `
          UPDATE campaign_recipients
          SET
            "deliveryStatus" = $2,
            "failedAt" = $3,
            "failureReason" = COALESCE($4, "failureReason"),
            "updatedAt" = NOW()
          WHERE id = $1
            AND "deliveryStatus" NOT IN ($2, $5, $6)
          `,
          [
            recipientId,
            CampaignRecipientDeliveryStatus.FAILED,
            input.at,
            input.failureReason?.slice(0, 500) ?? null,
            CampaignRecipientDeliveryStatus.DELIVERED,
            CampaignRecipientDeliveryStatus.READ,
          ],
        );
        await this.emitCampaignLive(input.adminId, recipientId, "recipient");
      }
    } catch (error) {
      this.logger.error(
        `Failed to apply campaign delivery event ${status} for ${recipientId}: ${error?.message}`,
        error?.stack,
      );
      throw error;
    }
  }

  async applyReplyEvent(input: {
    adminId: string;
    providerMessageId: string;
    at: Date;
    buttonText?: string | null;
    buttonId?: string | null;
  }): Promise<void> {
    if (!input.adminId || !input.providerMessageId) return;
    try {
      // Every tap is processed (any button, any number of times).
      // repliedCount still counts distinct repliers: it increments only
      // for the recipient's first reply (wasReplied flag, atomically).
      const rows = await this.queryRows<{
        id: string;
        campaignId: string;
        phoneNumber: string;
        name: string | null;
        accessToken: string | null;
        wasReplied: boolean;
      }>(
        `
        WITH target AS (
          SELECT id, "hasReplied" AS "wasReplied"
          FROM campaign_recipients
          WHERE "adminId" = $1 AND "messageId" = $2
          LIMIT 1
          FOR UPDATE
        )
        UPDATE campaign_recipients AS r
        SET "hasReplied" = true,
            "repliedAt" = CASE WHEN t."wasReplied" THEN r."repliedAt" ELSE $3 END,
            "updatedAt" = NOW()
        FROM target AS t
        WHERE r.id = t.id
        RETURNING r.id, r."campaignId", r."phoneNumber", r.name, r."accessToken", t."wasReplied" AS "wasReplied"
        `,
        [input.adminId, input.providerMessageId, input.at],
      );
      const recipient = rows[0];
      if (!recipient) return;
      if (!recipient.wasReplied) {
        await this.campaignRepo.increment({ id: recipient.campaignId }, "repliedCount", 1);
      }
      await this.emitCampaignLiveByCampaign(
        input.adminId,
        recipient.campaignId,
        "recipient",
      );
      await this.maybeSendOrderLinkFollowup(input.adminId, recipient, {
        buttonText: input.buttonText,
        buttonId: input.buttonId,
      });
    } catch (error) {
      this.logger.error(
        `Failed to apply campaign reply event for ${input.providerMessageId}: ${error?.message}`,
        error?.stack,
      );
      throw error;
    }
  }

  async linkWhatsappMessage(input: {
    campaignRecipientId: string;
    whatsappMessageId: string;
  }): Promise<void> {
    if (!input.campaignRecipientId || !input.whatsappMessageId) return;
    try {
      await this.recipientRepo.query(
        `
        UPDATE campaign_recipients
        SET "whatsappMessageId" = $2, "updatedAt" = NOW()
        WHERE id = $1 AND "whatsappMessageId" IS NULL
        `,
        [input.campaignRecipientId, input.whatsappMessageId],
      );
      await this.messageCostService.syncRecipientFromLinkedMessage(
        input.campaignRecipientId,
        input.whatsappMessageId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to link campaign recipient ${input.campaignRecipientId}: ${error?.message}`,
        error?.stack,
      );
      throw error;
    }
  }

  private async maybeSendOrderLinkFollowup(
    adminId: string,
    recipient: {
      id: string;
      campaignId: string;
      phoneNumber: string;
      name?: string | null;
      accessToken: string | null;
    },
    reply: { buttonText?: string | null; buttonId?: string | null },
  ) {
    // No once-per-recipient guard: every tap on any button gets its
    // configured reply, no matter how many times it is tapped.
    if (!recipient.accessToken) return;
    const campaign = await this.campaignRepo.findOne({
      where: { id: recipient.campaignId, adminId },
    });
    if (!campaign?.enablePurchasePage || !campaign.orderReplyFollowupEnabled) {
      return;
    }
    const followupText = this.matchButtonReplyText(campaign, reply);
    if (!followupText) {
      return;
    }

    const url = buildCampaignOrderUrl(recipient.accessToken);
    const body = substituteFollowupOrderUrl(
      hydrateCampaignPlaceholders(followupText, {
        name: recipient.name,
        phoneNumber: recipient.phoneNumber,
        orderToken: recipient.accessToken,
        orderUrl: url,
      }),
      url,
    );
    const accountId = campaign.templateConfigSnapshot?.accountId;
    await this.whatsappService.sendMessage(
      { id: adminId, adminId } as any,
      {
        messaging_product: "whatsapp",
        type: "text",
        to: recipient.phoneNumber,
        text: { body, preview_url: true },
      },
      accountId,
    );
    await this.recipientRepo.query(
      `
      UPDATE campaign_recipients
      SET "updatedAt" = NOW()
      WHERE id = $1
      `,
      [recipient.id],
    );
  }

  // Matches the tapped button to its configured automatic reply.
  private matchButtonReplyText(
    campaign: CampaignEntity,
    reply: { buttonText?: string | null; buttonId?: string | null },
  ): string | null {
    const incoming = String(reply.buttonText || "").trim().toLowerCase();
    if (!incoming) return null;
    const followups = Array.isArray(campaign.orderReplyFollowups)
      ? campaign.orderReplyFollowups
      : [];
    const matched = followups.find(
      (entry) =>
        String(entry?.buttonText || "").trim().toLowerCase() === incoming,
    );
    return matched?.text ? String(matched.text) : null;
  }

  private async markDelivered(recipientId: string, at: Date): Promise<void> {
    const rows = await this.queryRows<{ campaignId: string }>(
      `
      UPDATE campaign_recipients
      SET
        "deliveredAt" = $2,
        "deliveryStatus" = $3,
        "updatedAt" = NOW()
      WHERE id = $1
        AND "deliveredAt" IS NULL
        AND "deliveryStatus" NOT IN ($4, $5)
      RETURNING "campaignId"
      `,
      [
        recipientId,
        at,
        CampaignRecipientDeliveryStatus.DELIVERED,
        CampaignRecipientDeliveryStatus.READ,
        CampaignRecipientDeliveryStatus.FAILED,
      ],
    );
    const campaignId = rows[0]?.campaignId;
    if (!campaignId) return;
    await this.campaignRepo.increment({ id: campaignId }, "deliveredCount", 1);
  }

  private async markRead(recipientId: string, at: Date): Promise<void> {
    const rows = await this.queryRows<{ campaignId: string }>(
      `
      UPDATE campaign_recipients
      SET
        "readAt" = $2,
        "isRead" = true,
        "deliveryStatus" = $3,
        "updatedAt" = NOW()
      WHERE id = $1
        AND "readAt" IS NULL
        AND "deliveryStatus" <> $4
      RETURNING "campaignId"
      `,
      [
        recipientId,
        at,
        CampaignRecipientDeliveryStatus.READ,
        CampaignRecipientDeliveryStatus.FAILED,
      ],
    );
    const campaignId = rows[0]?.campaignId;
    if (!campaignId) return;
    await this.campaignRepo.increment({ id: campaignId }, "readCount", 1);
  }

  private async resolveRecipientId(
    adminId: string,
    providerMessageId?: string | null,
    campaignRecipientId?: string | null,
  ): Promise<string | null> {
    if (providerMessageId) {
      const byProviderId = await this.recipientRepo.findOne({
        where: { adminId, messageId: providerMessageId },
        select: { id: true },
      });
      if (byProviderId) return byProviderId.id;
    }
    if (campaignRecipientId) {
      const byId = await this.recipientRepo.findOne({
        where: { adminId, id: campaignRecipientId },
        select: { id: true },
      });
      if (byId) return byId.id;
    }
    return null;
  }

  private async queryRows<T>(sql: string, params: any[]): Promise<T[]> {
    const result = await this.recipientRepo.query(sql, params);
    const rows = Array.isArray(result?.[0]) ? result[0] : result;
    return Array.isArray(rows) ? rows : [];
  }

  private async emitCampaignLive(
    adminId: string,
    recipientId: string,
    reason: string,
  ) {
    const recipient = await this.recipientRepo.findOne({
      where: { id: recipientId, adminId },
      select: {
        id: true,
        campaignId: true,
        deliveryStatus: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
        failedAt: true,
        hasReplied: true,
        costAmount: true,
      },
    });
    if (!recipient?.campaignId) return;
    await this.emitCampaignLiveByCampaign(adminId, recipient.campaignId, reason, {
      id: recipient.id,
      deliveryStatus: recipient.deliveryStatus,
      sentAt: recipient.sentAt,
      deliveredAt: recipient.deliveredAt,
      readAt: recipient.readAt,
      failedAt: recipient.failedAt,
      hasReplied: recipient.hasReplied,
      costAmount: recipient.costAmount,
    });
  }

  private async emitCampaignLiveByCampaign(
    adminId: string,
    campaignId: string,
    reason: string,
    recipient?: Record<string, unknown> | null,
  ) {
    try {
      const campaign = await this.campaignRepo.findOne({
        where: { id: campaignId, adminId },
      });
      if (!campaign) return;
      this.appGateway.emitCampaignUpdated(adminId, {
        campaign: campaign as unknown as Record<string, unknown>,
        reason,
        recipient: recipient ?? null,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to emit campaign live update ${campaignId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
