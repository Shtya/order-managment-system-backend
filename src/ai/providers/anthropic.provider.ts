import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { AiProviderAbstract, normalizeUsage, boolEnv, intEnv, floatEnv, strEnv } from './ai-provider.abstract';
import { AiProviderRequest, AiProviderResult } from '../interfaces/ai-types';

@Injectable()
export class AnthropicProvider extends AiProviderAbstract {
	readonly kind = 'anthropic';
	readonly displayName = 'Anthropic';

	protected buildClient(): Anthropic {
		if (!this.apiKey) {
			throw new Error(`Missing API key for provider '${this.kind}'`);
		}
		return new Anthropic({
			apiKey: this.apiKey,
			baseURL: this.baseUrl || undefined,
		});
	}

	constructor() {
		super();
		const prefix = 'AI_ANTHROPIC';
		this.baseUrl = strEnv(process.env[`${prefix}_BASE_URL`], 'https://api.anthropic.com/v1');
		this.apiKey = strEnv(process.env[`${prefix}_API_KEY`], '');
		this.model = strEnv(process.env[`${prefix}_MODEL`], 'claude-3-opus-latest');
		this.maxTokens = intEnv(process.env[`${prefix}_MAX_TOKENS`], 2048);
		this.temperature = floatEnv(process.env[`${prefix}_TEMPERATURE`], 0.4);
		this.priority = intEnv(process.env[`${prefix}_PRIORITY`], 50);
		this.retries = intEnv(process.env[`${prefix}_RETRIES`], 2);
	}

	supports(): boolean {
		return !!this.apiKey;
	}

	protected async chat(
		request: AiProviderRequest,
	): Promise<AiProviderResult> {
		const client = this.buildClient();
		const systemMessage = request.messages.find(
			(m) => m.role === 'system',
		);

		const messages = request.messages
			.filter((m) => m.role !== 'system')
			.map((m) => ({
				role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
				content:
					typeof m.content === 'string'
						? m.content
						: m.content,
			}));

		const response = await this.withTimeout(
			client.messages.create({
				model: this.model,
				max_tokens: request.maxTokens ?? this.maxTokens ?? 1024,
				temperature: request.temperature ?? this.temperature,

				...(systemMessage
					? {
							system:
								typeof systemMessage.content === 'string'
									? systemMessage.content
									: '',
						}
					: {}),

				messages,

				...(request.tools.length > 0 &&
				request.toolChoice !== 'none'
					? {
							tools: request.tools.map((t) => ({
								name: t.name,
								description: t.description,
								input_schema: {
									type: 'object' as const,
									...(typeof t.parameters === 'object' && t.parameters !== null ? t.parameters : {}),
								},
							})),
						}
					: {}),
			}),
			this.getTimeoutMs(),
			this.kind,
		);

		return this.normalizeResponse(response);
	}

	private normalizeResponse(
		response: Anthropic.Message,
	): AiProviderResult {
		const toolCalls = response.content
			.filter((block) => block.type === 'tool_use')
			.map((block) => ({
				id: block.id,
				name: block.name,
				arguments:
					block.input &&
					typeof block.input === 'object'
						? (block.input as Record<string, unknown>)
						: {},
			}));

		const text = response.content
			.filter((block) => block.type === 'text')
			.map((block) => block.text)
			.join('');

		const usage = normalizeUsage({
			promptTokens: response.usage.input_tokens,
			completionTokens: response.usage.output_tokens,
		});

		if (toolCalls.length) {
			return {
				role: 'assistant',
				toolCalls,
				usage,
				providerModel: this.model,
			};
		}

		return {
			role: 'assistant',
			content: text,
			usage,
			providerModel: this.model,
		};
	}
}
