import { Provider, FactoryProvider } from '@nestjs/common';
import { AI_CONFIG_TOKEN } from './ai.constants';
import { AiConfig } from './interfaces/provider-config.interface';

export type AiEnvProviderConfig = {
	name: string;
	enabled: boolean;
	baseUrl: string;
	apiKey: string;
	model: string;
	maxTokens: number;
	temperature: number;
	systemRoleName: 'system' | 'developer' | 'user';
	capabilities: { functionCalling: boolean; streaming?: boolean };
	priority: number;
	retries: number;
	displayName: string;
};

function boolEnv(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value === '') return fallback;
	return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function intEnv(value: string | undefined, fallback: number): number {
	if (value === undefined || value === '') return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function floatEnv(value: string | undefined, fallback: number): number {
	if (value === undefined || value === '') return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function buildProviderConfig(prefix: string, base: Partial<AiEnvProviderConfig>): AiEnvProviderConfig {
	return {
		name: prefix.toLowerCase(),
		enabled: boolEnv(process.env[`AI_${prefix}_ENABLED`], base.enabled ?? true),
		baseUrl: process.env[`AI_${prefix}_BASE_URL`] ?? base.baseUrl ?? '',
		apiKey: process.env[`AI_${prefix}_API_KEY`] ?? base.apiKey ?? '',
		model: process.env[`AI_${prefix}_MODEL`] ?? base.model ?? '',
		maxTokens: intEnv(process.env[`AI_${prefix}_MAX_TOKENS`], base.maxTokens ?? 2048),
		temperature: floatEnv(process.env[`AI_${prefix}_TEMPERATURE`], base.temperature ?? 0.4),
		systemRoleName: (process.env[`AI_${prefix}_SYSTEM_ROLE_NAME`] as AiEnvProviderConfig['systemRoleName']) ?? base.systemRoleName ?? 'system',
		capabilities: base.capabilities ?? { functionCalling: true },
		priority: intEnv(process.env[`AI_${prefix}_PRIORITY`], base.priority ?? 100),
		retries: intEnv(process.env[`AI_${prefix}_RETRIES`], base.retries ?? 2),
		displayName: base.displayName ?? prefix.toLowerCase(),
	};
}

export function createAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
	const enabled = boolEnv(env.AI_MODULE_ENABLED, false);

	const llm7 = buildProviderConfig('LLM7', {
		enabled: true,
		baseUrl: 'https://api.llm7.io/v1',
		model: 'openai',
		maxTokens: 2048,
		temperature: 0.4,
		systemRoleName: 'system',
		capabilities: { functionCalling: true },
		priority: 10,
		retries: 2,
		displayName: 'LLM7',
	});

	const pollinations = buildProviderConfig('POLLINATIONS', {
		enabled: false,
		baseUrl: 'https://text.pollinations.ai',
		model: 'openai',
		maxTokens: 2048,
		temperature: 0.4,
		systemRoleName: 'system',
		capabilities: { functionCalling: true },
		priority: 20,
		retries: 1,
		displayName: 'Pollinations',
	});

	const providers: AiConfig['providers'] = [llm7, pollinations];

	return {
		enabled,
		defaultProvider: env.AI_DEFAULT_PROVIDER ?? 'llm7',
		maxProviderRoundtrips: intEnv(env.AI_MAX_PROVIDER_ROUNDTRIPS, 10),
		requestTimeoutMs: intEnv(env.AI_REQUEST_TIMEOUT_MS, 90_000),
		schemaDerivationTimeoutMs: intEnv(env.AI_SCHEMA_DERIVATION_TIMEOUT_MS, 2000),
		promptHashMaxBytes: intEnv(env.AI_PROMPT_HASH_MAX_BYTES, 8192),
		circuitBreaker: {
			failureThreshold: intEnv(env.AI_CIRCUIT_BREAKER_FAILURE_THRESHOLD, 5),
			resetTimeoutMs: intEnv(env.AI_CIRCUIT_BREAKER_RESET_TIMEOUT_MS, 60_000),
		},
		writeToolDedup: {
			enabled: boolEnv(env.AI_WRITE_TOOL_DEDUP_ENABLED, true),
			pendingTtlMs: intEnv(env.AI_IDEMPOTENCY_PENDING_TTL_MS, 120_000),
		},
		providers,
		piiMaskingEnabled: boolEnv(env.AI_PII_MASKING_ENABLED, true),
		logRequests: boolEnv(env.AI_LOG_REQUESTS, false),
		storeConversationSummaries: boolEnv(env.AI_STORE_CONVERSATION_SUMMARIES, true),
	};
}

export const aiConfigFactoryProvider: FactoryProvider<AiConfig> = {
	provide: AI_CONFIG_TOKEN,
	useFactory: (): AiConfig => createAiConfig(),
};

export const aiConfigProviders: Provider[] = [aiConfigFactoryProvider];
