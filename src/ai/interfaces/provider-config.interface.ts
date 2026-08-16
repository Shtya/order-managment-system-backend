export type AiProviderRole = 'system' | 'developer' | 'user';

export interface AiProviderCapabilities {
	functionCalling: boolean;
	streaming?: boolean;
}

export interface AiProviderConfig {
	name: string;
	displayName: string;
	enabled: boolean;
	baseUrl: string;
	apiKey: string;
	model: string;
	maxTokens: number;
	temperature: number;
	systemRoleName: AiProviderRole;
	capabilities: AiProviderCapabilities;
	priority: number;
	retries: number;
}

export interface AiCircuitBreakerConfig {
	failureThreshold: number;
	resetTimeoutMs: number;
}

export interface AiWriteToolDedupConfig {
	enabled: boolean;
	pendingTtlMs: number;
}

export interface AiConfig {
	enabled: boolean;
	defaultProvider: string;
	maxProviderRoundtrips: number;
	requestTimeoutMs: number;
	schemaDerivationTimeoutMs: number;
	promptHashMaxBytes: number;
	circuitBreaker: AiCircuitBreakerConfig;
	writeToolDedup: AiWriteToolDedupConfig;
	providers: AiProviderConfig[];
	piiMaskingEnabled: boolean;
	logRequests: boolean;
	storeConversationSummaries: boolean;
}
