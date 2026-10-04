import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import {
  ConversationEntity,
  MessageStatus,
  WhatsappMessageEntity,
} from "entities/whatsapp.entity";
import { AgentEntity } from "entities/agent.entity";
import {
  AgentSessionEntity,
  AgentTaskType,
  AgentTurnEntity,
  AgentTurnMessageEntity,
  AgentTurnStatus,
} from "entities/agent-conversation.entity";
import { RedisService } from "common/redis/RedisService";
import { AiOrchestratorService } from "src/ai/orchestrator/ai-orchestrator.service";
import { AiChatMessage, AiOrchestrationResult } from "src/ai/interfaces/ai-types";
import { WhatsappAiService } from "src/whatsapp/services/whatsapp-ai.service";
import { AgentInputService, AgentInsight } from "./runtime/agent-input.service";
import { AgentSessionService } from "./runtime/agent-session.service";
import { AgentContextService } from "./runtime/agent-context.service";
import { AgentPendingActionsService } from "./runtime/agent-pending-actions.service";
import { AgentTaskService } from "./runtime/agent-task.service";
import { AgentCustomerWindowClosedError, AgentSendBlockedError, AgentSenderService } from "./runtime/agent-sender.service";
import { AgentMediaUsageService } from "src/ai/media/agent-media-usage.service";
import { AiUsageLedgerService } from "src/ai/usage/ai-usage-ledger.service";
import {
  AiUsageActor,
  AiUsageBilledBy,
  AiUsageSource,
  AiUsageStatus,
} from "entities/ai-usage.entity";
import {
  AGENT_CANCEL_BUTTON_PREFIX,
  AGENT_COMPACTION_RATIO,
  AGENT_CONFIRM_BUTTON_PREFIX,
  AGENT_CONTEXT_TOKEN_BUDGET,
  AGENT_DESCRIBE_MESSAGE_RELATIONS,
  AGENT_EDIT_BUTTON_PREFIX,
  AGENT_SEND_TOOL_NAMES,
  AGENT_UNSUPPORTED_REPLY_COOLDOWN_SECONDS,
  AgentToolScope,
  resolveAgentToolNames,
  unsupportedMessageFor,
  isAgentSilenced,
} from "./runtime/agent-runtime.constants";

export type AgentTurnInput = {
  adminId: string;
  accountId: string | null;
  conversationId: string;
  messageIds: string[];
  catchUp?: boolean;
  taskId?: string;
};

/** Tools whose successful result means the customer received something. */
const DELIVERING_TOOLS = new Set([...AGENT_SEND_TOOL_NAMES, "request_campaign_order"]);
const CONTEXT_OVERFLOW = /context.{0,20}(length|window|too long|exceed)|maximum context|too many tokens|prompt is too long/i;

@Injectable()
export class AgentRuntimeService {
  private readonly logger = new Logger(AgentRuntimeService.name);

  constructor(
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(AgentEntity)
    private readonly agentRepo: Repository<AgentEntity>,
    @InjectRepository(AgentTurnEntity)
    private readonly turnRepo: Repository<AgentTurnEntity>,
    @InjectRepository(AgentTurnMessageEntity)
    private readonly turnMessageRepo: Repository<AgentTurnMessageEntity>,
    @Inject(forwardRef(() => WhatsappAiService))
    private readonly whatsappAiService: WhatsappAiService,
    @Inject(forwardRef(() => AiOrchestratorService))
    private readonly orchestrator: AiOrchestratorService,
    private readonly redisService: RedisService,
    private readonly input: AgentInputService,
    private readonly sessions: AgentSessionService,
    private readonly contextBuilder: AgentContextService,
    private readonly actions: AgentPendingActionsService,
    private readonly tasks: AgentTaskService,
    private readonly sender: AgentSenderService,
    private readonly mediaUsage: AgentMediaUsageService,
    private readonly usageLedger: AiUsageLedgerService,
  ) {}

