import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { MoreThan, MoreThanOrEqual, Not, Repository } from "typeorm";
import { AgentEntity } from "entities/agent.entity";
import {
  AgentPendingActionEntity,
  AgentSessionEntity,
  AgentTurnMessageEntity,
} from "entities/agent-conversation.entity";
import {
  MessageSendSource,
  MessageStatus,
  WhatsappMessageEntity,
  WhatsappMessageType,
} from "entities/whatsapp.entity";
import { AiChatMessage } from "src/ai/interfaces/ai-types";
import { buildAgentSystemPrompt } from "./agent-prompt";
import { AgentInsight, describeMessage } from "./agent-input.service";
import { AgentSessionService } from "./agent-session.service";
import { AgentsService } from "../agents.service";
import {
  AGENT_CAPABILITY_LABELS,
  AGENT_GAP_MESSAGES,
  AGENT_USER_CAPABILITIES,
  resolveAgentCapabilities,
} from "./agent-runtime.constants";
import { AgentTaskService } from "./agent-task.service";
import { estimateTokens } from "./agent-runtime.constants";

export type AgentTurnContext = {
  messages: AiChatMessage[];
  /** The part of this turn's user message that is stored in history (without volatile context). */
  storedInput: string;
  historyTokens: number;
  lastSeenAt: Date | null;
};

@Injectable()
export class AgentContextService {
  constructor(
    private readonly sessions: AgentSessionService,
    private readonly agents: AgentsService,
    private readonly tasks: AgentTaskService,
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,
  ) {}

  async build(input: {
    agent: AgentEntity;
    session: AgentSessionEntity;
    customerId: string;
    insights: AgentInsight[];
    events: string[];
    pendingActions: AgentPendingActionEntity[];
  }): Promise<AgentTurnContext> {
    const { agent, session } = input;
    const excludeIds = new Set(input.insights.map((i) => i.messageId).filter(Boolean));
    const [memory, knowledge, recent, notDelivered, rawTail, openTask, gap] = await Promise.all([
      this.sessions.getMemoryFacts(session.adminId, input.customerId),
      this.agents.getPromptKnowledge(session.adminId, agent.id),
      this.sessions.getRecentTurnMessages(session),
      this.findNotDelivered(session),
      session.previousSessionId && !session.previousSummary && session.turnCount <= 1
        ? this.sessions.getPreviousRawTail(session)
        : Promise.resolve([] as string[]),
      this.tasks.getOpenForConversation(session.adminId, session.conversationId),
      this.loadGap(session, excludeIds),
    ]);

    const systemParts = [buildAgentSystemPrompt(agent)];
    const enabledCapabilities = new Set(resolveAgentCapabilities(agent.capabilities));
    const disabledCapabilities = AGENT_USER_CAPABILITIES.filter((c) => !enabledCapabilities.has(c));
    if (disabledCapabilities.length) {
      systemParts.push(
        `## Unavailable capabilities (never attempt these; say the store team will help instead)
${disabledCapabilities.map((c) => `- ${AGENT_CAPABILITY_LABELS[c]}`).join("\n")}`,
      );
    }
    if (session.bootstrap) systemParts.push(session.bootstrap);
    if (openTask) {
      const p = openTask.payload || {};
      const snap = p.snapshot || {};
      const issues = Array.isArray(p.issues)
        ? p.issues.map((i: any) => `- ${i.type}: ${i.description}`).join("\n")
        : "- none";
      const candidates = Array.isArray(p.addresses) && p.addresses.length
        ? p.addresses.map((a: any) => `- ${a.label || "address"}: ${a.fullAddress || ""}`).join("\n")
        : "- none";
      systemParts.push(
        `## Open task: shipping address for order ${p.orderNumber || openTask.orderId}
The store paused automation until you collect a complete, supported address with a landmark. Shipping company: ${p.shippingCompany || p.provider || "unknown"}.
Current address on the order: city=${snap.city || "—"}, area=${snap.area || "—"}, address=${snap.address || "—"}, landmark=${snap.landmark || "—"}.
Issues:
${issues}
Candidate addresses:
${candidates}
Call request_address_update only after the shipping company covers this city, zone, and district with dropOff true. If not, tell the customer delivery is not available there. If they refuse or delivery is not possible, call close_address_task.`,
      );
    }
    if (knowledge.length) {
      systemParts.push(
        `## Store knowledge (follow it unless it conflicts with the security rules)
If an entry states a shipping-fee or discount rule that applies to this order, paste that exact number on request_order (shippingCost / discount).
${knowledge.map((k) => `- ${k.title}: ${k.content}`).join("\n")}`,
      );
    }
    if (memory.length) {
      systemParts.push(
        `## Memory facts about this customer (history, not current status)
${memory.map((f) => `- ${f.fact}`).join("\n")}`,
      );
    }
    if (session.previousSummary) {
      systemParts.push(`## Summary of the previous conversation session\n${session.previousSummary}`);
    } else if (rawTail.length) {
      systemParts.push(
        `## Last messages of the previous conversation session (raw)\n${rawTail.map((l) => `- ${l}`).join("\n")}`,
      );
    }
    if (session.summary) {
      systemParts.push(`## Summary of earlier turns in this session\n${session.summary}`);
    }
    if (gap.lines.length) {
      systemParts.push(
        `## Messages since you last replied (Staff lines are employees, not you. Keep promises they made.)
${gap.lines.join("\n")}`,
      );
    }

    const history = toChatHistory(recent);
    const storedInput = renderInput(input.insights, input.events);
    const volatile = renderVolatileContext(input.pendingActions, notDelivered);

    const messages: AiChatMessage[] = [
      { role: "system", content: systemParts.join("\n\n") },
      ...history,
      { role: "user", content: volatile ? `${volatile}\n\n${storedInput}` : storedInput },
    ];

    const historyTokens =
      estimateTokens(session.summary) +
      history.reduce(
        (sum, m) => sum + estimateTokens(m.content) + estimateTokens(JSON.stringify(m.toolCalls ?? "")),
        0,
      );
    return { messages, storedInput, historyTokens, lastSeenAt: gap.lastSeenAt };
  }

