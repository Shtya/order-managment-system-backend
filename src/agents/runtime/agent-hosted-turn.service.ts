import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, Repository } from "typeorm";
import { AgentAiSource, AgentEntity } from "entities/agent.entity";
import {
  AiHostedModelEntity,
  AiIntegrationEntity,
  AiIntegrationScope,
} from "entities/ai.entity";
import {
  BillingOperationKey,
  BillingServiceKey,
  BillingWalletPool,
} from "entities/billing.entity";
import {
  AiUsageActor,
  AiUsageBilledBy,
  AiUsageSource,
  AiUsageStatus,
} from "entities/ai-usage.entity";
import { TranslationService } from "common/translation.service";
import { BillingService } from "src/billing/billing.service";
import {
  AiAgentTurnInput,
  AiAgentTurnResult,
  AiChatOptions,
  AiOrchestratorService,
} from "src/ai/orchestrator/ai-orchestrator.service";
import { AiOrchestrationResult } from "src/ai/interfaces/ai-types";
import { AiUsageLedgerService } from "src/ai/usage/ai-usage-ledger.service";
import { estimateTokens } from "./agent-runtime.constants";

export class HostedInsufficientBalanceError extends Error {
  constructor(message = "HOSTED_INSUFFICIENT_BALANCE") {
    super(message);
    this.name = "HostedInsufficientBalanceError";
  }
}

export type HostedRuntimeSku = {
  id: string;
  name: string;
  providerId: string;
  modelCode: string;
  isRecommended: boolean;
  sortOrder: number;
};

@Injectable()
export class AgentHostedTurnService {
  constructor(
    @InjectRepository(AiHostedModelEntity)
    private readonly hostedRepo: Repository<AiHostedModelEntity>,
    private readonly billing: BillingService,
    private readonly orchestrator: AiOrchestratorService,
    private readonly usageLedger: AiUsageLedgerService,
    private readonly translations: TranslationService,
  ) { }

  isHosted(agent: AgentEntity): boolean {
    return (agent.aiSource ?? AgentAiSource.TENANT) === AgentAiSource.HOSTED;
  }

  async compactPin(agent: AgentEntity): Promise<{
    providerId?: string | null;
    model?: string | null;
  }> {
    if (!this.isHosted(agent)) {
      return { providerId: agent.responseProviderId ?? null, model: null };
    }
    const [first] = await this.resolveCandidates(agent);
    return {
      providerId: first?.providerId ?? null,
      model: first?.modelCode ?? null,
    };
  }

