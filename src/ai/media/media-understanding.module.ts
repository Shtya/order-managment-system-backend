import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AgentMediaUsageEntity } from "entities/agent-conversation.entity";
import { AiIntegrationEntity } from "entities/ai.entity";
import { EncryptionService } from "common/encryption.service";
import { BillingModule } from "src/billing/billing.module";
import { AiUsageModule } from "src/ai/usage/ai-usage.module";
import { AgentMediaUsageService } from "./agent-media-usage.service";
import { MediaConfigService } from "./media-config.service";
import { MediaUnderstandingService } from "./media-understanding.service";
import { AudioMediaProcessor } from "./processors/audio.processor";
import { DocumentMediaProcessor } from "./processors/document.processor";
import { ImageMediaProcessor } from "./processors/image.processor";
import { VideoMediaProcessor } from "./processors/video.processor";

@Module({
  imports: [
    BillingModule,
    AiUsageModule,
    TypeOrmModule.forFeature([AgentMediaUsageEntity, AiIntegrationEntity]),
  ],
  providers: [
    EncryptionService,
    ImageMediaProcessor,
    VideoMediaProcessor,
    DocumentMediaProcessor,
    AudioMediaProcessor,
    AgentMediaUsageService,
    MediaConfigService,
    MediaUnderstandingService,
  ],
  exports: [MediaUnderstandingService, AgentMediaUsageService],
})
export class MediaUnderstandingModule {}
