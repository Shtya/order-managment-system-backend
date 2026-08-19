import { Provider, FactoryProvider } from '@nestjs/common';
import { AI_CONFIG_TOKEN } from './ai.constants';
import { AiConfig } from './interfaces/provider-config.interface';

function boolEnv(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value === '') return fallback;
	return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function intEnv(value: string | undefined, fallback: number): number {
	if (value === undefined || value === '') return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function createAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
	const enabled = boolEnv(env.AI_MODULE_ENABLED, true);

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
