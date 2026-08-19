import {
  AI_PROVIDER_TOKEN,
  PROVIDER_FUNCTION_CALLING_TIMEOUT_MS,
  PROVIDER_RETRY_BASE_DELAY_MS,
  PROVIDER_RETRY_MAX_DELAY_MS,
  AI_PROVIDER_DEFAULTS,
} from "../ai.constants";
import {
  AiProviderCapabilities,
  AiProviderRole,
  AiProviderRuntimeConfig,
} from "../interfaces/provider-config.interface";
import {
  AiChatMessage,
  AiProviderHealth,
  AiProviderRequest,
  AiProviderResult,
  AiToolSpec,
  AiUsage,
} from "../interfaces/ai-types";
import {
  AiProviderError,
  AiProviderInvalidResponseError,
  toAiProviderError,
} from "../errors/provider.errors";

export abstract class AiProviderAbstract {
  abstract readonly kind: string;
  abstract readonly displayName: string;

  // Defaults from env (set by subclass in constructor).
  // Can be overridden per-call via applyRuntimeConfig().
  protected enabled: boolean;
  protected priority: number;
  protected retries: number;
  protected maxTokens: number;
  protected temperature: number;
  protected systemRoleName: AiProviderRole;
  protected capabilities: AiProviderCapabilities;
  protected baseUrl: string;
  protected apiKey: string;
  protected model: string;
  protected entityId?: string;

  protected health: AiProviderHealth = {
    healthy: true,
    consecutiveFailures: 0,
  };

  constructor() {
    this.enabled = true;
    this.priority = AI_PROVIDER_DEFAULTS.PRIORITY;
    this.retries = AI_PROVIDER_DEFAULTS.RETRIES;
    this.maxTokens = AI_PROVIDER_DEFAULTS.MAX_TOKENS;
    this.temperature = AI_PROVIDER_DEFAULTS.TEMPERATURE;
    this.systemRoleName = AI_PROVIDER_DEFAULTS.SYSTEM_ROLE_NAME;
    this.capabilities = { functionCalling: true };
    this.baseUrl = "";
    this.apiKey = "";
    this.model = "";
  }

  /**
   * Apply per-call overrides (from AiIntegrationEntity DB rows) on top
   * of the provider's env-based defaults. Caller passes integration
   * credentials resolved dynamically.
   */
  applyRuntimeConfig(overrides: AiProviderRuntimeConfig): void {
    if (overrides.baseUrl !== undefined) this.baseUrl = overrides.baseUrl;
    if (overrides.apiKey !== undefined) this.apiKey = overrides.apiKey;
    if (overrides.model !== undefined) this.model = overrides.model;
    if (overrides.maxTokens !== undefined) this.maxTokens = overrides.maxTokens;
    if (overrides.temperature !== undefined) {
      this.temperature = overrides.temperature;
    }
    if (overrides.systemRoleName !== undefined) {
      this.systemRoleName = overrides.systemRoleName;
    }
    if (overrides.capabilities !== undefined) {
      this.capabilities = { ...this.capabilities, ...overrides.capabilities };
    }
    if (overrides.retries !== undefined) this.retries = overrides.retries;
    if (overrides.entityId !== undefined) this.entityId = overrides.entityId;
  }

  /** Clone this provider instance with runtime config applied (for per-request isolation). */
  cloneWithRuntime(overrides: AiProviderRuntimeConfig): this {
    const clone = Object.create(Object.getPrototypeOf(this));
    Object.assign(clone, this);
    clone.capabilities = { ...this.capabilities };
    clone.health = { ...this.health };
    clone.applyRuntimeConfig(overrides);
    return clone;
  }

