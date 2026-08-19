import { Injectable } from '@nestjs/common';
import { AzureOpenAI } from 'openai';
import { AiProviderAbstract, normalizeUsage, safeJsonParse, boolEnv, intEnv, floatEnv, strEnv } from './ai-provider.abstract';
import { AiProviderRequest, AiProviderResult } from '../interfaces/ai-types';
import { AiProviderError } from '../errors/provider.errors';

@Injectable()
export class AzureOpenAiProvider extends AiProviderAbstract {
	readonly kind = 'azure_openai';
	readonly displayName = 'Azure OpenAI';

	private azureOpenAIApiVersion?: string;
	private azureOpenAIEndpoint?: string;
	private azureOpenAIInstanceName?: string;
	private azureOpenAIDeploymentName?: string;
	private azureOpenAIEmbeddingsDeploymentName?: string;

	protected buildClient(): AzureOpenAI {
		const key = this.apiKey ?? this.azureOpenAIApiVersion;
		const endpoint = this.baseUrl || this.azureOpenAIEndpoint;
		if (!key || !endpoint) {
			throw new AiProviderError(
				`Missing API key / endpoint for provider '${this.kind}'(env or integration)`,
				{ kind: 'AUTH', provider: this.kind, retryable: false },
			);
		}
		return new AzureOpenAI({
			apiKey: key,
			endpoint,
			apiVersion: this.azureOpenAIApiVersion ?? '2025-04-01-preview',
		});
	}

	constructor() {
		super();
		const prefix = 'AI_AZURE_OPENAI';
		this.baseUrl = strEnv(process.env[`${prefix}_BASE_URL`], '');
		this.apiKey = strEnv(process.env[`${prefix}_API_KEY`], process.env.AZURE_OPENAI_API_KEY ?? '');
		this.model = strEnv(process.env[`${prefix}_MODEL`], process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? 'gpt-4o');
		this.maxTokens = intEnv(process.env[`${prefix}_MAX_TOKENS`], 2048);
		this.temperature = floatEnv(process.env[`${prefix}_TEMPERATURE`], 0.4);
		this.priority = intEnv(process.env[`${prefix}_PRIORITY`], 40);
		this.retries = intEnv(process.env[`${prefix}_RETRIES`], 2);

		this.azureOpenAIApiVersion = process.env.AZURE_OPENAI_API_VERSION;
		this.azureOpenAIEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
		this.azureOpenAIInstanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
		this.azureOpenAIDeploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
		this.azureOpenAIEmbeddingsDeploymentName = process.env.AZURE_OPENAI_API_EMBEDDINGS_DEPLOYMENT_NAME;
	}

	supports(): boolean {
		return !!this.apiKey && !!(this.azureOpenAIDeploymentName || this.model);
	}

	protected async chat(
		request: AiProviderRequest,
	): Promise<AiProviderResult> {
		const client = this.buildClient();
		const response = await this.withTimeout(
			client.chat.completions.create({
				model: this.azureOpenAIDeploymentName || this.model,

				messages: request.messages.map((m) => mapMessage(m)) as any,

				max_tokens:
					request.maxTokens ?? this.maxTokens,

				temperature:
					request.temperature ?? this.temperature,

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

		return this.normalizeResponse(response as any);
	}

	private normalizeResponse(
		data: any,
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

		const toolCalls = message.tool_calls
			?.filter((tc: any) => tc.type === 'function')
			.map((tc: any) => ({
				id: tc.id,
				name: tc.function.name,
				arguments:
					(safeJsonParse(tc.function.arguments) as Record<
						string,
						unknown
					>) ?? {},
			}));

		if (toolCalls?.length) {
			return {
				role: 'assistant',
				toolCalls,
				usage: normalizeUsage(data.usage),
				providerModel: this.model,
			};
		}

		return {
			role: 'assistant',
			content: message.content ?? '',
			usage: normalizeUsage(data.usage),
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
