import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AI_CONFIG_TOKEN, AI_PROVIDER_DEFAULTS } from '../ai.constants';
import { AiConfig, AiProviderRuntimeConfig } from '../interfaces/provider-config.interface';
import { AiProviderAbstract, boolEnv, intEnv, floatEnv, strEnv } from '../providers/ai-provider.abstract';
import { AiProviderError } from '../errors/provider.errors';
import { AiDefaultModelEntity, AiEntityScope, AiIntegrationEntity, AiIntegrationScope, AiProviderEntity } from '../../../entities/ai.entity';
import { EncryptionService } from '../../../common/encryption.service';
import { Llm7Provider } from '../providers/llm7.provider';
import { OpenAiProvider } from '../providers/openai.provider';
import { AnthropicProvider } from '../providers/anthropic.provider';

import { DeepSeekProvider } from '../providers/deepseek.provider';
import { GoogleProvider } from '../providers/google.provider';
import { PollinationsProvider } from '../providers/pollinations.provider';
import { OpenAiCompatibleProviderImpl } from '../providers/openai-compatible.provider';

@Injectable()
export class AiProviderSelectorService implements OnModuleInit {
	private readonly logger = new Logger(AiProviderSelectorService.name);
	private providersByKind = new Map<string, AiProviderAbstract>();
	private allKinds: string[] = [];

	constructor(
		@Inject(AI_CONFIG_TOKEN) private readonly config: AiConfig,

		private readonly llm7: Llm7Provider,
		private readonly openai: OpenAiProvider,
		private readonly anthropic: AnthropicProvider,
		private readonly deepseek: DeepSeekProvider,
		private readonly google: GoogleProvider,
		private readonly pollinations: PollinationsProvider,
		private readonly openAiCompatible: OpenAiCompatibleProviderImpl,

		@InjectRepository(AiProviderEntity)
		private readonly providerRepo: Repository<AiProviderEntity>,
		@InjectRepository(AiIntegrationEntity)
		private readonly integrationRepo: Repository<AiIntegrationEntity>,
		@InjectRepository(AiDefaultModelEntity)
		private readonly defaultModelRepo: Repository<AiDefaultModelEntity>,
		private readonly encryptionService: EncryptionService,
	) {}

	onModuleInit() {
		const all: AiProviderAbstract[] = [
			this.llm7,
			this.openai,
			this.anthropic,
			this.deepseek,
			this.google,
			this.pollinations,
			this.openAiCompatible,
		];
		for (const p of all) {
			this.providersByKind.set(p.kind, p);
		}
		this.allKinds = all.filter((p) => p.isEnabled()).map((p) => p.kind);
	}

	async select(requestedName?: string, tenantId?: string | null): Promise<AiProviderAbstract> {
		if (requestedName) {
			// UUID → entity-based provider (custom providers via DB)
			if (requestedName.length === 36 && requestedName.includes('-')) {
				const entity = await this.providerRepo.findOne({
					where: [
						{ id: requestedName, isActive: true, adminId: tenantId ?? undefined },
						{ id: requestedName, isActive: true, adminId: null },
					],
					relations: ['models', 'integrations'],
				});
				if (entity) {
					if (tenantId && entity.adminId && entity.adminId !== tenantId) {
						throw new Error(`AI provider '${requestedName}' not accessible for this tenant`);
					}
					if (!this.hasIntegrationConfig(entity, tenantId)) {
						throw new Error(`AI provider '${requestedName}' is not configured`);
					}
					const injectable = this.pickInjectableForEntity(entity);
					const runtime = await this.resolveRuntimeConfig(entity, injectable?.kind ?? 'custom', tenantId);
					const base = injectable ?? this.llm7;
					return base.cloneWithRuntime(runtime);
				}

				throw new Error(`AI provider '${requestedName}' not found or inactive`);
			} else {
				// Name (code like 'openai') → match injectable by kind, and find entity by code
				const injectable = this.providersByKind.get(requestedName);
				if (injectable) {
					if (!injectable.isEnabled() && this.enabledProviders().length > 1) {
						throw new Error(`AI provider '${requestedName}' is disabled`);
					}
					const entity = await this.providerRepo.findOne({
						where: [
							{ code: requestedName, isActive: true, adminId: tenantId ?? undefined },
							{ code: requestedName, isActive: true, adminId: null },
						],
						relations: ['models', 'integrations'],
					});
					if (entity && !this.hasIntegrationConfig(entity, tenantId)) {
						throw new Error(`AI provider '${requestedName}' is not configured`);
					}
					const runtime = await this.resolveRuntimeConfig(entity, requestedName, tenantId);
					return injectable.cloneWithRuntime(runtime);
				}

				// Custom provider by code (not in system providersByKind) → resolve via protocol
				const entity = await this.providerRepo.findOne({
					where: [
						{ code: requestedName, isActive: true, adminId: tenantId ?? undefined },
						{ code: requestedName, isActive: true, adminId: null },
					],
					relations: ['models', 'integrations'],
				});
				if (entity) {
					if (tenantId && entity.adminId && entity.adminId !== tenantId) {
						throw new Error(`AI provider '${requestedName}' not accessible for this tenant`);
					}
					if (!this.hasIntegrationConfig(entity, tenantId)) {
						throw new Error(`AI provider '${requestedName}' is not configured`);
					}
					const resolved = this.pickInjectableForEntity(entity);
					const runtime = await this.resolveRuntimeConfig(entity, resolved?.kind ?? requestedName, tenantId);
					const base = resolved ?? this.llm7;
					return base.cloneWithRuntime(runtime);
				}

				throw new Error(`AI provider '${requestedName}' not found or inactive`);
			}
		}

		// Fallback: default provider from config (e.g. 'llm7')
		const defaultKind = this.config.defaultProvider;
		const fallback = this.providersByKind.get(defaultKind)
			?? this.enabledProviders()[0];

		if (!fallback) {
			throw new Error('No enabled AI provider is available');
		}

		const entity = await this.providerRepo.findOne({
			where: [{ code: fallback.kind, isActive: true, adminId: null }],
			relations: ['models', 'integrations'],
		});
		if (entity && !this.hasIntegrationConfig(entity, tenantId)) {
			throw new Error(`AI provider '${fallback.kind}' is not configured`);
		}
		const runtime = await this.resolveRuntimeConfig(entity, fallback.kind, tenantId);
		return fallback.cloneWithRuntime(runtime);
	}