  async runTurn(job: AgentTurnInput): Promise<void> {
    const startedAt = Date.now();
    const conversation = await this.conversationRepo.findOne({
      where: { id: job.conversationId, adminId: job.adminId },
      relations: { customer: true },
    });
    if (!conversation?.customer) return;
    if (isAgentSilenced(conversation)) {
      this.logger.debug(`Agent silenced for conversation ${conversation.id}; skipping turn`);
      return;
    }

    const messages = job.messageIds.length
      ? (
          await this.messageRepo.find({
            where: { id: In(job.messageIds), adminId: job.adminId, conversationId: job.conversationId },
            relations: AGENT_DESCRIBE_MESSAGE_RELATIONS,
            order: { createdAt: "ASC" },
          })
        ).filter((m) => m.status !== MessageStatus.DELETED)
      : [];
    if (!messages.length && !job.taskId) return;

    const openTask = await this.tasks.getOpenForConversation(job.adminId, conversation.id);
    const accountId = messages.length
      ? messages[messages.length - 1].accountId ?? job.accountId
      : job.accountId;
    const aiContext = await this.whatsappAiService.loadContext(job.adminId, accountId);
    const ai = this.whatsappAiService.resolve(aiContext, conversation.aiMode);
    const agentId = openTask?.agentId || ai.agentId;
    if (!openTask && (!ai.enabled || !agentId)) return;
    if (!agentId) return;
    const agent = await this.agentRepo.findOne({ where: { id: agentId, adminId: job.adminId } });
    if (!agent?.isActive) return;

    const insights = await this.input.understand(job.adminId, messages, { agent });
    const meaningful = insights.filter(
      (i) => i.kind !== "ignored" && i.kind !== "unsupported" && !isStrayReaction(i),
    );
    const unsupportedIds = new Set(
      insights.filter((i) => i.kind === "unsupported").map((i) => i.messageId),
    );
    const lastUnsupported = [...messages].reverse().find((m) => unsupportedIds.has(m.id));
    const hasUnsupported = !!lastUnsupported;
    if (!meaningful.length && !hasUnsupported && !job.taskId && !openTask) return;

    const phoneNumber = conversation.customer.phoneNumber;
    const session = await this.sessions.resolve({
      adminId: job.adminId,
      conversationId: conversation.id,
      customerId: conversation.customerId,
      phoneNumber,
      agentId: agent.id,
      providerId: agent.responseProviderId,
    });
    const seq = await this.sessions.nextTurnSeq(session);
    const turn = await this.turnRepo.save(
      this.turnRepo.create({
        adminId: job.adminId,
        sessionId: session.id,
        conversationId: conversation.id,
        seq,
        agentId: agent.id,
        accountId,
        messageIds: messages.map((m) => m.id),
        status: AgentTurnStatus.RUNNING,
      }),
    );
    await this.mediaUsage.attachTurnId(turn.id, messages.map((m) => m.id));
    const scope: AgentToolScope = {
      adminId: job.adminId,
      agentId: agent.id,
      sessionId: session.id,
      turnId: turn.id,
      conversationId: conversation.id,
      customerId: conversation.customerId,
      phoneNumber,
      accountId,
      taskId: openTask?.id,
    };

    try {
      const events: string[] = [];
      if (job.taskId || openTask) {
        const orderNumber = openTask?.payload?.orderNumber || "";
        events.push(
          `The store asked you to fix the shipping address of order ${orderNumber || "this order"}. Start or continue that conversation. Explain the problem simply, ask one question at a time, and do not invent any part of the address.`,
        );
      }
      if (job.catchUp) {
        events.push(
          "Staff was handling this chat and went silent. Only reply if the customer asked for something still unanswered. If they only acknowledged (ok, تمام, thanks), call end_turn without sending.",
        );
      }
      if (hasUnsupported) {
        const told = await this.sendUnsupportedNotice(scope, agent, lastUnsupported.messageId);
        events.push(
          told
            ? "The customer also sent an unsupported item (image/video/file). They were already told it can't be read; don't repeat that."
            : "The customer also sent an unsupported item (image/video/file); they were told recently that it can't be read.",
        );
      }
      if (!meaningful.length && !job.taskId && !openTask) {
        await this.finishTurn(turn, startedAt, {
          status: AgentTurnStatus.SILENT,
          endedBy: "unsupported_only",
          session,
          lastSeenAt: latestCreatedAt(messages),
        });
        return;
      }

      const goalReached = await this.handleButtonDecisions(scope, meaningful, events);

      const result = await this.runModel(agent, session, scope, meaningful, events);
      const { ai: aiResult, storedInput, lastSeenAt } = result;
      await this.storeTurnMessages(turn, storedInput, aiResult.newMessages);

      const delivered = countDelivered(aiResult.newMessages);
      const confirmedByTool = aiResult.newMessages.some(
        (m) => m.role === "tool" && /"code":"EXECUTED"/.test(m.content ?? ""),
      );
      const status = aiResult.result.ok
        ? delivered
          ? AgentTurnStatus.OK
          : AgentTurnStatus.SILENT
        : AgentTurnStatus.FAILED;
      await this.finishTurn(turn, startedAt, {
        status,
        endedBy: aiResult.result.endedBy ?? null,
        result: aiResult.result,
        session,
        lastSeenAt: laterDate(lastSeenAt, latestCreatedAt(messages)),
      });

      if (goalReached || confirmedByTool) {
        await this.sessions.refreshBootstrap(session, phoneNumber);
        await this.safeCompact(session, 0, agent.responseProviderId);
      }
    } catch (error) {
      await this.finishTurn(turn, startedAt, {
        status: AgentTurnStatus.FAILED,
        error: (error as Error)?.message ?? String(error),
      });
      if (error instanceof AgentCustomerWindowClosedError && openTask) {
        await this.tasks.close(openTask.id, "customer_session_window_closed");
        return;
      }
      throw error;
    }
  }

