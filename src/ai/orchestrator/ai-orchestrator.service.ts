import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { randomUUID, createHash } from "crypto";
import { AI_CONFIG_TOKEN } from "../ai.constants";
import { AiConfig } from "../interfaces/provider-config.interface";
import {
  AiChatMessage,
  AiExecutionSession,
  AiOrchestrationError,
  AiOrchestrationResult,
  AiOrchestrationDevInfo,
  AiProgressEvent,
  AiToolCall,
  AiToolExecutionResult,
  AiTurnEndReason,
  AiUsage,
} from "../interfaces/ai-types";
import {
  AI_AGENT_ROLE,
  AiLoopPolicy,
  customerAgentPolicy,
  ERP_ASSISTANT_POLICY,
} from "./ai-loop-policy";
import { AiProviderAbstract } from "../providers/ai-provider.abstract";
import { AiToolRegistryService } from "../tools/ai-tool-registry.service";
import { AiTool } from "../tools/ai-tool.abstract";
import { AiToolContext } from "../tools/ai-tool-context";
import { AiExecutionScope } from "./execution-context";
import { AiProviderSelectorService } from "./provider-selector.service";
import { AiSystemPromptService } from "./ai-system-prompt.service";
import { AiLoggerService } from "./ai-logger.service";
import { AiAuditService } from "./ai-audit.service";
import { AiPiiMaskerService } from "../security/ai-pii-masker.service";
import { AiWriteToolCallStatus } from "entities/ai.entity";
import { isAiProviderError, AiProviderError, toAiProviderError } from "../errors/provider.errors";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AiModelAvailabilityEntity, AiModelEntity } from "../../../entities/ai.entity";
import { TranslationService } from "../../../common/translation.service";
import { AiUsageLedgerService } from "../usage/ai-usage-ledger.service";
import { AiModelHealthService } from "./ai-model-health.service";
import {
  AiUsageActor,
  AiUsageBilledBy,
  AiUsageSource,
  AiUsageStatus,
} from "entities/ai-usage.entity";
import {
  attachAttemptsToError,
  classifyProviderFailure,
  errorKindOf,
  errorMessageOf,
  formatAttemptsSummary,
} from "../catalog/tools-error-classify";

/** An allow-list entry that matches no tool, so the model gets an empty tool catalog. */
const NO_TOOLS_ALLOWED = "__no_tools__";

class PhaseTimer {
  private readonly phases: Array<{
    name: string;
    ms: number;
    detail?: Record<string, unknown>;
  }> = [];
  private readonly startedAt = performance.now();
  private active?: {
    name: string;
    startedAt: number;
    detail?: Record<string, unknown>;
  };

  start(name: string, detail?: Record<string, unknown>) {
    this.active = { name, startedAt: performance.now(), detail };
  }

  stop(detailAdd?: Record<string, unknown>) {
    if (!this.active) return;
    const ms = performance.now() - this.active.startedAt;
    this.phases.push({
      name: this.active.name,
      ms,
      detail: { ...this.active.detail, ...detailAdd },
    });
    this.active = undefined;
  }

  sinceStartMs(): number {
    return performance.now() - this.startedAt;
  }

  summarize(): {
    totalMs: number;
    phases: Array<{
      name: string;
      ms: number;
      pct: string;
      detail?: Record<string, unknown>;
    }>;
  } {
    const totalMs = this.sinceStartMs();
    const phases = this.phases.map((p) => ({
      name: p.name,
      ms: Math.round(p.ms * 100) / 100,
      pct: totalMs > 0 ? `${Math.round((p.ms / totalMs) * 100)}%` : "0%",
      detail: p.detail,
    }));
    return { totalMs: Math.round(totalMs * 100) / 100, phases };
  }
}

export interface AiChatOptions {
  sessionId?: string;
  conversationId?: string;
  history?: AiChatMessage[];
  provider?: string;
  providerId?: string;
  model?: string;
  acceptWriteOperations?: boolean;
  enforcePiiMasking?: boolean;
  allowedToolNames?: string[];
  metadata?: Record<string, unknown>;
  includeDevInfo?: boolean;
  tenantLang?: string;
  allowProviderFailover?: boolean;
  requireTools?: boolean;
  useSystemIntegrations?: boolean;
  usageSource?: AiUsageSource;
  usageApi?: string;
  usageActor?: AiUsageActor;
}

export interface AiAgentTurnInput {
  tenantId: string;
  /** Agent session id, so observability rows link to the conversation session. */
  sessionId: string;
  conversationId: string;
  agentId: string;
  agentName?: string;
  providerId?: string | null;
  model?: string | null;
  allowProviderFailover?: boolean;
  /** Fully built context: agent system prompt, summary, history, and the new customer input. */
  messages: AiChatMessage[];
  /** Customer-audience tools offered this turn (empty = every customer tool). */
  toolNames?: string[];
  sendToolNames: string[];
  permissionNames?: string[];
  writeDedupScope?: AiLoopPolicy["writeDedupScope"];
  metadata?: Record<string, unknown>;
  useSystemIntegrations?: boolean;
}

export type AiAgentTurnResult = AiOrchestrationResult & {
  /** The input messages plus every assistant tool call and tool result of this turn. */
  messages: AiChatMessage[];
};

@Injectable()
export class AiOrchestratorService {
  constructor(
    @Inject(AI_CONFIG_TOKEN) private readonly config: AiConfig,
    private readonly toolRegistry: AiToolRegistryService,
    private readonly providerSelector: AiProviderSelectorService,
    private readonly systemPromptService: AiSystemPromptService,
    private readonly logger: AiLoggerService,
    private readonly auditService: AiAuditService,
    private readonly piiMasker: AiPiiMaskerService,
    @InjectRepository(AiModelAvailabilityEntity)
    private readonly availabilityRepo: Repository<AiModelAvailabilityEntity>,
    @InjectRepository(AiModelEntity)
    private readonly modelRepo: Repository<AiModelEntity>,
    private readonly translations: TranslationService,
    private readonly modelHealth: AiModelHealthService,
    private readonly usageLedger: AiUsageLedgerService,
  ) { }

