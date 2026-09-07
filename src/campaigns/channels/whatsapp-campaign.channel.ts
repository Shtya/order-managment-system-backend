import { BadRequestException, forwardRef, Inject, Injectable } from "@nestjs/common";
import {
  CampaignChannel as CampaignChannelEnum,
  CampaignEntity,
  CampaignRecipientEntity,
} from "entities/campaigns.entity";
import { TemplateStatus } from "entities/whatsapp.entity";
import type { CreateCampaignDto } from "dto/campaign.dto";
import { TranslationService } from "common/translation.service";
import { WhatsappService } from "src/whatsapp/whatsapp.service";
import {
  CampaignChannel,
  SendRecipientResult,
  ValidatedCampaignChannelData,
} from "./campaign-channel.abstract";

@Injectable()
export class WhatsappCampaignChannel extends CampaignChannel {
  readonly channel = CampaignChannelEnum.WHATSAPP;

  constructor(
    private readonly translations: TranslationService,
    @Inject(forwardRef(() => WhatsappService))
    private readonly whatsappService: WhatsappService,
  ) {
    super();
  }

  async validateChannelData(
    adminId: string,
    dto: Pick<CreateCampaignDto, "whatsapp" | "sms" | "email">,
    opts?: { requireData?: boolean },
  ): Promise<ValidatedCampaignChannelData> {
    const requireData = opts?.requireData ?? true;
    const whatsapp = (dto as any)?.whatsapp;
    if (!whatsapp) {
      if (!requireData) return null;
      throw new BadRequestException(
        this.translations.t("domains.campaigns.whatsapp_config_required"),
      );
    }
    if (!whatsapp.templateId)
      throw new BadRequestException(
        this.translations.t(
          "domains.campaigns.whatsapp_template_id_required",
        ),
      );
    if (!whatsapp.accountId)
      throw new BadRequestException(
        this.translations.t(
          "domains.campaigns.whatsapp_account_id_required",
        ),
      );
    if (!whatsapp.templateData || typeof whatsapp.templateData !== "object")
      throw new BadRequestException(
        this.translations.t(
          "domains.campaigns.whatsapp_template_data_required",
        ),
      );

    await this.assertTemplateOwned(
      adminId,
      whatsapp.templateId,
      whatsapp.accountId,
    );

    return {
      templateId: whatsapp.templateId,
      snapshot: {
        accountId: whatsapp.accountId,
        templateData: whatsapp.templateData,
        headerUrl: whatsapp.headerUrl,
        useOrderFirstItemImage: whatsapp.useOrderFirstItemImage,
        bodyVariables: whatsapp.bodyVariables,
        headerVariables: whatsapp.headerVariables,
        buttonVariables: whatsapp.buttonVariables,
        locationData: whatsapp.locationData,
      },
    };
  }

  async sendRecipient(
    adminId: string,
    campaign: CampaignEntity,
    recipient: CampaignRecipientEntity,
  ): Promise<SendRecipientResult> {
    const snapshot = (campaign.templateConfigSnapshot ?? {}) as any;
    const response = await this.whatsappService.sendTemplate(
      { id: adminId, adminId } as any,
      {
        to: recipient.phoneNumber,
        templateId: campaign.templateId as string,
        headerVariables: snapshot.headerVariables,
        bodyVariables: snapshot.bodyVariables,
        buttonVariables: snapshot.buttonVariables,
        locationData: snapshot.locationData,
        headerUrl: snapshot.headerUrl,
      },
      snapshot.accountId,
      `campaign-${campaign.id}-${recipient.id}`,
      {
        campaignId: campaign.id,
        campaignRecipientId: recipient.id,
        channel: "whatsapp",
      },
    );

    const providerMessageId = response?.messages?.[0]?.id;
    if (!providerMessageId) {
      throw new Error("whatsapp_send_no_message_id");
    }

    return { providerMessageId };
  }

  async assertSendable(adminId: string, campaign: CampaignEntity) {
    const accountId = campaign.templateConfigSnapshot?.accountId;
    if (!campaign.templateId || !accountId) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.whatsapp_config_required"),
      );
    }
    await this.assertTemplateOwned(adminId, campaign.templateId, accountId);
  }

  private async assertTemplateOwned(
    adminId: string,
    templateId: string,
    accountId: string,
  ) {
    const template = await this.whatsappService.findTemplateForAccount(
      adminId,
      accountId,
      { id: templateId },
    );
    if (
      !template ||
      !template.isActive ||
      template.status !== TemplateStatus.APPROVED
    ) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.template_not_found"),
      );
    }
  }
}
