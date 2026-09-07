import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  CampaignEntity,
  CampaignExcludedRecipientEntity,
  CampaignProductEntity,
  CampaignRecipientEntity,
} from "entities/campaigns.entity";
import { ClientSegmentEntity } from "entities/clients-segments.entity";
import { WhatsappTemplateEntity } from "entities/whatsapp.entity";
import { AudienceModule } from "src/audience/audience.module";
import { ClientSegmentsModule } from "src/client-segments/client-segments.module";
import { WhatsappModule } from "src/whatsapp/whatsapp.module";
import { QueueModule } from "src/queue/queue.module";
import { OrphanFilesModule } from "src/orphan-files/orphan-files.module";
import { CampaignsService } from "./campaigns.service";
import { CampaignWebhookEventsService } from "./campaign-webhook-events.service";
import { CampaignsController } from "./campaigns.controller";
import { WhatsappCampaignChannel } from "./channels/whatsapp-campaign.channel";
import { ManualCampaignAudience } from "./audience/manual-campaign.audience";
import { FileCampaignAudience } from "./audience/file-campaign.audience";
import { FilterCampaignAudience } from "./audience/filter-campaign.audience";
import { SegmentCampaignAudience } from "./audience/segment-campaign.audience";

@Module({
  imports: [
    AudienceModule,
    ClientSegmentsModule,
    forwardRef(() => WhatsappModule),
    forwardRef(() => QueueModule),
    OrphanFilesModule,
    TypeOrmModule.forFeature([
      CampaignEntity,
      CampaignProductEntity,
      CampaignExcludedRecipientEntity,
      CampaignRecipientEntity,
      ClientSegmentEntity,
      WhatsappTemplateEntity,
    ]),
  ],
  controllers: [CampaignsController],
  providers: [
    CampaignsService,
    CampaignWebhookEventsService,
    WhatsappCampaignChannel,
    ManualCampaignAudience,
    FileCampaignAudience,
    FilterCampaignAudience,
    SegmentCampaignAudience,
  ],
  exports: [
    CampaignsService,
    CampaignWebhookEventsService,
    WhatsappCampaignChannel,
  ],
})
export class CampaignsModule {}