  async chat(
    me: any,
    userMessage: string,
    options: AiChatOptions = {},
  ): Promise<AiOrchestrationResult> {
    const timer = new PhaseTimer();
    const requestId = randomUUID();
    const sessionId = options.sessionId ?? randomUUID();

    timer.start("resolveTenantId");
    const tenantId = this.resolveTenantId(me);
    timer.stop();

    timer.start("buildSession");
    const session: AiExecutionSession = {
      sessionId,
      conversationId: options.conversationId,
      tenantId,
      userId: me?.id ?? "unknown",
      userName: me?.name,
      userRoleName: me?.role?.name,
      userPermissionNames: me?.role?.permissionNames ?? [],
      provider: options.provider,
      providerId: options.providerId,
      model: options.model,
      metadata: options.metadata,
      enforcePiiMasking: options.enforcePiiMasking ?? false,
      acceptWriteOperations: options.acceptWriteOperations ?? false,
      allowedToolNames: options.allowedToolNames,
      requireTools: options.requireTools === true,
      allowProviderFailover:
        options.allowProviderFailover ?? !options.model,
      useSystemIntegrations: options.useSystemIntegrations === true,
    };
    timer.stop();

    timer.start("buildCtx");
    const execution = new AiExecutionScope(session, requestId);
    const ctx = new AiToolContext({
      session,
      requestId,
      allowedToolNames: session.allowedToolNames,
    });
    timer.stop();

    timer.start("piiMask", { enabled: session.enforcePiiMasking });
    const masked = session.enforcePiiMasking
      ? this.piiMasker.mask(userMessage)
      : { text: userMessage, pairs: [] };
    timer.stop({ pairsCount: masked.pairs.length });

    timer.start("buildMessages.systemPrompt");
    const messages: AiChatMessage[] = [];
    messages.push({
      role: "system",
      content: options.tenantLang
        ? this.systemPromptService.buildWithTenantLang(ctx, {
          tenantLang: options.tenantLang,
        })
        : this.systemPromptService.build(ctx),
    });
    timer.stop({ systemPromptLen: messages[0].content?.length ?? 0 });

    let historyCount = 0;
    timer.start("buildMessages.history", {
      historyProvided: options.history?.length ?? 0,
    });
    if (options.history?.length) {
      const sanitisedHistory = options.history.filter(
        (m) => m.role !== "system",
      );
      historyCount = sanitisedHistory.length;
      messages.push(...sanitisedHistory);
    }
    timer.stop({ historyInjected: historyCount });

    timer.start("buildMessages.user");
    messages.push({ role: "user", content: masked.text });
    timer.stop({ userLen: masked.text.length });

    this.logger.debug("[chat] phase timing — request bootstrap done", {
      requestId,
      sessionId,
      userId: session.userId,
      tenantId: session.tenantId,
      requestedProvider: session.provider ?? session.providerId ?? "default",
      requestedProviderId: session.providerId ?? null,
      requestedModel: session.model ?? "none",
      totalBootstrapMs: timer.sinceStartMs(),
    });

    return this.execute(ctx, execution, messages, timer, ERP_ASSISTANT_POLICY, {
      piiPairs: masked.pairs,
      userMessage: masked.text,
      includeDevInfo: options.includeDevInfo,
      usageSource: options.usageSource,
      usageApi: options.usageApi,
      usageActor: options.usageActor,
      usageOrderId:
        typeof options.metadata?.orderId === "string" ? options.metadata.orderId : undefined,
    });
  }

  /**
   * One turn of the customer-facing agent. Uses the same provider selection, failover,
   * model health, write idempotency and observability as `chat()`, with the customer
   * loop policy: customer-scoped tools only, ordered send/write tools, replies via send tools.
   */
  async runAgentTurn(input: AiAgentTurnInput): Promise<AiAgentTurnResult> {
    const timer = new PhaseTimer();
    const requestId = randomUUID();

    const session: AiExecutionSession = {
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      tenantId: input.tenantId,
      userId: input.agentId,
      userName: input.agentName,
      userRoleName: AI_AGENT_ROLE,
      userPermissionNames: input.permissionNames ?? [],
      providerId: input.providerId ?? undefined,
      model: input.model ?? undefined,
      metadata: input.metadata,
      enforcePiiMasking: false,
      // Customer write tools only create pending actions; the customer confirms them in a later turn.
      acceptWriteOperations: true,
      allowedToolNames: input.toolNames,
      requireTools: true,
      allowProviderFailover: input.allowProviderFailover ?? true,
      useSystemIntegrations: input.useSystemIntegrations === true,
    };
    const execution = new AiExecutionScope(session, requestId);
    const ctx = new AiToolContext({
      session,
      requestId,
      allowedToolNames: session.allowedToolNames,
    });

    const messages = [...input.messages];
    const lastUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === "user")?.content;

    const policy = customerAgentPolicy({
      sendToolNames: input.sendToolNames,
      writeDedupScope: input.writeDedupScope,
    });

