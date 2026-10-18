import { EntityManager } from "typeorm";
import { EmailAssetsService } from "src/email/email-assets.service";
import { emailAssetIds } from "src/email/email-document";
import { TranslationService } from "common/translation.service";
import { BadRequestException, Injectable } from "@nestjs/common";
import {
  CampaignChannel as Channel,
  CampaignEntity,
  CampaignRecipientEntity,
} from "entities/campaigns.entity";
import { CreateCampaignDto } from "dto/campaign.dto";
import { EmailAccountsService } from "src/email/email-accounts.service";
import { EmailContentService } from "src/email/email-content.service";
import { EmailService } from "src/email/email.service";
import { EmailPolicyService } from "src/email/email-policy.service";
import { EmailDeferredError } from "src/email/email.types";
import { CampaignChannel } from "./campaign-channel.abstract";
import { buildCampaignOrderUrl } from "../campaign-order-url";

@Injectable()
export class EmailCampaignChannel extends CampaignChannel {
  readonly channel = Channel.EMAIL;
  constructor(
    private readonly accounts: EmailAccountsService,
    private readonly content: EmailContentService,
    private readonly email: EmailService,
    private readonly policy: EmailPolicyService,
    private readonly translations: TranslationService,
    private readonly assets: EmailAssetsService,
  ) {
    super();
  }
  exclusionReason(adminId: string, recipient: { email?: string | null }) {
    return this.policy.eligibility(adminId, recipient.email, "marketing");
  }
  async validateChannelData(
    adminId: string,
    dto: Pick<CreateCampaignDto, "whatsapp" | "sms" | "email">,
    opts?: { requireData?: boolean; actorId?: string },
  ) {
    if (!dto.email) {
      if (opts?.requireData === false) return null;
      throw new BadRequestException(
        this.translations.t("domains.email.config_required"),
      );
    }
    const { accountId, ...content } = dto.email;
    if (!opts?.actorId)
      throw new BadRequestException(
        this.translations.t("domains.email.sender_owner_required"),
      );
    this.accounts.assertEnabled();
    await this.accounts.get({ adminId, actorId: opts.actorId }, accountId);
    this.content.validate(content);
    if (content.document.schemaVersion === 2)
      await this.assets.retain(
        adminId,
        emailAssetIds(content.document),
        undefined,
      );
    return { snapshot: { ...content, accountId, ownerId: opts.actorId } };
  }
  async retainSavedAssets(
    adminId: string,
    campaign: CampaignEntity,
    transaction: EntityManager,
  ) {
    const document = (campaign.templateConfigSnapshot as any)?.document;
    if (document?.schemaVersion === 2)
      await this.assets.retain(
        adminId,
        emailAssetIds(document),
        "saved",
        transaction,
      );
  }
  async assertSendable(adminId: string, campaign: CampaignEntity) {
    const snapshot = campaign.templateConfigSnapshot as any;
    this.accounts.assertEnabled();
    await this.accounts.get(
      { adminId, actorId: snapshot?.ownerId },
      snapshot?.accountId,
    );
    this.content.validate(snapshot);
    const tokens = JSON.stringify(snapshot);
    if (
      !campaign.enablePurchasePage &&
      /\{\{\s*campaign\.(?:orderUrl|orderToken)\s*\}\}/.test(tokens)
    )
      throw new BadRequestException(
        this.translations.t("domains.email.purchase_page_required"),
      );
  }
  async sendRecipient(
    adminId: string,
    campaign: CampaignEntity,
    recipient: CampaignRecipientEntity,
  ) {
    const s = campaign.templateConfigSnapshot as any;
    try {
    const message = await this.email.send(
      { adminId, actorId: s.ownerId },
      {
        accountId: s.accountId,
        to: recipient.email,
        purpose: "marketing",
        idempotencyKey: `campaign:${campaign.id}:${recipient.id}`,
        source: {
          type: "campaign",
          id: campaign.id,
          recipientId: recipient.id,
        },
        content: {
          subject: s.subject,
          preheader: s.preheader,
          document: s.document,
          businessIdentity: s.businessIdentity,
        },
        variables: {
          "customer.name":
            recipient.name?.trim() || this.translations.t("common.there"),
          "customer.number": recipient.phoneNumber || "-",
          "customer.email": recipient.email,
          "campaign.orderToken": recipient.accessToken || "",
          "campaign.orderUrl": recipient.accessToken
            ? buildCampaignOrderUrl(recipient.accessToken)
            : "",
        },
      },
    );
    if (message.status === "queued" || message.status === "sending")
      throw new EmailDeferredError("email.pending");
    return {
      providerMessageId: message.providerMessageId || message.id,
      outcome: message.status as
        "accepted" | "suppressed" | "failed" | "unknown",
        reason: message.reason,
      };
    } catch (error) {
      console.error("Error sending email:", error);
      if (error instanceof EmailDeferredError) throw error;
      throw new BadRequestException(error.message);
    }
  }
}