  async loadGap(
    session: AgentSessionEntity,
    excludeIds: Set<string>,
  ): Promise<{ lines: string[]; lastSeenAt: Date | null }> {
    const since = session.agentSeenUntil ?? session.startedAt ?? new Date();
    const rows = await this.messageRepo.find({
      where: {
        adminId: session.adminId,
        conversationId: session.conversationId,
        createdAt: MoreThan(since),
        messageType: Not(WhatsappMessageType.REACTION),
      },
      relations: { sentByUser: true },
      order: { createdAt: "DESC" },
      take: AGENT_GAP_MESSAGES,
    });
    rows.reverse();
    const lastSeenAt = rows.length ? rows[rows.length - 1].createdAt : null;
    const lines = rows
      .filter((m) => !excludeIds.has(m.id))
      .map((m) => `- ${describeMessage(m)}`);
    return { lines, lastSeenAt };
  }

  private async findNotDelivered(session: AgentSessionEntity) {
    return this.messageRepo.find({
      where: {
        adminId: session.adminId,
        conversationId: session.conversationId,
        sendSource: MessageSendSource.AGENT,
        status: MessageStatus.FAILED,
        createdAt: MoreThanOrEqual(session.startedAt),
      },
      order: { createdAt: "DESC" },
      take: 5,
    });
  }
}

function renderInput(insights: AgentInsight[], events: string[]): string {
  const lines = insights
    .filter((i) => i.kind !== "ignored" && i.kind !== "unsupported")
    .map((i) => {
      const quoted = i.quoted ? `[Replying to] ${i.quoted}\n` : "";
      return `(msg ${i.messageId}) ${quoted}${i.text}`;
    });
  const parts: string[] = [];
  if (lines.length) {
    parts.push(
      `<customer_message>\n${lines.join("\n")}\n</customer_message>`,
    );
  }
  if (events.length) {
    parts.push(`[System events for this turn]\n${events.map((e) => `- ${e}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

function renderVolatileContext(
  pending: AgentPendingActionEntity[],
  notDelivered: WhatsappMessageEntity[],
): string {
  const parts: string[] = [];
  if (pending.length) {
    parts.push(
      `[Open pending actions waiting for the customer's confirmation]\n${pending
        .map(
          (a) =>
            `- actionId ${a.id} (${a.type}, created ${a.createdAt.toISOString().slice(0, 16)}, expires ${a.expiresAt
              .toISOString()
              .slice(0, 10)}):\n${a.summary}`,
        )
        .join("\n")}`,
    );
  }
  if (notDelivered.length) {
    parts.push(
      `[Your messages that were NOT delivered to the customer]\n${notDelivered
        .map((m) => `- ${describeMessage(m)}${m.error ? ` (error: ${m.error})` : ""}`)
        .join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

/** Rebuilds the stored turns, dropping any tool call without its result (and vice versa). */
function toChatHistory(rows: AgentTurnMessageEntity[]): AiChatMessage[] {
  const resultIds = new Set(rows.filter((r) => r.role === "tool").map((r) => r.toolCallId));
  const callIds = new Set<string>();
  const out: AiChatMessage[] = [];
  for (const row of rows) {
    if (row.role === "user") {
      out.push({ role: "user", content: row.content ?? "" });
    } else if (row.role === "assistant") {
      const calls = (row.toolCalls ?? []).filter((c) => resultIds.has(c.id));
      calls.forEach((c) => callIds.add(c.id));
      if (!calls.length && !row.content?.trim()) continue;
      out.push({
        role: "assistant",
        content: row.content ?? null,
        ...(calls.length ? { toolCalls: calls } : {}),
      });
    } else if (row.role === "tool" && row.toolCallId && callIds.has(row.toolCallId)) {
      out.push({ role: "tool", toolCallId: row.toolCallId, content: row.content ?? "" });
    }
  }
  return out;
}
