import {
  CampaignChannel as CampaignChannelEnum,
  CampaignEntity,
  CampaignRecipientEntity,
} from "entities/campaigns.entity";
import type { CreateCampaignDto } from "dto/campaign.dto";

export type ValidatedCampaignChannelData = {
  templateId: string;
  snapshot: Record<string, any>;
} | null;

// Mirrors ShippingProvider / SmsProvider: each channel owns its
// validation and tenant checks; core only stores the normalized result.
export abstract class CampaignChannel {
  abstract readonly channel: CampaignChannelEnum;

  abstract validateChannelData(
    adminId: string,
    dto: Pick<CreateCampaignDto, "whatsapp" | "sms" | "email">,
    opts?: { requireData?: boolean },
  ): Promise<ValidatedCampaignChannelData>;

  // Sends one materialized recipient. Throws retryable provider errors
  // for BullMQ retries; throw UnrecoverableError (bullmq) for fatal ones.
  abstract sendRecipient(
    adminId: string,
    campaign: CampaignEntity,
    recipient: CampaignRecipientEntity,
  ): Promise<SendRecipientResult>;

  // Send-readiness of a stored campaign (template still usable, ...).
  // Called at start(); per-recipient failures stay fatal at send time.
  abstract assertSendable(
    adminId: string,
    campaign: CampaignEntity,
  ): Promise<void>;
}

export type SendRecipientResult = {
  providerMessageId: string;
  cost?: number;
};