  /**
   * Confirm/Cancel buttons on a pending-action summary are decided by the server before the
   * model runs; the model is told the outcome and only has to answer.
   */
  private async handleButtonDecisions(
    scope: AgentToolScope,
    insights: AgentInsight[],
    events: string[],
  ): Promise<boolean> {
    let goalReached = false;
    for (const insight of insights) {
      const id = insight.kind === "choice" ? insight.choiceId ?? "" : "";
      if (id.startsWith(AGENT_CONFIRM_BUTTON_PREFIX)) {
        const actionId = id.slice(AGENT_CONFIRM_BUTTON_PREFIX.length);
        const outcome = await this.actions.confirm(scope, actionId);
        if (outcome.ok) {
          goalReached = true;
          events.push(
            outcome.result?.kind === "address_correction"
              ? `The customer pressed Confirm on action ${actionId}; the corrected address was sent to the store. Tell them the store will continue preparing the order.`
              : `The customer pressed Confirm on action ${actionId}; it was executed: ${JSON.stringify(outcome.result)}. Send a separate message saying it's done (with the order number).`,
          );
        } else {
          events.push(
            `The customer pressed Confirm on action ${actionId}, but it could not be executed (${outcome.code}: ${outcome.error}). Explain simply and help them continue.`,
          );
        }
      } else if (id.startsWith(AGENT_CANCEL_BUTTON_PREFIX)) {
        const actionId = id.slice(AGENT_CANCEL_BUTTON_PREFIX.length);
        const outcome = await this.actions.cancel(scope, actionId);
        events.push(
          outcome.ok
            ? `The customer pressed Cancel on action ${actionId}; it was cancelled. Acknowledge briefly.`
            : `The customer pressed Cancel on action ${actionId}, but it is already closed (${outcome.code}).`,
        );
      } else if (id.startsWith(AGENT_EDIT_BUTTON_PREFIX)) {
        const actionId = id.slice(AGENT_EDIT_BUTTON_PREFIX.length);
        events.push(
          `The customer pressed Edit on action ${actionId}. Ask what they want to change, then call the request tool again with the new data.`,
        );
      }
    }
    return goalReached;
  }

