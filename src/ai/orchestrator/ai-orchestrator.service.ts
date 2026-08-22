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
  AiUsage,
} from "../interfaces/ai-types";
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
import { isAiProviderError, AiProviderError } from "../errors/provider.errors";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AiModelAvailabilityEntity, AiModelEntity } from "../../../entities/ai.entity";
import { TranslationService } from "../../../common/translation.service";

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
}

const FORCE_ANSWER_NOTE =
  "You have already retrieved all the information needed to answer the user's request. Do not call any more tools. Provide the final answer now using only the tool results already present in this conversation.";

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
  ) { }

  async chat(
    me: any,
    userMessage: string,
    options: AiChatOptions = {},
  ): Promise<AiOrchestrationResult> {
    const timer = new PhaseTimer();
    const requestId = randomUUID();
    const sessionId = randomUUID();

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

    let finalResult: AiOrchestrationResult;
    let providersUsed: string[] = [];
    let modelsUsed: string[] = [];
    let rounds = 0;
    let progress: AiProgressEvent[] = [];
    try {
      timer.start("runLoop");
      const result = await this.runLoop(ctx, execution, messages, timer);
      timer.stop({
        rounds: execution.currentRound,
        outcome: result.error ? "error" : "ok",
      });

      timer.start("finalize");
      const finalized = this.finalize(
        ctx,
        execution,
        result,
        masked.pairs,
        timer,
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

      throw error;
    }

    const summary = timer.summarize();
    this.logger.info("[chat] phase timing — REQUEST SUMMARY", {
      requestId,
      sessionId,
      userId: session.userId,
      tenantId: session.tenantId,
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
        rounds,
        progress,
      };
      finalResult._dev = devInfo;
    }

    return finalResult;
  }

  private async runLoop(
    ctx: AiToolContext,
    execution: AiExecutionScope,
    messages: AiChatMessage[],
    timer: PhaseTimer,
  ): Promise<{ content?: string; error?: string; errorCode?: string }> {
    timer.start("runLoop.toolSpecs");
    const allToolSpecs = this.toolRegistry.getToolSpecs(ctx);
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

    for (let round = 1; round <= maxRounds; round++) {
      execution.beginRound();

      const isLastRound = round === maxRounds;
      const effectiveToolSpecs = isLastRound ? [] : effectiveToolCatalog;

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

      execution.trackProvider(provider.kind);
      execution.trackModel(
        result.providerModel ?? provider.getConfig().model ?? "",
      );
      execution.recordUsage(result.usage);

      if (result.role === "assistant" && result.toolCalls?.length) {
        if (isLastRound) {
          break;
        }

        timer.start(`dedupTools.r${round}`, {
          toolCalls: result.toolCalls.length,
        });
        const newToolCalls: AiToolCall[] = [];
        for (const toolCall of result.toolCalls) {
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
          content: null,
          toolCalls: newToolCalls,
        });

        const toolNames = newToolCalls.map((t) => t.name).join(",");
        timer.start(`executeTools.r${round}`, {
          count: newToolCalls.length,
          tools: toolNames,
        });
        const toolMessages = await Promise.all(
          newToolCalls.map((toolCall) =>
            this.executeToolCall(ctx, execution, provider, toolCall, round),
          ),
        );
        timer.stop();
        messages.push(...toolMessages);

        if (round === maxRounds - 1) {
          messages.push({ role: "user", content: FORCE_ANSWER_NOTE });
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
        return { content: result.content };
      }

      throw new BadRequestException(this.translations.t("domains.ai.provider_no_content_or_tools"));
    }

    return {
      error:
        "Reached the maximum number of provider round-trips without a final answer",
      errorCode: "MAX_PROVIDER_ROUNDTRIPS",
    };
  }

  private async resolveProviders(ctx: AiToolContext): Promise<{
    primary: AiProviderAbstract;
    candidates: AiProviderAbstract[];
    userExplicitChoice: boolean;
    toolsCalling?: boolean;
  }> {
    const userExplicitChoice = !!(
      ctx.session.provider ||
      ctx.session.providerId ||
      ctx.session.model
    );
    let requested =
      ctx.session.provider ?? ctx.session.providerId ?? this.config.defaultProvider;
    const requestedModel = ctx.session.model;
    let usedDefaultModel = false;
    let usedModelLookup = false;

    if (!ctx.session.provider && !ctx.session.providerId) {
      if (requestedModel) {
        const t0 = performance.now();
        const providerByModel =
          await this.providerSelector.resolveProviderByModelId(
            requestedModel,
            ctx.session.tenantId,
          );
        const ms = performance.now() - t0;
        usedModelLookup = true;
        this.logger.debug("[perf] resolveProviderByModelId", {
          requestId: ctx.requestId,
          model: requestedModel,
          tenantId: ctx.session.tenantId ?? "system",
          found: !!providerByModel,
          ms,
        });
        if (providerByModel) {
          requested = providerByModel;
        }
      } else {
        const t0 = performance.now();
        const resolved = await this.providerSelector.resolveDefaultModel(
          ctx.session.tenantId,
        );
        const ms = performance.now() - t0;
        usedDefaultModel = true;
        this.logger.debug("[perf] resolveDefaultModel", {
          requestId: ctx.requestId,
          tenantId: ctx.session.tenantId ?? "system",
          found: !!resolved,
          modelCode: resolved?.modelCode ?? null,
          providerEntityId: resolved?.providerEntityId ?? null,
          ms,
        });
        if (resolved) {
          requested = resolved.providerEntityId;
          (ctx.session as any).model = resolved.modelCode;
        }
      }
    }

    let primary: AiProviderAbstract;
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        requested,
      );
    const t1 = performance.now();
    if (requested && isUuid) {
      primary = await this.providerSelector.selectCustom(
        requested,
        ctx.session.tenantId,
      );
    } else {
      primary = await this.providerSelector.select(
        requested,
        ctx.session.tenantId,
      );
    }
    const selectMs = performance.now() - t1;
    this.logger.debug("[perf] providerSelector.select", {
      requestId: ctx.requestId,
      requested,
      kind: isUuid ? "selectCustom/uuid" : "select/name",
      providerKind: primary.kind,
      entityId: primary.getConfig().entityId ?? null,
      model: primary.getConfig().model ?? null,
      ms: selectMs,
    });

    const effectiveModel = (ctx.session as any).model ?? requestedModel;
    let toolsCalling: boolean | undefined;
    if (effectiveModel) {
      const qb = this.modelRepo
        .createQueryBuilder("model")
        .innerJoinAndSelect("model.provider", "provider")
        .leftJoinAndSelect(
          "model.availabilities",
          "availability",
          "availability.adminId = :adminId",
          {
            adminId:
              ctx.session.tenantId ?? "00000000-0000-0000-0000-000000000000",
          },
        )
        .where("model.modelCode = :modelCode", {
          modelCode: effectiveModel,
        });

      const providerEntityId = primary.getConfig().entityId;
      if (providerEntityId) {
        qb.andWhere("model.providerId = :providerId", {
          providerId: providerEntityId,
        });
      }

      const modelEntity = await qb.getOne();

      if (modelEntity) {
        if (!modelEntity.provider?.isActive) {
          throw new AiProviderError(
            this.translations.t("domains.ai.provider_inactive_for_model", { args: { model: effectiveModel } }),
            { kind: "CONFIG", provider: primary.kind },
          );
        }
        if (!modelEntity.isActive) {
          throw new AiProviderError(
            this.translations.t("domains.ai.model_inactive", { args: { model: effectiveModel } }),
            { kind: "CONFIG", provider: primary.kind },
          );
        }
        if (modelEntity.availabilities?.[0]?.isAvailable === false) {
          throw new AiProviderError(
            this.translations.t("domains.ai.model_not_available_for_tenant", { args: { model: effectiveModel } }),
            { kind: "CONFIG", provider: primary.kind },
          );
        }
        toolsCalling = modelEntity.toolsCalling;
      }

      primary = primary.cloneWithRuntime({
        model: effectiveModel,
      });
    }

    if (userExplicitChoice) {
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
      return { primary, candidates: [primary], userExplicitChoice: true, toolsCalling };
    }

    const excludeKey = primary.getConfig().entityId ?? primary.getConfig().name;
    const t2 = performance.now();
    const failovers = await this.providerSelector.failoverCandidates(
      excludeKey,
      ctx.session.tenantId,
    );
    const failoverMs = performance.now() - t2;
    this.logger.debug("[perf] failoverCandidates", {
      requestId: ctx.requestId,
      excludeKey,
      tenantId: ctx.session.tenantId ?? "system",
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
    });

    return {
      primary,
      candidates: [primary, ...failovers],
      userExplicitChoice: false,
      toolsCalling,
    };
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
    const attemptTimes: Array<{
      provider: string;
      ms: number;
      ok: boolean;
      errorCode?: string;
    }> = [];

    for (const candidate of candidates) {
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
        const code = isAiProviderError(error) ? error.kind : undefined;
        attemptTimes.push({
          provider: candidate.kind,
          ms,
          ok: false,
          errorCode: code,
        });
        const message = error instanceof Error ? error.message : String(error);
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
    throw lastError ?? new Error(this.translations.t("domains.ai.all_providers_failed"));
  }

  private async executeToolCall(
    ctx: AiToolContext,
    execution: AiExecutionScope,
    provider: AiProviderAbstract,
    toolCall: AiToolCall,
    round: number,
    _parentTimer?: PhaseTimer,
  ): Promise<AiChatMessage> {
    const t0 = performance.now();
    const tool = this.toolRegistry.getTool(toolCall.name);
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

    if (!tool.canRunFor(ctx)) {
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
    const dedupKey = tool.dedup?.key?.(args) ?? argsHash;
    timer.stop({ len: argsJson.length, usedCustomDedupKey: !!tool.dedup?.key });

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

  private finalize(
    ctx: AiToolContext,
    execution: AiExecutionScope,
    result: {
      content?: string;
      error?: string;
      errorCode?: string;
      errorDetails?: AiOrchestrationError;
    },
    pairs: Array<{ token: string; original: string }>,
    timer: PhaseTimer,
  ): {
    finalResult: AiOrchestrationResult;
    providersUsed: string[];
    modelsUsed: string[];
    rounds: number;
    progress: AiProgressEvent[];
  } {
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
    const rounds = execution.currentRound;
    const finalResult: AiOrchestrationResult = {
      sessionId: execution.session.sessionId,
      requestId: execution.requestId,
      conversationId: execution.session.conversationId,
      ok,
      content,
      usage,
      error: result.error,
      errorCode: result.errorCode,
      errorDetails: result.errorDetails,
    };
    timer.stop({
      eventsCount: progress.length,
      providersUsed: providersUsed.length,
      modelsUsed: modelsUsed.length,
    });

    timer.start("finalize.persistSummary");
    const persistDone = this.persistSummary(
      ctx,
      execution,
      result,
      usage,
      ok,
      progress,
      providersUsed,
      modelsUsed,
      rounds,
    );
    persistDone
      .then((ms) =>
        this.logger.debug("[perf] persistSummary", {
          requestId: ctx.requestId,
          ok: true,
          ms,
        }),
      )
      .catch((err) =>
        this.logger.error("[finalize] persistSummary failed", err),
      );
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
  ): Promise<number> {
    const t0 = performance.now();
    const adminId = ctx.session.tenantId ?? ctx.session.userId;

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
      summary: this.config.storeConversationSummaries
        ? {
          conversationId: execution.session.conversationId,
          lastError: result.error ?? null,
          lastToolNames: extractToolNames(progress),
          usage,
          rounds,
          providersUsed,
          modelsUsed,
        }
        : undefined,
      progress,
      providersUsed,
      modelsUsed,
    });
    return performance.now() - t0;
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