	async selectCustom(entityId: string, tenantId?: string | null): Promise<AiProviderAbstract> {
		const entity = await this.providerRepo.findOne({
			where: [
				{ id: entityId, isActive: true, adminId: tenantId ?? undefined },
				{ id: entityId, isActive: true, adminId: null },
			],
			relations: ['models', 'integrations'],
		});

		if (!entity) {
			throw new AiProviderError(`Provider '${entityId}' not found or inactive`, {
				kind: 'INVALID_RESPONSE',
				provider: entityId,
			});
		}

		if (tenantId && entity.adminId && entity.adminId !== tenantId) {
			throw new AiProviderError(`Provider '${entityId}' not accessible for this tenant`, {
				kind: 'INVALID_RESPONSE',
				provider: entityId,
			});
		}

		const hasConfig = this.hasIntegrationConfig(entity, tenantId);
		if (!hasConfig) {
			throw new AiProviderError(`Provider '${entityId}' is not configured`, {
				kind: 'INVALID_RESPONSE',
				provider: entityId,
			});
		}

		const injectable = this.pickInjectableForEntity(entity);
		const runtime = await this.resolveRuntimeConfig(entity, injectable?.kind ?? 'custom', tenantId);
		const base = injectable ?? this.llm7;
		return base.cloneWithRuntime(runtime);
	}

	async resolveDefaultModel(tenantId?: string | null): Promise<{ modelCode: string; providerEntityId: string } | null> {
		if (tenantId) {
			const record = await this.defaultModelRepo.findOne({
				where: { adminId: tenantId },
				relations: ['model', 'model.provider'],
			});
			if (record?.model?.provider?.isActive) {
				return { modelCode: record.model.modelCode, providerEntityId: record.model.provider.id };
			}
		}

		const systemDefault = await this.defaultModelRepo.findOne({
			where: { adminId: null },
			relations: ['model', 'model.provider'],
		});
		if (systemDefault?.model?.provider?.isActive) {
			return { modelCode: systemDefault.model.modelCode, providerEntityId: systemDefault.model.provider.id };
		}

		return null;
	}

	async resolveProviderByModelId(modelCode: string, tenantId?: string | null): Promise<string | null> {
		const model = await this.defaultModelRepo.manager.getRepository('AiModelEntity').findOne({
			where: { modelCode },
			relations: ['provider'],
		}) as any;

		if (model?.provider?.isActive) {
			return model.provider.id;
		}

		return null;
	}

	async failoverCandidates(excludeName?: string, tenantId?: string | null): Promise<AiProviderAbstract[]> {
		const out: AiProviderAbstract[] = [];
		for (const kind of this.allKinds) {
			if (kind === excludeName) continue;
			const p = this.providersByKind.get(kind);
			if (!p?.isEnabled()) continue;

			try {
				const cloned = await this.select(kind, tenantId);
				if (cloned) out.push(cloned);
			} catch {
				// skip providers that fail to resolve
			}
		}
		return out.sort((a, b) => (a.getConfig().priority ?? 100) - (b.getConfig().priority ?? 100));
	}