  private async runModel(
    agent: AgentEntity,
    session: AgentSessionEntity,
    scope: AgentToolScope,
    insights: AgentInsight[],
    events: string[],
  ) {
    const pendingActions = await this.actions.listOpen(scope.adminId, scope.customerId);
    const buildContext = () =>
      this.contextBuilder.build({
        agent,
        session,
        customerId: scope.customerId,
        insights,
        events,
        pendingActions,
      });

    let context = await buildContext();
    if (context.historyTokens > AGENT_CONTEXT_TOKEN_BUDGET * AGENT_COMPACTION_RATIO) {
      if (await this.safeCompact(session, undefined, agent.responseProviderId)) {
        context = await buildContext();
      }
    }

    let ai = await this.callModel(agent, session, scope, context.messages);
    if (!ai.result.ok && CONTEXT_OVERFLOW.test(`${ai.result.error ?? ""} ${ai.result.errorDetails?.message ?? ""}`)) {
      // Emergency compaction and one retry; already-sent messages are deduplicated by (turn, position).
      await this.safeCompact(session, 0, agent.responseProviderId);
      context = await buildContext();
      const retry = await this.callModel(agent, session, scope, context.messages);
      ai = { result: retry.result, newMessages: [...ai.newMessages, ...retry.newMessages] };
    }
    return { ai, storedInput: context.storedInput, lastSeenAt: context.lastSeenAt };
  }

  /**
   * Tools offered this turn: always-on messaging plus the agent's enabled
   * capabilities. Address-correction tools are added automatically — never
   * user-controlled — only while an open address task exists.
   */
  private async resolveTurnToolNames(
    scope: AgentToolScope,
    agent: AgentEntity,
  ): Promise<string[]> {
    const openTask = await this.tasks
      .getOpenForConversation(scope.adminId, scope.conversationId)
      .catch(() => null);

    const isAddressTaskOpen = openTask?.type === AgentTaskType.ADDRESS_CORRECTION;
    return resolveAgentToolNames(agent.capabilities, isAddressTaskOpen);
  }

  private async callModel(
    agent: AgentEntity,
    session: AgentSessionEntity,
    scope: AgentToolScope,
    messages: AiChatMessage[],
  ): Promise<{ result: AiOrchestrationResult; newMessages: AiChatMessage[] }> {
    let position = 0;
    const result = await this.orchestrator.runAgentTurn({
      tenantId: scope.adminId,
      sessionId: session.id,
      conversationId: scope.conversationId,
      agentId: agent.id,
      agentName: agent.name,
      providerId: agent.responseProviderId ?? null,
      messages,
      toolNames: await this.resolveTurnToolNames(scope, agent),
      sendToolNames: AGENT_SEND_TOOL_NAMES,
      writeDedupScope: (toolCall) => {
        if (toolCall.name === "confirm_pending_action" || toolCall.name === "cancel_pending_action") {
          return `agent:${scope.turnId}:${toolCall.name}:${String(toolCall.arguments?.actionId ?? "")}`;
        }
        return `agent:${scope.turnId}:${position++}`;
      },
      metadata: { agentScope: scope, source: "whatsapp_agent" },
    });
    return {
      result,
      newMessages: result.messages
        .slice(messages.length)
        .filter((m) => m.role === "assistant" || m.role === "tool"),
    };
  }

  private async storeTurnMessages(
    turn: AgentTurnEntity,
    storedInput: string,
    newMessages: AiChatMessage[],
  ) {
    const rows = [
      { role: "user" as const, content: storedInput },
      ...newMessages.map((m) => ({
        role: m.role as "assistant" | "tool",
        content: m.content,
        toolCalls: m.toolCalls ?? null,
        toolCallId: m.toolCallId ?? null,
      })),
    ];
    await this.turnMessageRepo.save(
      rows.map((row, position) =>
        this.turnMessageRepo.create({
          turnId: turn.id,
          sessionId: turn.sessionId,
          seq: turn.seq,
          position,
          ...row,
        }),
      ),
    );
  }

  /**
   * The fixed unsupported-type message, quoting the (latest) unsupported item, at most once per
   * batch and once per cooldown window.
   */
  private async sendUnsupportedNotice(
    scope: AgentToolScope,
    agent: AgentEntity,
    replyToWamid: string | null,
  ): Promise<boolean> {
    const key = `agent-unsupported-notice:${scope.conversationId}`;
    const first = await this.redisService.setNxWithTtl(key, "1", AGENT_UNSUPPORTED_REPLY_COOLDOWN_SECONDS);
    if (!first) return false;
    try {
      await this.sender.send(scope, {
        type: "text",
        text: { body: unsupportedMessageFor(agent.language) },
        ...(replyToWamid ? { context: { message_id: replyToWamid } } : {}),
      });
      return true;
    } catch (error) {
      await this.redisService.del(key);
      if (!(error instanceof AgentSendBlockedError)) {
        this.logger.warn(`Unsupported notice failed for ${scope.conversationId}: ${(error as Error)?.message}`);
      }
      return false;
    }
  }

