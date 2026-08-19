export type AiProviderRole = "system" | "developer" | "user";

export interface AiProviderCapabilities {
  functionCalling: boolean;
  streaming?: boolean;
}

/**
 * Runtime config overrides — resolved from AiIntegrationEntity per-call/per-provider.
 * Applied on top of the provider's env-based defaults.
 */
export interface AiProviderRuntimeConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemRoleName?: AiProviderRole;
  capabilities?: AiProviderCapabilities;
  retries?: number;
  entityId?: string;
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
  piiMaskingEnabled: boolean;
  logRequests: boolean;
  storeConversationSummaries: boolean;
}
