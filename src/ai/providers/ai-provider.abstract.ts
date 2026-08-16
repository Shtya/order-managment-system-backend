import { AI_PROVIDER_TOKEN, PROVIDER_FUNCTION_CALLING_TIMEOUT_MS, PROVIDER_RETRY_BASE_DELAY_MS, PROVIDER_RETRY_MAX_DELAY_MS } from '../ai.constants';
import { AiProviderConfig } from '../interfaces/provider-config.interface';
import { AiChatMessage, AiProviderHealth, AiProviderRequest, AiProviderResult, AiToolSpec, AiUsage } from '../interfaces/ai-types';
import { AiProviderError, AiProviderInvalidResponseError, toAiProviderError } from '../errors/provider.errors';

export abstract class AiProviderAbstract {
	abstract readonly kind: string;

	protected config: AiProviderConfig;
	protected health: AiProviderHealth = { healthy: true, consecutiveFailures: 0 };

	constructor(config: AiProviderConfig) {
		this.config = config;
	}

	getConfig(): AiProviderConfig {
		return this.config;
	}

	isEnabled(): boolean {
		return this.config.enabled;
	}

	getHealth(): AiProviderHealth {
		return this.health;
	}

	protected getTimeoutMs(): number {
		return PROVIDER_FUNCTION_CALLING_TIMEOUT_MS;
	}

	abstract supports(): boolean;

	async callModel(request: AiProviderRequest): Promise<AiProviderResult> {
		const retries = Math.max(0, this.config.retries ?? 0);
		let lastError: unknown;

		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const result = await this.chat(request);
				this.markSuccess();
				return result;
			} catch (error) {
				lastError = error;
				const providerError = toAiProviderError(error, this.config.name);
				this.markFailure(providerError);

				const shouldRetry = attempt < retries && providerError.retryable && this.config.capabilities.functionCalling;
				if (!shouldRetry) throw providerError;

				await this.delay(attempt);
			}
		}

		throw toAiProviderError(lastError, this.config.name);
	}

	protected abstract chat(request: AiProviderRequest): Promise<AiProviderResult>;

	protected markSuccess() {
		this.health.healthy = true;
		this.health.consecutiveFailures = 0;
		this.health.lastError = undefined;
	}

	protected markFailure(error: AiProviderError) {
		this.health.consecutiveFailures += 1;
		this.health.lastFailureAt = new Date();
		this.health.lastError = error.message;
		this.health.healthy = error.retryable && this.health.consecutiveFailures < 3;
	}

	protected createAbortController(): AbortController {
		return new AbortController();
	}

	protected withTimeout<T>(promise: Promise<T>, timeoutMs: number = this.getTimeoutMs(), provider: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new AiProviderError(`Provider '${provider}' timed out after ${timeoutMs}ms`, { kind: 'TIMEOUT', provider, retryable: true }));
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

	protected validateResult(result: unknown, provider: string): AiProviderResult {
		if (!result || typeof result !== 'object') {
			throw new AiProviderInvalidResponseError(`Provider '${provider}' returned an invalid response`, { provider });
		}

		const record = result as Record<string, unknown>;
		const hasToolCalls = Array.isArray(record.toolCalls);
		const hasContent = typeof record.content === 'string';

		if (!hasToolCalls && !hasContent) {
			throw new AiProviderInvalidResponseError(`Provider '${provider}' returned a response with no content or tool calls`, { provider });
		}

		if (hasToolCalls) {
			return {
				role: 'assistant',
				toolCalls: (record.toolCalls as any[]).map((tc) => {
					const argumentsObj = typeof tc.arguments === 'string' ? safeJsonParse(tc.arguments) : tc.arguments;
					return {
						id: String(tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`),
						name: String(tc.name ?? ''),
						arguments: argumentsObj && typeof argumentsObj === 'object' ? (argumentsObj as Record<string, unknown>) : {},
					};
				}),
				usage: normalizeUsage(record.usage),
				providerModel: record.providerModel as string | undefined,
			};
		}

		return {
			role: 'assistant',
			content: String(record.content),
			usage: normalizeUsage(record.usage),
			providerModel: record.providerModel as string | undefined,
		};
	}

	private delay(attempt: number) {
		const base = Math.min(PROVIDER_RETRY_BASE_DELAY_MS * Math.pow(2, attempt), PROVIDER_RETRY_MAX_DELAY_MS);
		const jitter = Math.random() * 250;
		return new Promise((resolve) => setTimeout(resolve, base + jitter));
	}
}

export function safeJsonParse(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

export function normalizeUsage(usage: unknown): AiUsage | undefined {
	if (!usage || typeof usage !== 'object') return undefined;
	const record = usage as Record<string, unknown>;
	const promptTokens = toInt(record.promptTokens ?? record.inputTokens ?? record.prompt_tokens);
	const completionTokens = toInt(record.completionTokens ?? record.outputTokens ?? record.completion_tokens);

	if (promptTokens === undefined && completionTokens === undefined) return undefined;

	return {
		promptTokens: promptTokens ?? 0,
		completionTokens: completionTokens ?? 0,
		totalTokens: toInt(record.totalTokens ?? record.total_tokens) ?? (promptTokens ?? 0) + (completionTokens ?? 0),
	};
}

function toInt(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

export const AI_PROVIDER = AI_PROVIDER_TOKEN;

export function createProviderHealth(config: AiProviderConfig): AiProviderHealth {
	return { healthy: true, consecutiveFailures: 0, model: config.model };
}

export { AiChatMessage, AiToolSpec, AiUsage };