  getConfig() {
    return {
      name: this.kind,
      displayName: this.displayName,
      enabled: this.enabled,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      systemRoleName: this.systemRoleName,
      capabilities: this.capabilities,
      priority: this.priority,
      retries: this.retries,
      entityId: this.entityId,
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getHealth(): AiProviderHealth {
    return this.health;
  }

  protected getTimeoutMs(): number {
    return PROVIDER_FUNCTION_CALLING_TIMEOUT_MS;
  }

  abstract supports(): boolean;

  async callModel(request: AiProviderRequest): Promise<AiProviderResult> {
    const retries = Math.max(0, this.retries ?? 0);
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await this.chat(request);
        this.markSuccess();
        return result;
      } catch (error) {
        lastError = error;
        const providerError = toAiProviderError(error, this.kind);
        this.markFailure(providerError);

        const shouldRetry =
          attempt < retries &&
          providerError.retryable &&
          this.capabilities.functionCalling;
        if (!shouldRetry) throw providerError;

        await this.delay(attempt);
      }
    }

    throw toAiProviderError(lastError, this.kind);
  }

  protected abstract chat(
    request: AiProviderRequest,
  ): Promise<AiProviderResult>;

  protected markSuccess() {
    this.health.healthy = true;
    this.health.consecutiveFailures = 0;
    this.health.lastError = undefined;
  }

  protected markFailure(error: AiProviderError) {
    this.health.consecutiveFailures += 1;
    this.health.lastFailureAt = new Date();
    this.health.lastError = error.message;
    this.health.healthy =
      error.retryable && this.health.consecutiveFailures < 3;
  }

  protected createAbortController(): AbortController {
    return new AbortController();
  }

  protected withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number = this.getTimeoutMs(),
    provider: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new AiProviderError(
            `Provider '${provider}' timed out after ${timeoutMs}ms`,
            { kind: "TIMEOUT", provider, retryable: true },
          ),
        );
      }, timeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  protected validateResult(
    result: unknown,
    provider: string,
  ): AiProviderResult {
    if (!result || typeof result !== "object") {
      throw new AiProviderInvalidResponseError(
        `Provider '${provider}' returned an invalid response`,
        { provider },
      );
    }

    const record = result as Record<string, unknown>;
    const hasToolCalls = Array.isArray(record.toolCalls);
    const hasContent = typeof record.content === "string";

    if (!hasToolCalls && !hasContent) {
      throw new AiProviderInvalidResponseError(
        `Provider '${provider}' returned a response with no content or tool calls`,
        { provider },
      );
    }

    if (hasToolCalls) {
      return {
        role: "assistant",
        toolCalls: (record.toolCalls as any[]).map((tc) => {
          const argumentsObj =
            typeof tc.arguments === "string"
              ? safeJsonParse(tc.arguments)
              : tc.arguments;
          return {
            id: String(
              tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
            ),
            name: String(tc.name ?? ""),
            arguments:
              argumentsObj && typeof argumentsObj === "object"
                ? (argumentsObj as Record<string, unknown>)
                : {},
          };
        }),
        usage: normalizeUsage(record.usage),
        providerModel: record.providerModel as string | undefined,
      };
    }

    return {
      role: "assistant",
      content: String(record.content),
      usage: normalizeUsage(record.usage),
      providerModel: record.providerModel as string | undefined,
    };
  }

  private delay(attempt: number) {
    const base = Math.min(
      PROVIDER_RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
      PROVIDER_RETRY_MAX_DELAY_MS,
    );
    const jitter = Math.random() * 250;
    return new Promise((resolve) => setTimeout(resolve, base + jitter));
  }
}

// --- Helper env-reading utilities used by subclasses (like BostaProvider pattern) ---

export function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function floatEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function strEnv(
  value: string | undefined,
  fallback: string = "",
): string {
  return value ?? fallback;
}

export function safeJsonParse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function normalizeUsage(usage: unknown): AiUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const promptTokens = toInt(
    record.promptTokens ?? record.inputTokens ?? record.prompt_tokens,
  );
  const completionTokens = toInt(
    record.completionTokens ?? record.outputTokens ?? record.completion_tokens,
  );

  if (promptTokens === undefined && completionTokens === undefined) {
    return undefined;
  }

  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens:
      toInt(record.totalTokens ?? record.total_tokens) ??
      (promptTokens ?? 0) + (completionTokens ?? 0),
  };
}

function toInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export const AI_PROVIDER = AI_PROVIDER_TOKEN;

export function createProviderHealth(model?: string): AiProviderHealth {
  return { healthy: true, consecutiveFailures: 0, model };
}

export { AiChatMessage, AiToolSpec, AiUsage };