	listAvailableKinds(): string[] {
		return [...this.allKinds];
	}

	getAllBaseProviders(): AiProviderAbstract[] {
		return [...this.providersByKind.values()];
	}

	// --- private helpers ---

	private enabledProviders(): AiProviderAbstract[] {
		return Array.from(this.providersByKind.values()).filter((p) => p.isEnabled());
	}

	private pickInjectableForEntity(entity: AiProviderEntity | null): AiProviderAbstract | undefined {
		if (!entity) return undefined;
		// CUSTOM providers with a protocol: map by protocol (same as resolveBaseProvider)
		if (entity.scope === AiEntityScope.CUSTOM && entity.protocol) {
			return this.providersByKind.get(entity.protocol);
		}
		// System providers: map by code, then by protocol
		if (entity.code && this.providersByKind.has(entity.code)) {
			return this.providersByKind.get(entity.code);
		}
		if (entity.protocol) {
			return this.providersByKind.get(entity.protocol);
		}
		return undefined;
	}

	private hasIntegrationConfig(entity: AiProviderEntity, tenantId?: string | null): boolean {
		const candidates = entity.integrations ?? [];
		let integration: AiIntegrationEntity | undefined;
		if (tenantId) {
			integration = candidates.find((i) => i.scope === AiIntegrationScope.TENANT && i.adminId === tenantId)
				?? candidates.find((i) => i.scope === AiIntegrationScope.SYSTEM && !i.adminId);
		} else {
			integration = candidates.find((i) => i.scope === AiIntegrationScope.SYSTEM && !i.adminId);
		}
		return !!(integration?.encryptedCredentials);
	}

	private async resolveRuntimeConfig(
		entity: AiProviderEntity | null,
		fallbackKind: string,
		tenantId?: string | null,
	): Promise<AiProviderRuntimeConfig> {
		let integration: AiIntegrationEntity | undefined;
		if (entity) {
			const candidates = entity.integrations ?? [];
			if (tenantId) {
				integration = candidates.find((i) => i.scope === AiIntegrationScope.TENANT && i.adminId === tenantId)
					?? candidates.find((i) => i.scope === AiIntegrationScope.SYSTEM && !i.adminId);
			} else {
				integration = candidates.find((i) => i.scope === AiIntegrationScope.SYSTEM && !i.adminId);
			}
		}

		const runtime: AiProviderRuntimeConfig = {};

		if (entity) runtime.entityId = entity.id;

		// Extract env defaults for this kind (fallback if no integration row)
		const prefix = `AI_${fallbackKind.toUpperCase().replace(/-/g, '_')}`;
		const envApiKey = strEnv(process.env[`${prefix}_API_KEY`], '');
		const envBaseUrl = strEnv(process.env[`${prefix}_BASE_URL`], '');
		const envModel = strEnv(process.env[`${prefix}_MODEL`], '');
		const envMaxTokens = intEnv(process.env[`${prefix}_MAX_TOKENS`], AI_PROVIDER_DEFAULTS.MAX_TOKENS);
		const envTemperature = floatEnv(process.env[`${prefix}_TEMPERATURE`], AI_PROVIDER_DEFAULTS.TEMPERATURE);
		const envRetries = intEnv(process.env[`${prefix}_RETRIES`], AI_PROVIDER_DEFAULTS.RETRIES);

		runtime.maxTokens = envMaxTokens;
		runtime.temperature = envTemperature;
		runtime.retries = envRetries;
		runtime.model = envModel;
		runtime.baseUrl = envBaseUrl;
		runtime.apiKey = envApiKey;

		if (integration?.baseUrl) runtime.baseUrl = integration.baseUrl;

		if (integration?.encryptedCredentials) {
			try {
				const { ciphertext, iv, tag } = integration.encryptedCredentials as any;
				const raw = await this.encryptionService.decrypt(ciphertext, iv, tag);
				let d: any;
				if (typeof raw === 'object' && raw !== null) {
					d = raw;
				} else if (typeof raw === 'string') {
					try { d = JSON.parse(raw); } catch { d = null; }
				}

				if (d && typeof d === 'object') {
					runtime.apiKey = d.apiKey ?? d.apikey ?? d.api_Key ?? d.token ?? runtime.apiKey;
					if (typeof d.baseUrl === 'string') runtime.baseUrl = d.baseUrl;
					if (typeof d.model === 'string') runtime.model = d.model;
					if (typeof d.maxTokens === 'number') runtime.maxTokens = d.maxTokens;
					if (typeof d.temperature === 'number') runtime.temperature = d.temperature;
					if (typeof d.retries === 'number') runtime.retries = d.retries;
				} else if (typeof raw === 'string') {
					runtime.apiKey = raw;
				}
			} catch {
				// keep env fallback
			}
		}

		return runtime;
	}
}
