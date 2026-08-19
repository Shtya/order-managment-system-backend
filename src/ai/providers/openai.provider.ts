import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { AiProviderAbstract, normalizeUsage, safeJsonParse, boolEnv, intEnv, floatEnv, strEnv } from './ai-provider.abstract';
import { AiProviderRequest, AiProviderResult } from '../interfaces/ai-types';
import { AiProviderError } from '../errors/provider.errors';

@Injectable()
export class OpenAiProvider extends AiProviderAbstract {
	readonly kind = 'openai';
	readonly displayName = 'OpenAI';

	protected buildClient(): OpenAI {
		// this.apiKey = "1e1d1827417842cc85f9c9b12d40cd89.laBTXb9VbCl3IhDe"
		// this.model = "GLM-4.7"
		if (!this.apiKey) {
			throw new AiProviderError(
				`Missing API key for provider '${this.kind}'(env or integration)`,
				{ kind: 'AUTH', provider: this.kind, retryable: false },
			);
		}
		return new OpenAI({
			apiKey: this.apiKey,
			baseURL: this.baseUrl || undefined,
		});
	}

	constructor() {
		super();
		const prefix = 'AI_OPENAI';
		this.baseUrl = strEnv(process.env[`${prefix}_BASE_URL`], 'https://api.openai.com/v1');
		this.apiKey = strEnv(process.env[`${prefix}_API_KEY`], '');
		this.model = strEnv(process.env[`${prefix}_MODEL`], 'gpt-4o-mini');
		this.maxTokens = intEnv(process.env[`${prefix}_MAX_TOKENS`], 2048);
		this.temperature = floatEnv(process.env[`${prefix}_TEMPERATURE`], 0.4);
		this.priority = intEnv(process.env[`${prefix}_PRIORITY`], 30);
		this.retries = intEnv(process.env[`${prefix}_RETRIES`], 2);
	}

	supports(): boolean {
		return !!this.apiKey;
	}

	protected async chat(
		request: AiProviderRequest,
	): Promise<AiProviderResult> {
		const client = this.buildClient();
		const response = await this.withTimeout(
			client.chat.completions.create({
				model: this.model,
				messages: request.messages.map((m) => mapMessage(m)) as any,
				max_tokens: request.maxTokens ?? this.maxTokens,
				temperature: request.temperature ?? this.temperature,
				stream: false,

				...(request.tools.length > 0 &&
				request.toolChoice !== 'none'
					? {
							tools: request.tools.map((t) => ({
								type: 'function' as const,
								function: {
									name: t.name,
									description: t.description,
									parameters: t.parameters,
								},
							})),
							tool_choice: request.toolChoice,
						}
					: {}),
			}),
			this.getTimeoutMs(),
			this.kind,
		);

		return this.normalizeResponse(response);
	}

	private normalizeResponse(
		data: OpenAI.Chat.Completions.ChatCompletion,
	): AiProviderResult {
		const message = data.choices[0]?.message;

		if (!message) {
			throw new AiProviderError(
				`Provider '${this.kind}' returned an empty response`,
				{
					kind: 'INVALID_RESPONSE',
					provider: this.kind,
				},
			);
		}

		const usage = normalizeUsage(data.usage);

		const toolCalls = message.tool_calls
			?.filter((tc) => tc.type === 'function')
			.map((tc) => {
				const parsed = safeJsonParse(tc.function.arguments);

				return {
					id: tc.id,
					name: tc.function.name,
					arguments:
						parsed && typeof parsed === 'object'
							? (parsed as Record<string, unknown>)
							: {},
				};
			});

		if (toolCalls?.length) {
			return {
				role: 'assistant',
				toolCalls,
				usage,
				providerModel: this.model,
			};
		}

		return {
			role: 'assistant',
			content: message.content ?? '',
			usage,
			providerModel: this.model,
		};
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