    const result = await this.execute(ctx, execution, messages, timer, policy, {
      piiPairs: [],
      userMessage: lastUserMessage ?? undefined,
    });
    return { ...result, messages };
  }

  /**
   * A plain text completion with no tools (e.g. conversation summaries), through the same
   * provider selection, failover and observability as `chat()`.
   */
  async runCompletion(input: {
    tenantId: string;
    sessionId: string;
    conversationId?: string;
    userId: string;
    providerId?: string | null;
    model?: string | null;
    system: string;
    user: string;
    metadata?: Record<string, unknown>;
    useSystemIntegrations?: boolean;
    usageSource?: AiUsageSource;
    usageApi?: string;
    usageActor?: AiUsageActor;
  }): Promise<AiOrchestrationResult> {
    const timer = new PhaseTimer();
    const requestId = randomUUID();
    const session: AiExecutionSession = {
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      tenantId: input.tenantId,
      userId: input.userId,
      userRoleName: AI_AGENT_ROLE,
      userPermissionNames: [],
      providerId: input.providerId ?? undefined,
      model: input.model ?? undefined,
      metadata: input.metadata,
      enforcePiiMasking: false,
      acceptWriteOperations: false,
      allowedToolNames: [NO_TOOLS_ALLOWED],
      requireTools: false,
      allowProviderFailover: input.model ? false : true,
      useSystemIntegrations: input.useSystemIntegrations === true,
    };
    const execution = new AiExecutionScope(session, requestId);
    const ctx = new AiToolContext({
      session,
      requestId,
      allowedToolNames: session.allowedToolNames,
    });
    const messages: AiChatMessage[] = [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ];
    return this.execute(ctx, execution, messages, timer, ERP_ASSISTANT_POLICY, {
      piiPairs: [],
      userMessage: input.user,
      usageSource: input.usageSource,
      usageApi: input.usageApi,
      usageActor: input.usageActor,
    });
  }

  private async execute(
    ctx: AiToolContext,
    execution: AiExecutionScope,
    messages: AiChatMessage[],
    timer: PhaseTimer,
    policy: AiLoopPolicy,
    options: {
      piiPairs: Array<{ token: string; original: string }>;
      userMessage?: string;
      includeDevInfo?: boolean;
      usageSource?: AiUsageSource;
      usageApi?: string;
      usageActor?: AiUsageActor;
      usageOrderId?: string;
    },
  ): Promise<AiOrchestrationResult> {
    const session = ctx.session;
    const requestId = ctx.requestId;
    const sessionId = session.sessionId;

    let finalResult: AiOrchestrationResult;
    let providersUsed: string[] = [];
    let modelsUsed: string[] = [];
    let rounds = 0;
    let progress: AiProgressEvent[] = [];
    try {
      timer.start("runLoop");
      const result = await this.runLoop(ctx, execution, messages, timer, policy);
      timer.stop({
        rounds: execution.currentRound,
        outcome: result.error ? "error" : "ok",
        endedBy: result.endedBy,
      });

      timer.start("finalize");
      const finalized = await this.finalize(
        ctx,
        execution,
        result,
        options.piiPairs,
        timer,
        options.userMessage,
        {
          usageSource: options.usageSource,
          usageApi: options.usageApi,
          usageActor: options.usageActor,
          usageOrderId: options.usageOrderId,
        },
      );
      finalResult = finalized.finalResult;
      providersUsed = finalized.providersUsed;
      modelsUsed = finalized.modelsUsed;
      rounds = finalized.rounds;
      progress = finalized.progress;
      timer.stop({ ok: finalResult.ok });
    } catch (error: any) {
      let errorDetails: AiOrchestrationError | undefined;
      if (isAiProviderError(error)) {
        errorDetails = {
          name: error.name,
          kind: error.kind,
          provider: error.provider,
          retryable: error.retryable,
          message: error.message,
          status: error.providerStatus,
        };
      }
      timer.stop({
        rounds: execution.currentRound,
        outcome: "exception",
        errorKind: errorDetails?.kind,
      });

      if (error && typeof error === "object") {
        (error as any).providersUsed = execution.getProvidersUsed();
        (error as any).modelsUsed = execution.getModelsUsed();
        (error as any).aiAttempts = execution.getAttempts();
      }

      throw error;
    }

    const summary = timer.summarize();
    this.logger.info("[chat] phase timing — REQUEST SUMMARY", {
      requestId,
      sessionId,
      userId: session.userId,
      tenantId: session.tenantId,
      audience: policy.audience,
      endedBy: finalResult.endedBy ?? null,
      totalMs: summary.totalMs,
      rounds,
      ok: finalResult.ok,
      errorCode: finalResult.errorCode ?? null,
      providersUsed,
      modelsUsed,
      totalTokens: finalResult.usage?.totalTokens ?? 0,
      promptTokens: finalResult.usage?.promptTokens ?? 0,
      completionTokens: finalResult.usage?.completionTokens ?? 0,
      phases: summary.phases,
    });

    const nodeEnv = process.env.NODE_ENV?.toLowerCase() ?? "development";
    const isDevEnv =
      nodeEnv === "development" || nodeEnv === "dev" || nodeEnv === "local";
    if (isDevEnv || options.includeDevInfo) {
      const devInfo: AiOrchestrationDevInfo = {
        phaseTiming: summary,
        nodeEnv: process.env.NODE_ENV ?? "development",
        requestedProvider: session.provider,
        requestedProviderId: session.providerId,
        requestedModel: session.model,
        tenantId: session.tenantId,
        userId: session.userId,
        userRole: session.userRoleName,
        providersUsed,
        modelsUsed,
        aiAttempts: finalResult.aiAttempts ?? [],
        rounds,
        progress,
      };
      finalResult._dev = devInfo;
    }

    return finalResult;
  }

  async probeTools(
    me: any,
    options: {
      preferredProviderId?: string;
      preferredProviderCode?: string;
    } = {},
  ): Promise<{ ok: true; model: string; code: string }> {
    const tenantId = this.resolveTenantId(me);
    const candidates = await this.providerSelector.resolveToolingCandidates(
      tenantId,
      {
        requireTools: true,
        preferredProviderId: options.preferredProviderId,
        preferredProviderCode: options.preferredProviderCode,
      },
    );
    if (!candidates.length) {
      throw new AiProviderError(
        this.translations.t("domains.ai.no_provider_available"),
        { kind: "CONFIG", provider: options.preferredProviderCode ?? "none" },
      );
    }

    const dummyTools = [
      {
        name: "catalog_tools_ping",
        description:
          "Confirm this model accepts function tools. Call it with no arguments.",
        parameters: { type: "object", properties: {} },
      },
    ];
    const failedDetails: Array<{
      provider: string;
      model?: string | null;
      error?: string;
    }> = [];
    let lastError: unknown;

    for (const candidate of candidates) {
      try {
        await candidate.callModel({
          messages: [
            {
              role: "user",
              content: "Call catalog_tools_ping now.",
            },
          ],
          tools: dummyTools,
          toolChoice: "auto",
        });
        await this.modelHealth.recordCallOutcome({
          tenantId,
          providerEntityId: candidate.getConfig().entityId,
          modelCode: candidate.getConfig().model,
          classification: "SUCCESS",
          usedTools: true,
        });
        return {
          ok: true,
          model: candidate.getConfig().model,
          code: candidate.getCatalogCode(),
        };
      } catch (error) {
        lastError = error;
        const classified = classifyProviderFailure(error);
        failedDetails.push({
          provider: candidate.getCatalogCode(),
          model: candidate.getConfig().model,
          error: errorMessageOf(error).slice(0, 200),
        });
        await this.modelHealth.recordCallOutcome({
          tenantId,
          providerEntityId: candidate.getConfig().entityId,
          modelCode: candidate.getConfig().model,
          classification: classified,
          errorKind: errorKindOf(error),
          usedTools: true,
        });
      }
    }

    const summary = formatAttemptsSummary(failedDetails);
    const wrapped = toAiProviderError(
      lastError ??
        new Error(this.translations.t("domains.ai.tools_probe_failed")),
    );
    throw attachAttemptsToError(
      new AiProviderError(
        summary ? `${wrapped.message} | ${summary}` : wrapped.message,
        {
          kind: wrapped.kind,
          provider: wrapped.provider,
          status: wrapped.providerStatus,
          retryable: wrapped.retryable,
          cause: wrapped,
        },
      ),
      failedDetails.map((item) => ({
        code: item.provider,
        model: item.model ?? null,
      })),
      summary,
    );
  }

  private async runLoop(
    ctx: AiToolContext,
    execution: AiExecutionScope,
    messages: AiChatMessage[],
    timer: PhaseTimer,
    policy: AiLoopPolicy,
  ): Promise<{
    content?: string;
    error?: string;
    errorCode?: string;
    endedBy?: AiTurnEndReason;
  }> {
    timer.start("runLoop.toolSpecs");
    const allToolSpecs = this.toolRegistry.getToolSpecs(ctx, policy.audience);
    const toolSpecs = ctx.session.allowedToolNames?.length
      ? allToolSpecs.filter((t) =>
        ctx.session.allowedToolNames!.includes(t.name),
      )
      : allToolSpecs;
    timer.stop({
      allCount: allToolSpecs.length,
      allowedCount: toolSpecs.length,
    });

    const seenToolCalls = new Set<string>();
    timer.start("resolveProviders");
    const { candidates, userExplicitChoice, primary, toolsCalling } =
      await this.resolveProviders(ctx);
    timer.stop({
      primary: primary.kind,
      candidateCount: candidates.length,
      userExplicitChoice,
      toolsCalling,
    });

    const modelSupportsTools = toolsCalling !== false;
    const effectiveToolCatalog = modelSupportsTools ? toolSpecs : [];

    const maxRounds = this.config.maxProviderRoundtrips;
    const lastRoundToolNames = new Set(policy.lastRoundToolNames);
    const lastRoundToolCatalog = effectiveToolCatalog.filter((t) =>
      lastRoundToolNames.has(t.name),
    );
    const sendToolNames = new Set(policy.sendToolNames ?? []);
    let sentToCustomer = false;
    let nudged = false;

    for (let round = 1; round <= maxRounds; round++) {
      execution.beginRound();

      const isLastRound = round === maxRounds;
      const effectiveToolSpecs = isLastRound
        ? lastRoundToolCatalog
        : effectiveToolCatalog;

      timer.start(`callProvider.r${round}`, {
        round,
        candidates: candidates.length,
        isLastRound,
      });
      const { provider, result } = await this.callProviderWithFailover(
        execution,
        messages,
        effectiveToolSpecs,
        round,
        candidates,
        userExplicitChoice,
      );
      timer.stop({
        provider: provider.kind,
        role: result.role,
        hasTools: !!result.toolCalls?.length,
        hasContent: typeof result.content === "string",
      });

      execution.trackAttempt(
        provider.getCatalogCode(),
        result.providerModel ?? provider.getConfig().model ?? null,
      );
      execution.recordUsage(result.usage);

      if (result.role === "assistant" && result.toolCalls?.length) {
        if (isLastRound && !lastRoundToolCatalog.length) {
          break;
        }

        timer.start(`dedupTools.r${round}`, {
          toolCalls: result.toolCalls.length,
        });
        const newToolCalls: AiToolCall[] = [];
        for (const toolCall of result.toolCalls) {
          if (isLastRound && !lastRoundToolNames.has(toolCall.name)) {
            continue;
          }
          const signature = `${toolCall.name}:${stableJson(toolCall.arguments)}`;
          if (seenToolCalls.has(signature)) {
            execution.emit({
              type: "tool_skipped_dedup",
              provider: provider.getConfig().name,
              toolName: toolCall.name,
              toolCallId: toolCall.id,
              result: {
                ok: true,
                code: "TOOL_DEDUP_SKIPPED",
                deduplicated: true,
              },
            });
            continue;
          }
          seenToolCalls.add(signature);
          newToolCalls.push(toolCall);
        }
        timer.stop({
          kept: newToolCalls.length,
          skipped: result.toolCalls.length - newToolCalls.length,
        });

        execution.emit({
          type: "provider_tool_calls",
          round,
          provider: provider.kind,
          toolNames: newToolCalls.map((t) => t.name),
          toolCalls: newToolCalls.map((t) => ({
            id: t.id,
            name: t.name,
            arguments: t.arguments,
          })),
        });

        messages.push({
          role: "assistant",
          content: result.content ?? "",
          toolCalls: newToolCalls,
        });

        const toolNames = newToolCalls.map((t) => t.name).join(",");
        timer.start(`executeTools.r${round}`, {
          count: newToolCalls.length,
          tools: toolNames,
        });
        const toolMessages = await this.executeToolCalls(
          ctx,
          execution,
          provider,
          newToolCalls,
          round,
          policy,
        );
        timer.stop();
        messages.push(...toolMessages);

        if (newToolCalls.some((t) => sendToolNames.has(t.name))) {
          sentToCustomer = true;
        }
        if (
          policy.terminalToolName &&
          newToolCalls.some((t) => t.name === policy.terminalToolName)
        ) {
          return { content: result.content, endedBy: "terminal_tool" };
        }
        if (isLastRound) {
          return { content: result.content, endedBy: "last_round" };
        }

        if (round === maxRounds - 1 && policy.lastRoundNote) {
          messages.push({ role: "user", content: policy.lastRoundNote });
        }

        continue;
      }

      if (result.role === "assistant" && typeof result.content === "string") {
        execution.emit({
          type: "provider_content",
          round,
          provider: provider.kind,
          content: result.content.slice(0, 500),
        });

        if (policy.onAssistantText === "finish" || sentToCustomer) {
          return { content: result.content, endedBy: "content" };
        }
        if (!nudged && !isLastRound) {
          nudged = true;
          messages.push({ role: "assistant", content: result.content });
          messages.push({
            role: "user",
            content: policy.assistantTextNudge ?? "",
          });
          continue;
        }
        return {
          content: result.content,
          error: "The agent answered in plain text without using a send tool",
          errorCode: "AGENT_NO_SEND_ACTION",
          endedBy: "no_send_action",
        };
      }

      throw new BadRequestException(this.translations.t("domains.ai.provider_no_content_or_tools"));
    }

    return {
      error:
        "Reached the maximum number of provider round-trips without a final answer",
      errorCode: "MAX_PROVIDER_ROUNDTRIPS",
      endedBy: "max_roundtrips",
    };
  }

  private async executeToolCalls(
    ctx: AiToolContext,
    execution: AiExecutionScope,
    provider: AiProviderAbstract,
    toolCalls: AiToolCall[],
    round: number,
    policy: AiLoopPolicy,
  ): Promise<AiChatMessage[]> {
    const run = (toolCall: AiToolCall) =>
      this.executeToolCall(ctx, execution, provider, toolCall, round, policy);

    if (policy.toolExecution === "parallel") {
      return Promise.all(toolCalls.map(run));
    }

    const toolMessages: AiChatMessage[] = [];
    let readBatch: AiToolCall[] = [];
    const flushReads = async () => {
      if (!readBatch.length) return;
      toolMessages.push(...(await Promise.all(readBatch.map(run))));
      readBatch = [];
    };

    for (const toolCall of toolCalls) {
      const tool = this.toolRegistry.getTool(toolCall.name);
      if (tool && !tool.isWrite) {
        readBatch.push(toolCall);
        continue;
      }
      await flushReads();
      toolMessages.push(await run(toolCall));
    }
    await flushReads();
    return toolMessages;
  }

  private async resolveProviders(ctx: AiToolContext): Promise<{
    primary: AiProviderAbstract;
    candidates: AiProviderAbstract[];
    userExplicitChoice: boolean;
    toolsCalling?: boolean;
  }> {
    const tenantId = ctx.session.useSystemIntegrations
      ? null
      : ctx.session.tenantId;
    const requireTools = ctx.session.requireTools === true;
    const requestedModel = ctx.session.model;
    const preferredProviderId = ctx.session.providerId;
    const preferredProviderCode = ctx.session.provider;
    const preferredHint = preferredProviderId ?? preferredProviderCode;
    const allowFailover = ctx.session.allowProviderFailover !== false;
    const pinToChoice = !!requestedModel && !allowFailover;

    let route: {
      modelCode: string;
      providerEntityId: string;
      toolsCalling?: boolean | null;
    } | null = null;
    let usedDefaultModel = false;
    let usedModelLookup = false;
    let usedBestModel = false;

    if (requestedModel) {
      const t0 = performance.now();
      const providerByModel =
        await this.providerSelector.resolveProviderByModelId(
          requestedModel,
          tenantId,
          preferredHint,
        );
      usedModelLookup = true;
      this.logger.debug("[perf] resolveProviderByModelId", {
        requestId: ctx.requestId,
        model: requestedModel,
        tenantId: tenantId ?? "system",
        found: !!providerByModel,
        ms: performance.now() - t0,
      });
      if (providerByModel) {
        route = {
          modelCode: requestedModel,
          providerEntityId: providerByModel,
        };
      }
    }

    if (pinToChoice && !route) {
      throw new AiProviderError(
        this.translations.t("domains.ai.model_inactive", {
          args: { model: requestedModel },
        }),
        { kind: "CONFIG", provider: String(preferredHint ?? "none") },
      );
    }

    if (requireTools && !pinToChoice) {
      const tooling = await this.providerSelector.resolveToolingCandidates(
        tenantId,
        {
          requireTools: true,
          preferredProviderId,
          preferredProviderCode,
        },
      );
      if (!tooling.length) {
        throw new AiProviderError(
          this.translations.t("domains.ai.no_provider_available"),
          { kind: "CONFIG", provider: preferredHint ?? "none" },
        );
      }
      const primary = tooling[0];
      const modelMeta = await this.loadModelForProvider(
        primary.getConfig().model,
        primary.getConfig().entityId,
        tenantId,
      );
      ctx.session.model = primary.getConfig().model;
      return {
        primary,
        candidates: allowFailover ? tooling : [primary],
        userExplicitChoice: false,
        toolsCalling: modelMeta?.toolsCalling ?? undefined,
      };
    }

    if (!route && !requestedModel && !preferredHint) {
      const t0 = performance.now();
      route = await this.providerSelector.resolveDefaultModel(tenantId, {
        requireTools,
      });
      usedDefaultModel = true;
      this.logger.debug("[perf] resolveDefaultModel", {
        requestId: ctx.requestId,
        tenantId: tenantId ?? "system",
        found: !!route,
        modelCode: route?.modelCode ?? null,
        providerEntityId: route?.providerEntityId ?? null,
        ms: performance.now() - t0,
      });
    }

    if (!route && preferredHint && !requestedModel) {
      const preferredBest = await this.providerSelector.resolveBestConfigured(
        tenantId,
        {
          requireTools,
          preferredProviderId,
          preferredProviderCode,
        },
      );
      const preferredDefault = await this.providerSelector.resolveDefaultModel(
        tenantId,
        { requireTools },
      );
      if (
        preferredBest &&
        preferredDefault?.providerEntityId === preferredBest.providerEntityId
      ) {
        route = preferredDefault;
        usedDefaultModel = true;
      } else if (preferredBest) {
        route = preferredBest;
        usedBestModel = true;
      }
    }

    if (!route && !requestedModel) {
      if (!usedDefaultModel) {
        const t0 = performance.now();
        route = await this.providerSelector.resolveDefaultModel(tenantId, {
          requireTools,
        });
        usedDefaultModel = true;
        this.logger.debug("[perf] resolveDefaultModel.fallback", {
          requestId: ctx.requestId,
          found: !!route,
          ms: performance.now() - t0,
        });
      }
    }

    if (!route) {
      route = await this.providerSelector.resolveBestConfigured(tenantId, {
        requireTools,
      });
      usedBestModel = !!route;
    }

    if (!route) {
      throw new AiProviderError(
        this.translations.t("domains.ai.no_provider_available"),
        { kind: "CONFIG", provider: preferredHint ?? "none" },
      );
    }

    ctx.session.model = route.modelCode;

    const t1 = performance.now();
    let primary = await this.selectProvider(route.providerEntityId, tenantId);
    const selectMs = performance.now() - t1;
    this.logger.debug("[perf] providerSelector.select", {
      requestId: ctx.requestId,
      requested: route.providerEntityId,
      providerKind: primary.kind,
      entityId: primary.getConfig().entityId ?? null,
      model: route.modelCode,
      ms: selectMs,
    });

    const modelMeta = await this.loadModelForProvider(
      route.modelCode,
      primary.getConfig().entityId,
      tenantId,
    );
    let toolsCalling = route.toolsCalling ?? undefined;
    if (modelMeta) {
      toolsCalling = modelMeta.toolsCalling ?? toolsCalling;
    }
    primary = primary.cloneWithRuntime({ model: route.modelCode });

    if (requireTools && toolsCalling === false) {
      throw new AiProviderError(
        this.translations.t("domains.ai.model_tools_unsupported", {
          args: { model: route.modelCode },
        }),
        { kind: "CONFIG", provider: primary.getCatalogCode() },
      );
    }

    if (pinToChoice) {
      this.logger.debug(
        "[perf] resolveProviders — user explicit choice, no failovers",
        {
          requestId: ctx.requestId,
          primary: primary.kind,
          requestedProviderId: ctx.session.providerId ?? null,
          selectMs,
          usedDefaultModel,
          usedModelLookup,
        },
      );
      return {
        primary,
        candidates: [primary],
        userExplicitChoice: true,
        toolsCalling,
      };
    }

    const excludeKey = primary.getConfig().entityId ?? primary.kind;
    const t2 = performance.now();
    const failovers = allowFailover
      ? await this.providerSelector.failoverCandidates(excludeKey, tenantId, {
          requireTools,
        })
      : [];
    const failoverMs = performance.now() - t2;
    this.logger.debug("[perf] failoverCandidates", {
      requestId: ctx.requestId,
      excludeKey,
      tenantId: tenantId ?? "system",
      failoverCount: failovers.length,
      failoverKinds: failovers.map((p) => p.kind),
      ms: failoverMs,
    });

    this.logger.debug("[perf] resolveProviders DONE", {
      requestId: ctx.requestId,
      primary: primary.kind,
      primaryModel: primary.getConfig().model ?? null,
      failovers: failovers.map((p) => p.kind),
      selectMs,
      failoverMs,
      usedDefaultModel,
      usedModelLookup,
      usedBestModel,
      allowFailover,
    });

    return {
      primary,
      candidates: [primary, ...failovers],
      userExplicitChoice: false,
      toolsCalling,
    };
  }

  private async selectProvider(
    requested: string,
    tenantId?: string | null,
  ): Promise<AiProviderAbstract> {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        requested,
      );
    if (isUuid) {
      return this.providerSelector.selectCustom(requested, tenantId);
    }
    return this.providerSelector.select(requested, tenantId);
  }

  private async loadModelForProvider(
    modelCode: string,
    providerEntityId: string | undefined,
    tenantId?: string | null,
  ): Promise<AiModelEntity | null> {
    const qb = this.modelRepo
      .createQueryBuilder("model")
      .innerJoinAndSelect("model.provider", "provider")
      .leftJoinAndSelect(
        "model.availabilities",
        "availability",
        "availability.adminId = :adminId",
        {
          adminId: tenantId ?? "00000000-0000-0000-0000-000000000000",
        },
      )
      .where("model.modelCode = :modelCode", { modelCode });

    if (providerEntityId) {
      qb.andWhere("model.providerId = :providerId", {
        providerId: providerEntityId,
      });
    }

    const modelEntity = await qb.getOne();
    if (!modelEntity) return null;

    if (!modelEntity.provider?.isActive) {
      throw new AiProviderError(
        this.translations.t("domains.ai.provider_inactive_for_model", {
          args: { model: modelCode },
        }),
        { kind: "CONFIG", provider: modelEntity.provider?.code },
      );
    }
    if (!modelEntity.isActive) {
      throw new AiProviderError(
        this.translations.t("domains.ai.model_inactive", {
          args: { model: modelCode },
        }),
        { kind: "CONFIG", provider: modelEntity.provider?.code },
      );
    }
    if (modelEntity.availabilities?.[0]?.isAvailable === false) {
      throw new AiProviderError(
        this.translations.t("domains.ai.model_not_available_for_tenant", {
          args: { model: modelCode },
        }),
        { kind: "CONFIG", provider: modelEntity.provider?.code },
      );
    }
    return modelEntity;
  }

  private async callProviderWithFailover(
    execution: AiExecutionScope,
    messages: AiChatMessage[],
    toolSpecs: ReturnType<AiToolRegistryService["getToolSpecs"]>,
    round: number,
    candidates: AiProviderAbstract[],
    userExplicitChoice?: boolean,
  ): Promise<{
    provider: AiProviderAbstract;
    result: {
      role: "assistant";
      content?: string;
      toolCalls?: AiToolCall[];
      usage?: AiUsage;
      providerModel?: string;
    };
  }> {
    let lastError: unknown;
    const failedDetails: Array<{
      provider: string;
      model?: string | null;
      error?: string;
    }> = [];
    const attemptTimes: Array<{
      provider: string;
      ms: number;
      ok: boolean;
      errorCode?: string;
    }> = [];

    const remaining = candidates.filter(
      (candidate) =>
        !execution.isCandidateFailed(
          candidate.getCatalogCode(),
          candidate.getConfig().model,
        ),
    );
    if (!remaining.length) {
      const emptySummary = formatAttemptsSummary(
        execution.getAttempts().map((attempt) => ({
          provider: attempt.code,
          model: attempt.model,
        })),
      );
      const emptyWrapped = toAiProviderError(
        execution.getLastCandidateError() ??
          new Error(this.translations.t("domains.ai.all_providers_failed")),
      );
      throw attachAttemptsToError(
        new AiProviderError(
          emptySummary
            ? `${emptyWrapped.message} | ${emptySummary}`
            : emptyWrapped.message,
          {
            kind: emptyWrapped.kind,
            provider: emptyWrapped.provider,
            status: emptyWrapped.providerStatus,
            retryable: emptyWrapped.retryable,
            cause: emptyWrapped,
          },
        ),
        execution.getAttempts(),
        emptySummary,
      );
    }

    for (const candidate of remaining) {
      execution.emit({
        type: "provider_start",
        round,
        provider: candidate.getConfig().name,
      });
      const t0 = performance.now();

        try {
        const result = await candidate.callModel({
          messages,
          tools: toolSpecs,
          toolChoice: toolSpecs.length > 0 ? "auto" : "none",
        });
        const ms = performance.now() - t0;
        attemptTimes.push({ provider: candidate.kind, ms, ok: true });
        await this.modelHealth.recordCallOutcome({
          tenantId: execution.session.tenantId,
          providerEntityId: candidate.getConfig().entityId,
          modelCode: result.providerModel ?? candidate.getConfig().model,
          classification: "SUCCESS",
          usedTools: toolSpecs.length > 0,
        });
        const toolCallsLen =
          "toolCalls" in result ? result.toolCalls.length : 0;
        const contentLen = "content" in result ? result.content.length : 0;
        this.logger.debug("[perf] provider.callModel OK", {
          requestId: execution.requestId,
          round,
          provider: candidate.kind,
          model: result.providerModel ?? candidate.getConfig().model ?? null,
          ms,
          promptTokens: result.usage?.promptTokens ?? 0,
          completionTokens: result.usage?.completionTokens ?? 0,
          totalTokens: result.usage?.totalTokens ?? 0,
          toolCalls: toolCallsLen,
          contentLen,
        });
        return { provider: candidate, result };
      } catch (error) {
        const ms = performance.now() - t0;
        lastError = error;
        const classified = classifyProviderFailure(error);
        execution.trackAttempt(
          candidate.getCatalogCode(),
          candidate.getConfig().model ?? null,
        );
        execution.markCandidateFailed(
          candidate.getCatalogCode(),
          candidate.getConfig().model,
          error,
        );
        await this.modelHealth.recordCallOutcome({
          tenantId: execution.session.tenantId,
          providerEntityId: candidate.getConfig().entityId,
          modelCode: candidate.getConfig().model,
          classification: classified,
          errorKind: errorKindOf(error),
          usedTools: toolSpecs.length > 0,
        });
        const code = isAiProviderError(error) ? error.kind : undefined;
        attemptTimes.push({
          provider: candidate.kind,
          ms,
          ok: false,
          errorCode: code,
        });
        const message = error instanceof Error ? error.message : String(error);
        failedDetails.push({
          provider: candidate.getCatalogCode(),
          model: candidate.getConfig().model,
          error: message.slice(0, 200),
        });
        execution.emit({
          type: "provider_failover",
          round,
          provider: candidate.getConfig().name,
          error: message.slice(0, 500),
        });
        this.logger.debug("[perf] provider.callModel FAILED", {
          requestId: execution.requestId,
          round,
          provider: candidate.kind,
          ms,
          errorCode: code ?? "ERROR",
          error: message.slice(0, 200),
        });
        if (userExplicitChoice) {
          throw lastError;
        }
      }
    }

    this.logger.debug("[perf] provider.callModel ALL FAILED", {
      requestId: execution.requestId,
      round,
      attempts: attemptTimes,
    });
    const summary = formatAttemptsSummary(failedDetails);
    const wrapped = toAiProviderError(
      lastError ??
        new Error(this.translations.t("domains.ai.all_providers_failed")),
      remaining[remaining.length - 1]?.getCatalogCode(),
    );
    const withSummary = new AiProviderError(
      summary ? `${wrapped.message} | ${summary}` : wrapped.message,
      {
        kind: wrapped.kind,
        provider: wrapped.provider,
        status: wrapped.providerStatus,
        retryable: wrapped.retryable,
        cause: wrapped,
      },
    );
    throw attachAttemptsToError(
      withSummary,
      execution.getAttempts(),
      summary,
    );
  }

  private async executeToolCall(
    ctx: AiToolContext,
    execution: AiExecutionScope,
    provider: AiProviderAbstract,
    toolCall: AiToolCall,
    round: number,
    policy: AiLoopPolicy,
  ): Promise<AiChatMessage> {
    const t0 = performance.now();
    const registered = this.toolRegistry.getTool(toolCall.name);
    const tool = registered?.serves(policy.audience) ? registered : undefined;
    const perToolTimer = new PhaseTimer();

    if (!tool) {
      const ms = performance.now() - t0;
      this.logger.debug("[perf] tool.skip.UNKNOWN_TOOL", {
        requestId: ctx.requestId,
        round,
        tool: toolCall.name,
        ms,
      });
      return {
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify({
          ok: false,
          code: "UNKNOWN_TOOL",
          error: `Tool '${toolCall.name}' does not exist`,
        }),
      };
    }

    if (!tool.canRunFor(ctx, policy.audience)) {
      const ms = performance.now() - t0;
      this.logger.debug("[perf] tool.skip.TOOL_NOT_ALLOWED", {
        requestId: ctx.requestId,
        round,
        tool: tool.name,
        ms,
      });
      return {
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify({
          ok: false,
          code: "TOOL_NOT_ALLOWED",
          error: "You do not have permission to call this tool",
        }),
      };
    }

    if (tool.isWrite && !ctx.session.acceptWriteOperations) {
      const ms = performance.now() - t0;
      this.logger.debug("[perf] tool.skip.WRITE_NOT_ACCEPTED", {
        requestId: ctx.requestId,
        round,
        tool: tool.name,
        ms,
      });
      return {
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify({
          ok: false,
          code: "WRITE_OPERATION_NOT_ACCEPTED",
          error:
            "Write operations are blocked for this request. The user must explicitly accept them (acceptWriteOperations=true) before data is modified or messages are sent.",
        }),
      };
    }

    let result: AiToolExecutionResult;

    if (tool.isWrite && this.config.writeToolDedup.enabled) {
      result = await this.executeWriteToolIdempotently(
        ctx,
        execution,
        tool,
        toolCall,
        perToolTimer,
        policy,
      );
    } else {
      execution.emit({
        type: "tool_start",
        round,
        provider: provider.getConfig().name,
        toolName: tool.name,
        toolCallId: toolCall.id,
      });
      perToolTimer.start("tool.execute", {
        tool: tool.name,
        round,
        isWrite: tool.isWrite,
      });
      result = await tool.execute(ctx, toolCall.arguments);
      perToolTimer.stop({ ok: result.ok ?? true, code: result.code ?? null });
      this.logger.debug("[perf] tool.execute", {
        requestId: ctx.requestId,
        round,
        tool: tool.name,
        isWrite: tool.isWrite,
        ok: result.ok ?? true,
        code: result.code ?? null,
        ms: perToolTimer.sinceStartMs(),
      });
      execution.emit({
        type: "tool_result",
        round,
        provider: provider.getConfig().name,
        toolName: tool.name,
        toolCallId: toolCall.id,
        result,
      });
    }

    const totalMs = performance.now() - t0;
    return {
      role: "tool",
      toolCallId: toolCall.id,
      content: JSON.stringify(result).slice(0, 100_000),
    };
  }

  private async executeWriteToolIdempotently(
    ctx: AiToolContext,
    execution: AiExecutionScope,
    tool: AiTool,
    toolCall: AiToolCall,
    timer: PhaseTimer,
    policy: AiLoopPolicy,
  ): Promise<AiToolExecutionResult> {
    const adminId = ctx.session.tenantId ?? ctx.session.userId;
    const toolCallId = toolCall.id;
    const args = toolCall.arguments;
    const t0 = performance.now();

    timer.start("writeTool.argsSerialize");
    const argsJson = stableJson(args);
    if (argsJson.length > 100_000) {
      timer.stop({ len: argsJson.length });
      return {
        ok: false,
        code: "TOOL_ARGS_TOO_LARGE",
        error: "Tool arguments exceed the maximum allowed size (100KB).",
      };
    }
    const argsHash = sha256(argsJson);
    const scopedKey = policy.writeDedupScope?.(toolCall, ctx) ?? null;
    const dedupKey = scopedKey ?? tool.dedup?.key?.(args) ?? argsHash;
    timer.stop({
      len: argsJson.length,
      usedCustomDedupKey: !!tool.dedup?.key,
      usedScopedDedupKey: !!scopedKey,
    });

    timer.start("writeTool.findExisting");
    const pending = await this.auditService.findWriteCall(
      adminId,
      tool.name,
      dedupKey,
    );
    timer.stop({ found: !!pending, status: pending?.status ?? null });

    if (pending) {
      switch (pending.status) {
        case AiWriteToolCallStatus.COMPLETED:
          execution.emit({
            type: "tool_skipped_dedup",
            provider: undefined,
            toolName: tool.name,
            toolCallId: toolCall.id,
            result: {
              ok: true,
              code: "TOOL_RESULT_DEDUPLICATED",
              data: pending.result,
              deduplicated: true,
            },
          });
          this.logger.debug("[perf] writeTool.hit.COMPLETED_dedup", {
            requestId: ctx.requestId,
            tool: tool.name,
            totalMs: performance.now() - t0,
          });
          return {
            ok: true,
            code: "TOOL_RESULT_DEDUPLICATED",
            data: pending.result,
            deduplicated: true,
          };

        case AiWriteToolCallStatus.PENDING: {
          const ageMs = Date.now() - new Date(pending.createdAt).getTime();
          if (ageMs <= this.config.writeToolDedup.pendingTtlMs) {
            this.logger.debug("[perf] writeTool.hit.STALE_PENDING_young", {
              requestId: ctx.requestId,
              tool: tool.name,
              ageMs,
            });
            return {
              ok: false,
              code: "STALE_PENDING",
              error:
                "This write operation is still being processed by a previous request. Do not retry it yet.",
            };
          }
          timer.start("writeTool.markStale");
          await this.auditService.markStale(adminId, tool.name, dedupKey);
          timer.stop();
          if (tool.staleRecovery === "manual_review") {
            return {
              ok: false,
              code: "STALE_PENDING_REQUIRES_REVIEW",
              error:
                "This write operation previously did not complete and requires manual review before it can be retried.",
            };
          }
          break;
        }

        case AiWriteToolCallStatus.STALE:
        case AiWriteToolCallStatus.FAILED:
          if (tool.staleRecovery === "manual_review") {
            return {
              ok: false,
              code: "STALE_PENDING_REQUIRES_REVIEW",
              error:
                "This write operation did not complete and requires manual review before it can be retried.",
            };
          }
          break;
      }
    }

    timer.start("writeTool.claim");
    const claimed = await this.auditService.claimWriteCall({
      adminId,
      toolName: tool.name,
      toolCallId,
      dedupKey,
      argsHash,
      args,
      requestId: execution.requestId,
      sessionId: execution.session.sessionId,
    });
    timer.stop({ claimed: !!claimed });

    if (!claimed) {
      this.logger.debug("[perf] writeTool.race.another_claim_won", {
        requestId: ctx.requestId,
        tool: tool.name,
        totalMs: performance.now() - t0,
      });
      return {
        ok: false,
        code: "STALE_PENDING",
        error:
          "Another request is already processing this write operation. Do not retry it yet.",
      };
    }

    execution.emit({
      type: "tool_start",
      round: execution.currentRound,
      toolName: tool.name,
      toolCallId: toolCall.id,
    });

    let result: AiToolExecutionResult;
    try {
      timer.start("writeTool.execute");
      result = await tool.execute(ctx, args);
      timer.stop({ ok: result.ok ?? true, code: result.code ?? null });
    } catch (error) {
      const message = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 10_000);
      timer.start("writeTool.auditFail");
      await this.auditService.failWriteCall(
        adminId,
        tool.name,
        dedupKey,
        message,
      );
      timer.stop();
      execution.emit({
        type: "tool_result",
        round: execution.currentRound,
        toolName: tool.name,
        toolCallId: toolCall.id,
        result: { ok: false, code: "TOOL_EXECUTION_ERROR", error: message },
      });
      throw error;
    }

    timer.start("writeTool.serializeAndPersist");
    const cappedResult = JSON.parse(JSON.stringify(result).slice(0, 100_000));
    execution.emit({
      type: "tool_result",
      round: execution.currentRound,
      toolName: tool.name,
      toolCallId: toolCall.id,
      result: cappedResult,
    });
    await this.auditService.completeWriteCall(
      adminId,
      tool.name,
      dedupKey,
      cappedResult,
    );
    timer.stop();

    this.logger.debug("[perf] writeTool.executed", {
      requestId: ctx.requestId,
      tool: tool.name,
      ok: cappedResult.ok ?? true,
      code: cappedResult.code ?? null,
      totalMs: performance.now() - t0,
    });
    return cappedResult;
  }

  private async finalize(
    ctx: AiToolContext,
    execution: AiExecutionScope,
    result: {
      content?: string;
      error?: string;
      errorCode?: string;
      errorDetails?: AiOrchestrationError;
      endedBy?: AiTurnEndReason;
    },
    pairs: Array<{ token: string; original: string }>,
    timer: PhaseTimer,
    userMessage?: string,
    usageHint?: {
      usageSource?: AiUsageSource;
      usageApi?: string;
      usageActor?: AiUsageActor;
      usageOrderId?: string;
    },
  ): Promise<{
    finalResult: AiOrchestrationResult;
    providersUsed: string[];
    modelsUsed: string[];
    rounds: number;
    progress: AiProgressEvent[];
  }> {
    timer.start("finalize.aggregateUsage");
    const usage = execution.getUsage();
    const ok = !result.error;
    timer.stop();

    let content: string | undefined;
    if (typeof result.content === "string") {
      timer.start("finalize.piiUnmask", {
        enabled: ctx.session.enforcePiiMasking,
      });
      content = ctx.session.enforcePiiMasking
        ? this.piiMasker.unmask(result.content, pairs)
        : result.content;
      timer.stop({
        contentLen: content?.length ?? 0,
        pairsCount: pairs.length,
      });
    }

    timer.start("finalize.aggregateEvents");
    const progress = execution.getEvents();
    const providersUsed = execution.getProvidersUsed();
    const modelsUsed = execution.getModelsUsed();
    const aiAttempts = execution.getAttempts();
    const rounds = execution.currentRound;
    const finalResult: AiOrchestrationResult = {
      sessionId: execution.session.sessionId,
      requestId: execution.requestId,
      conversationId: execution.session.conversationId,
      ok,
      content,
      endedBy: result.endedBy,
      usage,
      error: result.error,
      errorCode: result.errorCode,
      errorDetails: result.errorDetails,
      progress,
      providersUsed,
      modelsUsed,
      aiAttempts,
      rounds,
    };
    timer.stop({
      eventsCount: progress.length,
      providersUsed: providersUsed.length,
      modelsUsed: modelsUsed.length,
    });

    // Await so callers (e.g. address-conflict resume) can load history by sessionId.
    timer.start("finalize.persistSummary");
    try {
      const ms = await this.persistSummary(
        ctx,
        execution,
        result,
        usage,
        ok,
        progress,
        providersUsed,
        modelsUsed,
        rounds,
        userMessage,
        content,
        usageHint,
      );
      this.logger.debug("[perf] persistSummary", {
        requestId: ctx.requestId,
        ok: true,
        ms,
      });
    } catch (err) {
      this.logger.error("[finalize] persistSummary failed", err);
    }
    timer.stop();

    return { finalResult, providersUsed, modelsUsed, rounds, progress };
  }

  private async persistSummary(
    ctx: AiToolContext,
    execution: AiExecutionScope,
    result: { error?: string; errorCode?: string },
    usage: AiUsage,
    ok: boolean,
    progress: AiProgressEvent[],
    providersUsed: string[],
    modelsUsed: string[],
    rounds: number,
    userMessage?: string,
    assistantContent?: string,
    usageHint?: {
      usageSource?: AiUsageSource;
      usageApi?: string;
      usageActor?: AiUsageActor;
      usageOrderId?: string;
    },
  ): Promise<number> {
    const t0 = performance.now();
    const adminId = ctx.session.tenantId ?? ctx.session.userId;

    const conversationSummary = this.config.storeConversationSummaries
      ? {
          conversationId: execution.session.conversationId,
          lastError: result.error ?? null,
          lastToolNames: extractToolNames(progress),
          usage,
          rounds,
          providersUsed,
          modelsUsed,
        }
      : {};

    await this.auditService.createRequestSummary({
      adminId,
      sessionId: execution.session.sessionId,
      conversationId: execution.session.conversationId,
      requestId: execution.requestId,
      status: ok ? "ok" : "error",
      usagePromptTokens: usage.promptTokens,
      usageCompletionTokens: usage.completionTokens,
      usageTotalTokens: usage.totalTokens,
      rounds,
      durationMs: execution.getDurationMs(),
      errorCode: result.errorCode,
      error: result.error,
      summary: {
        ...conversationSummary,
        // Stored on AI session so automation steps need not expose full chat history
        userMessage: userMessage ?? null,
        assistantContent: assistantContent ?? null,
      },
      progress,
      providersUsed,
      modelsUsed,
    });
    if (usageHint?.usageSource && adminId) {
      await this.usageLedger.record({
        adminId,
        source: usageHint.usageSource,
        api: usageHint.usageApi ?? "ai.orchestrator",
        actor: usageHint.usageActor ?? AiUsageActor.SYSTEM,
        billedBy: AiUsageBilledBy.MERCHANT,
        providerCode: providersUsed[providersUsed.length - 1] ?? null,
        modelCode: modelsUsed[modelsUsed.length - 1] ?? null,
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
        rounds,
        status: ok ? AiUsageStatus.OK : AiUsageStatus.FAILED,
        requestId: execution.requestId,
        sessionId: execution.session.sessionId,
        conversationId: execution.session.conversationId ?? null,
        orderId: usageHint.usageOrderId ?? null,
      });
    }
    return performance.now() - t0;
  }

  /**
   * Rebuild compact chat history for a prior AI session from ai_request_summaries.
   * Used by automation resume without persisting aiHistory on run step output.
   */
  async getSessionHistory(sessionId: string): Promise<AiChatMessage[]> {
    if (!sessionId) return [];
    const row = await this.auditService.findBySessionId(sessionId);
    if (!row) return [];

    const summary = (row.summary || {}) as Record<string, any>;
    const history: AiChatMessage[] = [];

    if (typeof summary.userMessage === "string" && summary.userMessage.trim()) {
      history.push({ role: "user", content: summary.userMessage });
    }

    const assistantContent =
      (typeof summary.assistantContent === "string" &&
      summary.assistantContent.trim()
        ? summary.assistantContent
        : null) ||
      (Array.isArray(row.progress)
        ? [...row.progress]
            .reverse()
            .find((e: any) => e?.type === "provider_content" && e?.content)
            ?.content
        : null);

    if (typeof assistantContent === "string" && assistantContent.trim()) {
      history.push({ role: "assistant", content: assistantContent });
    }

    return history;
  }

  private resolveTenantId(me: any): string | null {
    if (!me) return null;
    const roleName = me.role?.name;
    if (roleName === "super_admin") return null;
    if (roleName === "admin") return me.id ?? null;
    return me.adminId ?? null;
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(sortObject(value ?? {}));
  } catch {
    return "{}";
  }
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortObject((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

function extractToolNames(events: AiProgressEvent[]): string[] {
  const names = new Set<string>();
  for (const event of events) {
    if (event.type === "tool_start" && event.toolName) {
      names.add(event.toolName);
    }
  }
  return Array.from(names);
}
