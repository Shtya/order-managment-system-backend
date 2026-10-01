import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  AiIntegrationEntity,
  AiModelEntity,
  AiProviderEntity,
  AiRequestSummaryEntity,
  AiWriteToolCallEntity,
  AiDefaultModelEntity,
  AiModelAvailabilityEntity,
} from "../../entities/ai.entity";
import { EncryptionService } from "../../common/encryption.service";
import { OrdersModule } from "../orders/orders.module";
import { ShippingModule } from "../shipping/shipping.module";
import { WhatsappModule } from "../whatsapp/whatsapp.module";
import { CitiesModule } from "../cities/cities.module";
import { AI_CONFIG_TOKEN, AI_TOOL_NAMESPACE_TOKEN } from "./ai.constants";
import { aiConfigFactoryProvider } from "./ai.config";
import { AiToolRegistryService } from "./tools/ai-tool-registry.service";
import { addressAiTools } from "./tools/tools/address.tools";
import { WhatsappAiTools } from "./tools/tools/whatsapp.tools";
import { AiProviderSelectorService } from "./orchestrator/provider-selector.service";
import { AiSystemPromptService } from "./orchestrator/ai-system-prompt.service";
import { AiLoggerService } from "./orchestrator/ai-logger.service";
import { AiAuditService } from "./orchestrator/ai-audit.service";
import { AiOrchestratorService } from "./orchestrator/ai-orchestrator.service";
import { AiPiiMaskerService } from "./security/ai-pii-masker.service";
import { AiAccessGuard } from "./security/ai-access.guard";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";
import { AiExportService } from "./ai-export.service";
import { AiModelHealthService } from "./orchestrator/ai-model-health.service";
import { AiTranscriptionService } from "./services/ai-transcription.service";
import { MediaUnderstandingModule } from "./media/media-understanding.module";
import { AiUsageModule } from "./usage/ai-usage.module";

// Concrete injectable providers (each reads its own env in constructor)
import { Llm7Provider } from "./providers/llm7.provider";
import { OpenAiProvider } from "./providers/openai.provider";
import { AnthropicProvider } from "./providers/anthropic.provider";
import { DeepSeekProvider } from "./providers/deepseek.provider";
import { GoogleProvider } from "./providers/google.provider";
import { PollinationsProvider } from "./providers/pollinations.provider";
import { OpenAiCompatibleProviderImpl } from "./providers/openai-compatible.provider";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AiProviderEntity,
      AiModelEntity,
      AiIntegrationEntity,
      AiRequestSummaryEntity,
      AiWriteToolCallEntity,
      AiDefaultModelEntity,
      AiModelAvailabilityEntity,
    ]),
    forwardRef(() => OrdersModule),
    forwardRef(() => ShippingModule),
    forwardRef(() => WhatsappModule),
    forwardRef(() => CitiesModule),
    MediaUnderstandingModule,
    AiUsageModule,
  ],
  controllers: [AiController],
  providers: [
    // 1. Config factory (module-level only — no provider configs anymore)
    aiConfigFactoryProvider,

    // 2. Concrete AI providers (singletons, env-read in ctor, per-request clones via selector)
    Llm7Provider,
    OpenAiProvider,
    AnthropicProvider,
    DeepSeekProvider,
    GoogleProvider,
    PollinationsProvider,
    OpenAiCompatibleProviderImpl,

    // 3. Tool namespaces
    addressAiTools,
    WhatsappAiTools,
    {
      provide: AI_TOOL_NAMESPACE_TOKEN,
      useFactory: (
        ordersTools: addressAiTools,
        whatsappTools: WhatsappAiTools,
      ) => [ordersTools, whatsappTools],
      inject: [addressAiTools, WhatsappAiTools],
    },

    // 4. Core orchestration services
    AiToolRegistryService,
    AiProviderSelectorService,
    AiSystemPromptService,
    AiLoggerService,
    AiAuditService,
    AiOrchestratorService,
    AiModelHealthService,
    AiPiiMaskerService,
    EncryptionService,
    AiService,
    AiExportService,
    AiTranscriptionService,
  ],
  exports: [
    AiOrchestratorService,
    AiTranscriptionService,
    AiAuditService,
    AiToolRegistryService,
    AiProviderSelectorService,
    MediaUnderstandingModule,
    AiUsageModule,
  ],
})
export class AiModule {}
