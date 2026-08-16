import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { AI_CONFIG_TOKEN, AI_PROVIDER_TOKEN } from '../ai.constants';
import { AiConfig } from '../interfaces/provider-config.interface';
import { AiProviderAbstract } from '../providers/ai-provider.abstract';

@Injectable()
export class AiProviderSelectorService implements OnModuleInit {
	private readonly providerPool: Map<string, AiProviderAbstract> = new Map();

	constructor(
		@Inject(AI_CONFIG_TOKEN) private readonly config: AiConfig,
		@Inject(AI_PROVIDER_TOKEN) private readonly providers: AiProviderAbstract[],
	) {}

	onModuleInit() {
		for (const provider of this.providers ?? []) {
			this.providerPool.set(provider.getConfig().name, provider);
		}
	}

	/**
	 * Picks the best enabled + healthy provider. Prefers `requestedName` when available,
	 * otherwise the highest-priority healthy provider.
	 */
	select(requestedName?: string): AiProviderAbstract {
		const requested = requestedName ? this.providerPool.get(requestedName) : undefined;
		if (requested && !requested.isEnabled()) {
			throw new Error(`AI provider '${requestedName}' is disabled`);
		}
		if (requested && (requested.getHealth().healthy || this.enabledProviders().length === 1)) {
			return requested;
		}

		const sorted = this.enabledProviders().sort((a, b) => {
			const healthDiff = Number(b.getHealth().healthy) - Number(a.getHealth().healthy);
			if (healthDiff !== 0) return healthDiff;
			return a.getConfig().priority - b.getConfig().priority;
		});

		const selected = sorted[0];
		if (!selected) {
			throw new Error('No enabled AI provider is available');
		}

		return selected;
	}

	failoverCandidates(excludeName?: string): AiProviderAbstract[] {
		return this.enabledProviders()
			.filter((p) => p.getConfig().name !== excludeName)
			.sort((a, b) => a.getConfig().priority - b.getConfig().priority);
	}

	private enabledProviders(): AiProviderAbstract[] {
		return Array.from(this.providerPool.values()).filter((p) => p.isEnabled());
	}
}
