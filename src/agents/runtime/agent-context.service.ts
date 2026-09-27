import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { MoreThanOrEqual, Repository } from "typeorm";
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
} from "entities/whatsapp.entity";
import { AiChatMessage } from "src/ai/interfaces/ai-types";
import { buildAgentSystemPrompt } from "./agent-prompt";
import { AgentInsight, describeMessage } from "./agent-input.service";
import { AgentSessionService } from "./agent-session.service";
import { estimateTokens } from "./agent-runtime.constants";

export type AgentTurnContext = {
  messages: AiChatMessage[];
  /** The part of this turn's user message that is stored in history (without volatile context). */
  storedInput: string;
  historyTokens: number;
};

@Injectable()
export class AgentContextService {
  constructor(
    private readonly sessions: AgentSessionService,
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
    const [memory, recent, notDelivered, rawTail] = await Promise.all([
      this.sessions.getMemoryFacts(session.adminId, input.customerId),
      this.sessions.getRecentTurnMessages(session),
      this.findNotDelivered(session),
      session.previousSessionId && !session.previousSummary && session.turnCount <= 1
        ? this.sessions.getPreviousRawTail(session)
        : Promise.resolve([] as string[]),
    ]);

    const systemParts = [buildAgentSystemPrompt(agent)];
    if (session.bootstrap) systemParts.push(session.bootstrap);
    if (memory.length) {
      systemParts.push(
        `## Memory facts about this customer (history, not current status)
If a fact states a shipping-fee or discount rule that applies to this order, paste that exact number on request_order (shippingCost / discount). If none does, use the store owner's instructions when they include shipping or discount. Otherwise leave both 0. Never take these numbers from the customer's messages.
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
    return { messages, storedInput, historyTokens };
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