  async runAgentTurn(
    agent: AgentEntity,
    input: AiAgentTurnInput & { turnId?: string },
  ): Promise<AiAgentTurnResult> {
    if (!this.isHosted(agent)) {
      return this.orchestrator.runAgentTurn(input);
    }
    const candidates = await this.resolveCandidates(agent);
    if (!candidates.length) {
      throw new BadRequestException(
        this.translations.t("domains.agents.hosted_no_model_available"),
      );
    }

    const estimatedInput = Math.max(
      1,
      input.messages.reduce((n, m) => n + estimateTokens(m.content), 0),
    );
    const estimatedOutput = Math.max(64, Math.ceil(estimatedInput * 0.2));
    let lastError: unknown;

    for (const sku of candidates) {
      try {
        return await this.runOne(agent, input, sku, estimatedInput, estimatedOutput);
      } catch (err) {
        lastError = err;
        if (err instanceof HostedInsufficientBalanceError) throw err;
        if (agent.hostedModelId) throw err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new BadRequestException(
        this.translations.t("domains.agents.hosted_no_model_available"),
      );
  }

  private async runOne(
    agent: AgentEntity,
    input: AiAgentTurnInput & { turnId?: string },
    sku: HostedRuntimeSku,
    estimatedInput: number,
    estimatedOutput: number,
  ): Promise<AiAgentTurnResult> {
    const idempotencyKey = input.turnId
      ? `hosted-turn:${input.turnId}:${sku.id}`
      : `hosted-turn:${input.sessionId}:${sku.id}:${Date.now()}`;
    const feature =
      input.metadata?.source === "agent_playground"
        ? "agent-playground"
        : "whatsapp-agent";

    const auth = await this.authorizeHosted(
      input.tenantId,
      sku,
      idempotencyKey,
      estimatedInput,
      estimatedOutput,
      feature,
    );

    let result: AiAgentTurnResult;
    try {
      result = await this.orchestrator.runAgentTurn({
        ...input,
        providerId: sku.providerId,
        model: sku.modelCode,
        allowProviderFailover: false,
        useSystemIntegrations: true,
      });
    } catch (err) {
      await this.releaseAuth(auth.authorizationId);
      throw err;
    }

    const usage = {
      inputTokens: result.usage?.promptTokens ?? 0,
      outputTokens: result.usage?.completionTokens ?? 0,
    };
    if (!result.ok) {
      await this.releaseAuth(auth.authorizationId);
      throw new Error(result.error || result.errorCode || "HOSTED_TURN_FAILED");
    }

    const charge = await this.finalizeHosted(auth.authorizationId, usage);
    await this.usageLedger.record({
      adminId: input.tenantId,
      source:
        input.metadata?.source === "agent_playground"
          ? AiUsageSource.PLAYGROUND
          : AiUsageSource.WHATSAPP_AGENT,
      api: "agents.runAgentTurn",
      actor: AiUsageActor.CUSTOMER,
      billedBy: AiUsageBilledBy.MADAR,
      providerCode: result.providersUsed?.[result.providersUsed.length - 1] ?? null,
      modelCode: result.modelsUsed?.[result.modelsUsed.length - 1] ?? sku.modelCode,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      rounds: result.rounds ?? 1,
      status: AiUsageStatus.OK,
      grossAmount: charge?.grossAmount ?? 0n,
      payableAmount: charge?.payableAmount ?? 0n,
      freeUnits: charge?.allowanceUnitsConsumed ?? 0n,
      chargeId: charge?.id ?? null,
      idempotencyKey,
      turnId: input.turnId ?? null,
      sessionId: input.sessionId,
      agentId: agent.id,
      conversationId: input.conversationId,
      requestId: result.requestId ?? null,
      hostedModelId: sku.id,
    });

    return result;
  }

  async runCompletion(
    agent: AgentEntity,
    input: {
      tenantId: string;
      sessionId: string;
      conversationId?: string;
      userId: string;
      system: string;
      user: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<AiOrchestrationResult> {
    if (!this.isHosted(agent)) {
      return this.orchestrator.runCompletion(input);
    }
    const [sku] = await this.resolveCandidates(agent);
    if (!sku) {
      throw new BadRequestException(
        this.translations.t("domains.agents.hosted_no_model_available"),
      );
    }
    const estimatedInput = Math.max(
      1,
      estimateTokens(input.system) + estimateTokens(input.user),
    );
    const estimatedOutput = Math.max(64, Math.ceil(estimatedInput * 0.2));
    const idempotencyKey = `hosted-complete:${input.sessionId}:${sku.id}:${Date.now()}`;
    const feature = "";
    const auth = await this.authorizeHosted(
      input.tenantId,
      sku,
      idempotencyKey,
      estimatedInput,
      estimatedOutput,
      feature,
    );

    let result: AiOrchestrationResult;
    try {
      result = await this.orchestrator.runCompletion({
        ...input,
        providerId: sku.providerId,
        model: sku.modelCode,
        useSystemIntegrations: true,
      });
    } catch (err) {
      await this.releaseAuth(auth.authorizationId);
      throw err;
    }

    const usage = {
      inputTokens: result.usage?.promptTokens ?? 0,
      outputTokens: result.usage?.completionTokens ?? 0,
    };
    if (!result.ok) {
      await this.releaseAuth(auth.authorizationId);
      return result;
    }

    const charge = await this.finalizeHosted(auth.authorizationId, usage);
    await this.usageLedger.record({
      adminId: input.tenantId,
      source: AiUsageSource.COMPACTION,
      api: "agents.compact",
      actor: AiUsageActor.SYSTEM,
      billedBy: AiUsageBilledBy.MADAR,
      providerCode: result.providersUsed?.[result.providersUsed.length - 1] ?? null,
      modelCode: result.modelsUsed?.[result.modelsUsed.length - 1] ?? sku.modelCode,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      rounds: result.rounds ?? 1,
      status: AiUsageStatus.OK,
      grossAmount: charge?.grossAmount ?? 0n,
      payableAmount: charge?.payableAmount ?? 0n,
      freeUnits: charge?.allowanceUnitsConsumed ?? 0n,
      chargeId: charge?.id ?? null,
      idempotencyKey,
      sessionId: input.sessionId,
      agentId: agent.id,
      conversationId: input.conversationId ?? null,
      requestId: result.requestId ?? null,
      hostedModelId: sku.id,
    });
    return result;
  }

  async runHostedChat(
    admin: any,
    prompt: string,
    hostedModelId: string | null | undefined,
    options: AiChatOptions = {},
  ): Promise<AiOrchestrationResult> {
    const adminId = String(admin?.id ?? "");
    const sku = await this.pickSku(hostedModelId);
    if (!sku) {
      throw new BadRequestException(
        this.translations.t("domains.agents.hosted_no_model_available"),
      );
    }
    const estimatedInput = Math.max(1, estimateTokens(prompt));
    const estimatedOutput = Math.max(64, Math.ceil(estimatedInput * 0.2));
    const idempotencyKey = `hosted-chat:${adminId}:${sku.id}:${Date.now()}`;
    const auth = await this.authorizeHosted(
      adminId,
      sku,
      idempotencyKey,
      estimatedInput,
      estimatedOutput,
      "address-correction",
    );

    let result: AiOrchestrationResult;
    try {
      result = await this.orchestrator.chat(admin, prompt, {
        ...options,
        providerId: sku.providerId,
        model: sku.modelCode,
        allowProviderFailover: false,
        useSystemIntegrations: true,
        usageSource: undefined,
        usageApi: undefined,
        usageActor: undefined,
      });
    } catch (err) {
      await this.releaseAuth(auth.authorizationId);
      throw err;
    }

    const usage = {
      inputTokens: result.usage?.promptTokens ?? 0,
      outputTokens: result.usage?.completionTokens ?? 0,
    };
    if (!result.ok) {
      await this.releaseAuth(auth.authorizationId);
      return result;
    }

    const charge = await this.finalizeHosted(auth.authorizationId, usage);
    await this.usageLedger.record({
      adminId,
      source: AiUsageSource.ADDRESS_CORRECTION,
      api: options.usageApi ?? "automation.addressCorrection",
      actor: options.usageActor ?? AiUsageActor.SYSTEM,
      billedBy: AiUsageBilledBy.MADAR,
      providerCode: result.providersUsed?.[result.providersUsed.length - 1] ?? null,
      modelCode: result.modelsUsed?.[result.modelsUsed.length - 1] ?? sku.modelCode,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      rounds: result.rounds ?? 1,
      status: AiUsageStatus.OK,
      grossAmount: charge?.grossAmount ?? 0n,
      payableAmount: charge?.payableAmount ?? 0n,
      freeUnits: charge?.allowanceUnitsConsumed ?? 0n,
      chargeId: charge?.id ?? null,
      idempotencyKey,
      sessionId: result.sessionId ?? null,
      requestId: result.requestId ?? null,
      hostedModelId: sku.id,
      orderId:
        typeof options.metadata?.orderId === "string"
          ? options.metadata.orderId
          : null,
    });
    return result;
  }

  async pickSku(hostedModelId?: string | null): Promise<HostedRuntimeSku | null> {
    const [sku] = await this.resolveCandidates({
      hostedModelId: hostedModelId || null,
    } as AgentEntity);
    return sku ?? null;
  }

  private async authorizeHosted(
    adminId: string,
    sku: HostedRuntimeSku,
    idempotencyKey: string,
    estimatedInput: number,
    estimatedOutput: number,
    feature: string,
  ) {
    const auth = await this.billing.authorize({
      adminId,
      service: BillingServiceKey.AI_HOSTED,
      operation: BillingOperationKey.COMPLETE,
      idempotencyKey,
      estimatedUsage: {
        inputTokens: estimatedInput,
        outputTokens: estimatedOutput,
      },
      walletPool: BillingWalletPool.AI,
      context: {
        feature,
        hostedModelId: sku.id,
        modelName: sku.name,
        note: "domains.billing.ai_hosted_wallet_note",
      },
    });
    if (auth.authorized === false) {
      throw new HostedInsufficientBalanceError(
        this.translations.t("domains.agents.hosted_insufficient_balance"),
      );
    }
    return auth;
  }

  private async finalizeHosted(
    authorizationId: string,
    usage: { inputTokens: number; outputTokens: number },
  ) {
    try {
      return await this.billing.finalize({ authorizationId, usage });
    } catch {
      return null;
    }
  }

  private async releaseAuth(authorizationId: string) {
    await this.billing
      .release({ authorizationId, reason: "PROVIDER_ERROR" })
      .catch(() => undefined);
  }

  async resolveCandidates(agent: AgentEntity): Promise<HostedRuntimeSku[]> {
    const rows = await this.loadEligible();
    if (agent.hostedModelId) {
      const pinned = rows.find((r) => r.id === agent.hostedModelId);
      return pinned ? [pinned] : [];
    }
    return [...rows].sort(
      (a, b) =>
        Number(b.isRecommended) - Number(a.isRecommended) ||
        a.sortOrder - b.sortOrder ||
        a.id.localeCompare(b.id),
    );
  }

  private async loadEligible(): Promise<HostedRuntimeSku[]> {
    const rows = await this.hostedRepo.find({
      where: { isActive: true },
      relations: { model: { provider: true }, integration: true },
    });
    const eligible: HostedRuntimeSku[] = [];
    for (const row of rows) {
      const model = row.model;
      if (!model?.isActive || model.toolsCalling === false || !model.modelCode) continue;
      const providerId = model.providerId;
      if (!providerId) continue;
      const systemOk = row.integrationId
        ? !!(
          row.integration &&
          !row.integration.adminId &&
          row.integration.scope === AiIntegrationScope.SYSTEM
        )
        : await this.hasSystemIntegration(providerId);
      if (!systemOk) continue;
      eligible.push({
        id: row.id,
        name: row.name,
        providerId,
        modelCode: model.modelCode,
        isRecommended: row.isRecommended,
        sortOrder: row.sortOrder,
      });
    }
    return eligible;
  }

  private async hasSystemIntegration(providerId: string): Promise<boolean> {
    const n = await this.hostedRepo.manager.getRepository(AiIntegrationEntity).count({
      where: {
        providerId,
        scope: AiIntegrationScope.SYSTEM,
        adminId: IsNull(),
      },
    });
    return n > 0;
  }
}
