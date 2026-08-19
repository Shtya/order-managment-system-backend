import {
  AiProgressEvent,
  AiExecutionSession,
  AiUsage,
} from "../interfaces/ai-types";

export class AiToolContext {
  readonly session: AiExecutionSession;
  readonly requestId: string;
  readonly allowedToolNames?: string[];

  private usage: AiUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  private readonly events: AiProgressEvent[] = [];

  constructor(options: {
    session: AiExecutionSession;
    requestId: string;
    allowedToolNames?: string[];
  }) {
    this.session = options.session;
    this.requestId = options.requestId;
    this.allowedToolNames = options.allowedToolNames;
  }

  get tenantId(): string | null {
    return this.session.tenantId;
  }

  isToolAllowed(name: string): boolean {
    if (!this.allowedToolNames?.length) return true;
    return this.allowedToolNames.includes(name);
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
      completionTokens:
        this.usage.completionTokens + (usage.completionTokens ?? 0),
      totalTokens: this.usage.totalTokens + (usage.totalTokens ?? 0),
    };
  }

  getUsage(): AiUsage {
    return { ...this.usage };
  }
}
