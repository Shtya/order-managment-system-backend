import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiRequestSummaryEntity, AiWriteToolCallEntity } from '../../entities/ai.entity';
import { OrdersModule } from '../orders/orders.module';
import { ShippingModule } from '../shipping/shipping.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { CitiesModule } from '../cities/cities.module';
import { AI_CONFIG_TOKEN, AI_PROVIDER_TOKEN, AI_TOOL_NAMESPACE_TOKEN } from './ai.constants';
import { aiConfigFactoryProvider } from './ai.config';
import { AiConfig } from './interfaces/provider-config.interface';
import { Llm7Provider } from './providers/llm7.provider';
import { PollinationsProvider } from './providers/pollinations.provider';
import { AiToolRegistryService } from './tools/ai-tool-registry.service';
import { OrdersAiTools } from './tools/tools/orders.tools';
import { ShippingAiTools } from './tools/tools/shipping.tools';
import { WhatsappAiTools } from './tools/tools/whatsapp.tools';
import { AiProviderSelectorService } from './orchestrator/provider-selector.service';
import { AiSystemPromptService } from './orchestrator/ai-system-prompt.service';
import { AiLoggerService } from './orchestrator/ai-logger.service';
import { AiAuditService } from './orchestrator/ai-audit.service';
import { AiOrchestratorService } from './orchestrator/ai-orchestrator.service';
import { AiPiiMaskerService } from './security/ai-pii-masker.service';
import { AiAccessGuard } from './security/ai-access.guard';
import { AiController } from './ai.controller';

@Module({
	imports: [
		TypeOrmModule.forFeature([AiRequestSummaryEntity, AiWriteToolCallEntity]),
		OrdersModule,
		ShippingModule,
		WhatsappModule,
		CitiesModule,
	],
	controllers: [AiController],
	providers: [
		aiConfigFactoryProvider,
		{
			provide: AI_PROVIDER_TOKEN,
			useFactory: (config: AiConfig) => {
				const llm7Config = config.providers.find((p) => p.name === 'llm7');
				const pollinationsConfig = config.providers.find((p) => p.name === 'pollinations');
				if (!llm7Config) throw new Error('llm7 provider config is missing');
				if (!pollinationsConfig) throw new Error('pollinations provider config is missing');
				return [new Llm7Provider(llm7Config), new PollinationsProvider(pollinationsConfig)];
			},
			inject: [AI_CONFIG_TOKEN],
		},
		OrdersAiTools,
		ShippingAiTools,
		WhatsappAiTools,
		{
			provide: AI_TOOL_NAMESPACE_TOKEN,
			useFactory: (
				ordersTools: OrdersAiTools,
				shippingTools: ShippingAiTools,
				whatsappTools: WhatsappAiTools,
			) => [ordersTools, shippingTools, whatsappTools],
			inject: [OrdersAiTools, ShippingAiTools, WhatsappAiTools],
		},
		AiToolRegistryService,
		AiProviderSelectorService,
		AiSystemPromptService,
		AiLoggerService,
		AiAuditService,
		AiOrchestratorService,
		AiPiiMaskerService,
		AiAccessGuard,
	],
	exports: [AiOrchestratorService, AiToolRegistryService],
})
export class AiModule {}
