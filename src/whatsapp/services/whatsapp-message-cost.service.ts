import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  MessageDirection,
  WhatsappMessageEntity,
} from "entities/whatsapp.entity";
import { resolveWhatsappMessageCost } from "../whatsapp-pricing.rates";

@Injectable()
export class WhatsappMessageCostService {
  private readonly logger = new Logger(WhatsappMessageCostService.name);

  constructor(
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,
  ) {}

  async applyFromDelivery(input: {
    message: WhatsappMessageEntity;
    pricing?: any;
  }): Promise<void> {
    const message = input.message;
    if (!message?.id) return;
    if (message.direction === MessageDirection.INBOUND) return;

    const pricing = input.pricing || message.metadata?.pricing;
    const resolved = resolveWhatsappMessageCost({
      pricing,
      phone: message.contactNumber,
    });

    try {
      if (resolved) {
        const charged = await this.queryRows<{
          id: string;
          accountId: string;
          costAmount: string | number;
          messageId: string;
        }>(
          `
          UPDATE whatsapp_messages
          SET
            "costAmount" = $2,
            "costCurrency" = $3,
            "costChargedAt" = NOW(),
            "pricingCategory" = $4,
            "pricingType" = $5,
            "updatedAt" = NOW()
          WHERE id = $1 AND "costChargedAt" IS NULL
          RETURNING id, "accountId", "costAmount", "messageId"
          `,
          [
            message.id,
            resolved.amount,
            resolved.currency,
            resolved.category,
            resolved.type,
          ],
        );
        const row = charged[0];
        if (row) {
          const amount = Number(row.costAmount || 0);
          if (amount > 0 && row.accountId) {
            await this.messageRepo.query(
              `
              UPDATE whatsapp_accounts
              SET "costAmount" = COALESCE("costAmount", 0) + $2, "updatedAt" = NOW()
              WHERE id = $1
              `,
              [row.accountId, amount],
            );
          }
        }
      }

      await this.syncRecipientByProviderMessageId(message.messageId);
    } catch (error) {
      this.logger.error(
        `Failed to charge WhatsApp message ${message.id}: ${error?.message}`,
        error?.stack,
      );
      throw error;
    }
  }

  async syncRecipientByProviderMessageId(providerMessageId?: string | null) {
    if (!providerMessageId) return;
    const message = await this.messageRepo.findOne({
      where: { messageId: providerMessageId },
      select: { messageId: true, costAmount: true, costChargedAt: true },
    });
    if (!message?.costChargedAt) return;
    await this.attachCampaignCost(
      message.messageId,
      Number(message.costAmount || 0),
    );
  }

  async syncRecipientFromLinkedMessage(
    campaignRecipientId: string,
    whatsappMessageId: string,
  ) {
    if (!campaignRecipientId || !whatsappMessageId) return;
    const rows = await this.queryRows<{
      campaignId: string;
      costAmount: string | number;
    }>(
      `
      UPDATE campaign_recipients r
      SET
        "costAmount" = COALESCE(m."costAmount", 0),
        "costChargedAt" = COALESCE(m."costChargedAt", NOW()),
        "updatedAt" = NOW()
      FROM whatsapp_messages m
      WHERE r.id = $1
        AND m.id = $2
        AND r."costChargedAt" IS NULL
        AND m."costChargedAt" IS NOT NULL
      RETURNING r."campaignId" AS "campaignId", r."costAmount" AS "costAmount"
      `,
      [campaignRecipientId, whatsappMessageId],
    );
    await this.incrementCampaigns(rows);
  }

  private async attachCampaignCost(providerMessageId: string, amount: number) {
    const rows = await this.queryRows<{
      campaignId: string;
      costAmount: string | number;
    }>(
      `
      UPDATE campaign_recipients
      SET
        "costAmount" = $2,
        "costChargedAt" = NOW(),
        "updatedAt" = NOW()
      WHERE "messageId" = $1 AND "costChargedAt" IS NULL
      RETURNING "campaignId", "costAmount"
      `,
      [providerMessageId, amount],
    );
    await this.incrementCampaigns(rows);
  }

  private async incrementCampaigns(
    rows: Array<{ campaignId: string; costAmount: string | number }>,
  ) {
    for (const row of rows) {
      const amount = Number(row.costAmount || 0);
      if (!row.campaignId || !(amount > 0)) continue;
      await this.messageRepo.query(
        `
        UPDATE campaigns
        SET "costAmount" = COALESCE("costAmount", 0) + $2, "updatedAt" = NOW()
        WHERE id = $1
        `,
        [row.campaignId, amount],
      );
    }
  }

  private async queryRows<T>(sql: string, params: any[]): Promise<T[]> {
    const result = await this.messageRepo.query(sql, params);
    const rows = Array.isArray(result?.[0]) ? result[0] : result;
    return Array.isArray(rows) ? rows : [];
  }
}
