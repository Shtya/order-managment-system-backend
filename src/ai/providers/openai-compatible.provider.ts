import { Injectable } from '@nestjs/common';
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider';
import { AiProviderRequest } from '../interfaces/ai-types';
import { strEnv, intEnv, floatEnv } from './ai-provider.abstract';
import { AI_PROVIDER_DEFAULTS } from '../ai.constants';

@Injectable()
export class OpenAiCompatibleProviderImpl extends OpenAiCompatibleProvider {
	readonly kind = 'openai_compatible';
	readonly displayName = 'OpenAI Compatible';

	constructor() {
		super();
		const prefix = 'AI_OPENAI_COMPATIBLE';
		this.baseUrl = strEnv(process.env[`${prefix}_BASE_URL`], '');
		this.apiKey = strEnv(process.env[`${prefix}_API_KEY`], '');
		this.model = strEnv(process.env[`${prefix}_MODEL`], '');
		this.maxTokens = intEnv(process.env[`${prefix}_MAX_TOKENS`], AI_PROVIDER_DEFAULTS.MAX_TOKENS);
		this.temperature = floatEnv(process.env[`${prefix}_TEMPERATURE`], AI_PROVIDER_DEFAULTS.TEMPERATURE);
		this.priority = intEnv(process.env[`${prefix}_PRIORITY`], AI_PROVIDER_DEFAULTS.PRIORITY);
		this.retries = intEnv(process.env[`${prefix}_RETRIES`], AI_PROVIDER_DEFAULTS.RETRIES);
	}

	supports(): boolean {
		return !!this.apiKey;
	}

	protected getFunctionCallModelName(_request: AiProviderRequest): string {
		return this.model;
	}
}
