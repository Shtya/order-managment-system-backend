import { AiProviderAbstract, normalizeUsage, safeJsonParse } from './ai-provider.abstract';
import { AiProviderConfig } from '../interfaces/provider-config.interface';
import { AiProviderRequest, AiProviderResult } from '../interfaces/ai-types';
import { AiProviderError } from '../errors/provider.errors';

interface PollinationsChatCompletionRequest {
	model: string;
	messages: Array<Record<string, unknown>>;
	tools?: Array<Record<string, unknown>>;
	tool_choice?: 'auto' | 'none';
	max_tokens?: number;
	temperature?: number;
	stream?: boolean;
	jsonMode?: boolean;
	referrer?: string;
}

interface PollinationsChatCompletionResponse {
	choices?: Array<{ message?: { role?: string; content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
	usage?: Record<string, unknown>;
}

export class PollinationsProvider extends AiProviderAbstract {
	readonly kind = 'pollinations';

	constructor(config: AiProviderConfig) {
		super(config);
	}

	supports(): boolean {
		return true;
	}

	protected async chat(request: AiProviderRequest): Promise<AiProviderResult> {
		const endpoint = `${this.config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
		const body: PollinationsChatCompletionRequest = {
			model: this.config.model || 'openai',
			messages: request.messages.map((m) => mapMessage(m)),
			max_tokens: request.maxTokens ?? this.config.maxTokens,
			temperature: request.temperature ?? this.config.temperature,
			stream: false,
		};

		if (request.toolChoice !== 'none') {
			body.tools = request.tools.map((t) => ({
				type: 'function',
				function: { name: t.name, description: t.description, parameters: t.parameters },
			}));
			body.tool_choice = 'auto';
		}

		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

		const controller = this.createAbortController();
		const fetchPromise = fetch(endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		const response = await this.withTimeout(fetchPromise, this.getTimeoutMs(), this.config.name);
		const data = (await response.json().catch(() => null)) as PollinationsChatCompletionResponse | null;

		if (!response.ok) {
			const message = (data as any)?.error?.message ?? `Provider returned HTTP ${response.status}`;
			throw new AiProviderError(message, {
				kind: response.status === 429 ? 'RATE_LIMITED' : response.status === 401 || response.status === 403 ? 'AUTH' : 'HTTP',
				provider: this.config.name,
				status: response.status,
				retryable: response.status === 429 || response.status >= 500,
			});
		}

		const normalized = this.normalizePollinations(data);
		if (normalized) return normalized;

		throw new AiProviderError(`Provider '${this.config.name}' returned an unparseable response`, {
			kind: 'INVALID_RESPONSE',
			provider: this.config.name,
		});
	}

	private normalizePollinations(data: PollinationsChatCompletionResponse | null): AiProviderResult | null {
		const message = data?.choices?.[0]?.message;
		if (!message) return null;

		const usage = normalizeUsage(data.usage);
		const toolCalls = message.tool_calls
			?.map((tc) => {
				const parsed = safeJsonParse(tc.function?.arguments);
				return {
					id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
					name: tc.function?.name ?? '',
					arguments: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {},
				};
			})
			.filter((tc) => tc.name);

		if (toolCalls?.length) {
			return { role: 'assistant', toolCalls, usage, providerModel: this.config.model };
		}

		if (typeof message.content === 'string' && message.content.trim() !== '') {
			return { role: 'assistant', content: message.content, usage, providerModel: this.config.model };
		}

		return null;
	}
}

function mapMessage(message: { role: string; content: string | null; toolCallId?: string; name?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }) {
	switch (message.role) {
		case 'system':
			return { role: 'system', content: message.content };
		case 'user':
			return { role: 'user', content: message.content };
		case 'assistant':
			if (message.toolCalls?.length) {
				return {
					role: 'assistant',
					content: message.content,
					tool_calls: message.toolCalls.map((tc) => ({
						id: tc.id,
						type: 'function',
						function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
					})),
				};
			}
			return { role: 'assistant', content: message.content };
		case 'tool':
			return { role: 'tool', tool_call_id: message.toolCallId, content: message.content ?? '' };
		default:
			return { role: message.role, content: message.content };
	}
}
