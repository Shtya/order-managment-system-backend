import { AiExecutionSession, AiProgressEvent, AiUsage } from '../interfaces/ai-types';

export class AiExecutionScope {
	readonly session: AiExecutionSession;
	readonly requestId: string;

	private round = 0;
	private usage: AiUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	private readonly providersUsed: string[] = [];
	private readonly modelsUsed: string[] = [];
	private readonly events: AiProgressEvent[] = [];
	private readonly startTime = Date.now();

	constructor(session: AiExecutionSession, requestId: string) {
		this.session = session;
		this.requestId = requestId;
	}

	get currentRound(): number {
		return this.round;
	}

	beginRound(): number {
		this.round += 1;
		return this.round;
	}

	trackProvider(provider: string) {
		if (!this.providersUsed.includes(provider)) this.providersUsed.push(provider);
	}

	trackModel(model: string) {
		if (model && !this.modelsUsed.includes(model)) this.modelsUsed.push(model);
	}

	getProvidersUsed(): string[] {
		return [...this.providersUsed];
	}

	getModelsUsed(): string[] {
		return [...this.modelsUsed];
	}

	emit(event: AiProgressEvent) {
		this.events.push(event);
	}

	getEvents(): AiProgressEvent[] {
		return [...this.events];
	}

	recordUsage(usage: AiUsage | undefined) {
		if (!usage) return;
		this.usage = {
			promptTokens: this.usage.promptTokens + (usage.promptTokens ?? 0),
			completionTokens: this.usage.completionTokens + (usage.completionTokens ?? 0),
			totalTokens: this.usage.totalTokens + (usage.totalTokens ?? 0),
		};
	}

	getUsage(): AiUsage {
		return { ...this.usage };
	}

	getDurationMs(): number {
		return Date.now() - this.startTime;
	}
}