  private async safeCompact(
    session: AgentSessionEntity,
    keepTurns: number | undefined,
    providerId?: string | null,
  ): Promise<boolean> {
    try {
      return await this.sessions.compact(session, { keepTurns, providerId });
    } catch (error) {
      this.logger.warn(`Compaction failed for session ${session.id}: ${(error as Error)?.message}`);
      return false;
    }
  }

  private async finishTurn(
    turn: AgentTurnEntity,
    startedAt: number,
    outcome: {
      status: AgentTurnStatus;
      endedBy?: string | null;
      error?: string | null;
      result?: AiOrchestrationResult;
      session?: AgentSessionEntity;
      lastSeenAt?: Date | null;
    },
  ) {
    const result = outcome.result;
    await this.turnRepo.update(turn.id, {
      status: outcome.status,
      endedBy: outcome.endedBy ?? null,
      provider: result?.providersUsed?.[result.providersUsed.length - 1] ?? null,
      model: result?.modelsUsed?.[result.modelsUsed.length - 1] ?? null,
      promptTokens: result?.usage?.promptTokens ?? 0,
      completionTokens: result?.usage?.completionTokens ?? 0,
      totalTokens: result?.usage?.totalTokens ?? 0,
      durationMs: Date.now() - startedAt,
      error: outcome.error ?? (result && !result.ok ? `${result.errorCode ?? ""} ${result.error ?? ""}`.trim() : null),
      finishedAt: new Date(),
    });
    if (
      outcome.session &&
      (outcome.status === AgentTurnStatus.OK || outcome.status === AgentTurnStatus.SILENT)
    ) {
      await this.sessions.markSeenUntil(outcome.session, outcome.lastSeenAt);
    }
    const tokens = (result?.usage?.promptTokens ?? 0) + (result?.usage?.completionTokens ?? 0);
    if (tokens > 0 || outcome.status === AgentTurnStatus.FAILED) {
      await this.usageLedger.record({
        adminId: turn.adminId,
        source: AiUsageSource.WHATSAPP_AGENT,
        api: "agents.runAgentTurn",
        actor: AiUsageActor.CUSTOMER,
        billedBy: AiUsageBilledBy.MERCHANT,
        providerCode: result?.providersUsed?.[result.providersUsed.length - 1] ?? turn.provider ?? null,
        modelCode: result?.modelsUsed?.[result.modelsUsed.length - 1] ?? turn.model ?? null,
        inputTokens: result?.usage?.promptTokens ?? 0,
        outputTokens: result?.usage?.completionTokens ?? 0,
        rounds: result?.rounds ?? 1,
        status:
          outcome.status === AgentTurnStatus.FAILED
            ? AiUsageStatus.FAILED
            : AiUsageStatus.OK,
        turnId: turn.id,
        sessionId: turn.sessionId,
        agentId: turn.agentId ?? null,
        conversationId: turn.conversationId,
        requestId: result?.requestId ?? null,
      });
    }
  }
}

/** Reactions only matter on the agent's confirmation summaries (§14); others get no reply. */
function isStrayReaction(insight: AgentInsight) {
  return insight.kind === "reaction" && !insight.parentMetadata?.agentPendingActionId;
}

function laterDate(a?: Date | null, b?: Date | null): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function latestCreatedAt(messages: WhatsappMessageEntity[]): Date | null {
  let latest: Date | null = null;
  for (const message of messages) {
    if (!message.createdAt) continue;
    if (!latest || new Date(message.createdAt).getTime() > new Date(latest).getTime()) {
      latest = message.createdAt;
    }
  }
  return latest;
}

function countDelivered(messages: AiChatMessage[]): number {
  const names = new Map<string, string>();
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) names.set(call.id, call.name);
  }
  return messages.filter((m) => {
    if (m.role !== "tool" || !m.toolCallId) return false;
    if (!DELIVERING_TOOLS.has(names.get(m.toolCallId) ?? "")) return false;
    try {
      return JSON.parse(m.content ?? "{}")?.ok === true;
    } catch {
      return false;
    }
  }).length;
}
