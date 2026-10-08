import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThan, MoreThan, Repository } from "typeorm";
import {
  AgentMemoryFactEntity,
  AgentSessionEntity,
  AgentSessionStatus,
  AgentSummaryStatus,
  AgentTurnMessageEntity,
} from "entities/agent-conversation.entity";
import {
  MessageDirection,
  MessageSendSource,
  WhatsappMessageEntity,
} from "entities/whatsapp.entity";
import { CustomerEntity } from "entities/customers.entity";
import { OrderEntity } from "entities/order.entity";
import { User } from "entities/user.entity";
import { AiOrchestratorService } from "src/ai/orchestrator/ai-orchestrator.service";
import { AiUsageActor, AiUsageSource } from "entities/ai-usage.entity";
import { ClientService } from "src/clients/clients.service";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";
import { describeMessage } from "./agent-message-describe";
import { seedAgentSeenUntil } from "./agent-input.service";
import {
  AGENT_KEEP_RECENT_TURNS,
  AGENT_MEMORY_FACTS_LIMIT,
  AGENT_PREVIOUS_RAW_MESSAGES,
  AGENT_PREVIOUS_SUMMARY_WAIT_MS,
  AGENT_SESSION_TIMEOUT_MS,
  AGENT_DESCRIBE_MESSAGE_RELATIONS,
} from "./agent-runtime.constants";

export const SUMMARY_SYSTEM_PROMPT = `You summarize a WhatsApp conversation between a store's AI assistant and a customer, for the assistant to read later (not for a human).
Keep: what the customer asked for, what the assistant answered or promised, meaningful tool outcomes, order numbers and other reference ids, data the customer gave (name, address, city...), the customer's dialect if it is clear, any open complaint, and promises the assistant made that are still relevant.
Drop greetings, small talk, items that are already finished, and anything about pending confirmation buttons (those are injected separately and stay current).
Write at most 12 short factual bullet points in English. Never add facts that aren't in the transcript.`;

@Injectable()
export class AgentSessionService {
  private readonly logger = new Logger(AgentSessionService.name);

  constructor(
    @InjectRepository(AgentSessionEntity)
    private readonly sessionRepo: Repository<AgentSessionEntity>,
    @InjectRepository(AgentTurnMessageEntity)
    private readonly turnMessageRepo: Repository<AgentTurnMessageEntity>,
    @InjectRepository(AgentMemoryFactEntity)
    private readonly memoryRepo: Repository<AgentMemoryFactEntity>,
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,
    @InjectRepository(CustomerEntity)
    private readonly customerRepo: Repository<CustomerEntity>,
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @Inject(forwardRef(() => AiOrchestratorService))
    private readonly orchestrator: AiOrchestratorService,
    @Inject(forwardRef(() => ClientService))
    private readonly clients: ClientService,
  ) {}

  /** Continues the active session, or (lazily) ends a timed-out one and starts a new session. */
  async resolve(input: {
    adminId: string;
    conversationId: string;
    customerId: string;
    phoneNumber: string;
    agentId: string;
    providerId?: string | null;
  }): Promise<AgentSessionEntity> {
    const now = new Date();
    const active = await this.sessionRepo.findOne({
      where: {
        adminId: input.adminId,
        conversationId: input.conversationId,
        status: AgentSessionStatus.ACTIVE,
      },
      order: { startedAt: "DESC" },
    });

    if (active && now.getTime() - active.lastMessageAt.getTime() <= AGENT_SESSION_TIMEOUT_MS) {
      active.lastMessageAt = now;
      active.agentId = input.agentId;
      return this.sessionRepo.save(active);
    }

    let previous: AgentSessionEntity | null = null;
    let previousSummary: Promise<string | null> = Promise.resolve(null);
    if (active) {
      active.status = AgentSessionStatus.ENDED;
      active.endedAt = now;
      active.summaryStatus = AgentSummaryStatus.PENDING;
      previous = await this.sessionRepo.save(active);
      previousSummary = this.summarizeEndedSession(previous, input.providerId);
    } else {
      previous = await this.sessionRepo.findOne({
        where: { adminId: input.adminId, conversationId: input.conversationId },
        order: { startedAt: "DESC" },
      });
      if (previous?.summaryStatus === AgentSummaryStatus.READY) {
        previousSummary = Promise.resolve(previous.summary ?? null);
      } else if (
        previous?.summaryStatus === AgentSummaryStatus.FAILED ||
        previous?.summaryStatus === AgentSummaryStatus.PENDING
      ) {
        previousSummary = this.summarizeEndedSession(previous, input.providerId);
      }
    }

    const lastAgentOutbound = await this.findLastAgentOutbound(
      input.adminId,
      input.conversationId,
    );
    const agentSeenUntil = seedAgentSeenUntil(
      previous?.agentSeenUntil,
      lastAgentOutbound?.createdAt,
    );
    const session = await this.sessionRepo.save(
      this.sessionRepo.create({
        adminId: input.adminId,
        conversationId: input.conversationId,
        customerId: input.customerId,
        agentId: input.agentId,
        status: AgentSessionStatus.ACTIVE,
        startedAt: now,
        lastMessageAt: now,
        agentSeenUntil,
        previousSessionId: previous?.id ?? null,
        bootstrap: await this.buildBootstrap(input.adminId, input.customerId, input.phoneNumber),
      }),
    );
    this.logger.log(
      `New agent session ${session.id} conversation=${input.conversationId} agentSeenUntil=${
        agentSeenUntil?.toISOString() ?? "null"
      } source=${
        previous?.agentSeenUntil
          ? "previousSession"
          : lastAgentOutbound
            ? "lastAgentOutbound"
            : "none"
      }`,
    );

    const summary = await Promise.race([
      previousSummary,
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), AGENT_PREVIOUS_SUMMARY_WAIT_MS),
      ),
    ]);
    if (summary) {
      session.previousSummary = summary;
      await this.sessionRepo.update(session.id, { previousSummary: summary });
    } else if (summary === undefined) {
      // Too slow: this turn falls back to the raw tail; attach the summary once it's ready.
      void previousSummary.then((late) => {
        if (late) return this.sessionRepo.update(session.id, { previousSummary: late });
      });
    }
    return session;
  }

  async refreshBootstrap(session: AgentSessionEntity, phoneNumber: string) {
    if (!session.customerId) return;
    session.bootstrap = await this.buildBootstrap(session.adminId, session.customerId, phoneNumber);
    await this.sessionRepo.update(session.id, { bootstrap: session.bootstrap });
  }

  async getBootstrap(adminId: string, customerId: string, phoneNumber: string) {
    return this.buildBootstrap(adminId, customerId, phoneNumber);
  }

  /** Ends an idle ACTIVE session and writes its summary so the next customer message does not wait. */
  async closeIdleIfDue(sessionId: string, providerId?: string | null): Promise<boolean> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session || session.status !== AgentSessionStatus.ACTIVE) return false;
    if (Date.now() - session.lastMessageAt.getTime() < AGENT_SESSION_TIMEOUT_MS) return false;
    const now = new Date();
    session.status = AgentSessionStatus.ENDED;
    session.endedAt = now;
    session.summaryStatus = AgentSummaryStatus.PENDING;
    await this.sessionRepo.save(session);
    await this.summarizeEndedSession(session, providerId);
    return true;
  }

  async nextTurnSeq(session: AgentSessionEntity): Promise<number> {
    await this.sessionRepo.increment({ id: session.id }, "turnCount", 1);
    session.turnCount += 1;
    return session.turnCount;
  }

  async markSeenUntil(session: AgentSessionEntity, seenUntil: Date | null | undefined) {
    if (!seenUntil) return;
    if (
      session.agentSeenUntil &&
      seenUntil.getTime() <= new Date(session.agentSeenUntil).getTime()
    ) {
      return;
    }
    session.agentSeenUntil = seenUntil;
    await this.sessionRepo.update(session.id, { agentSeenUntil: seenUntil });
  }

  private async findLastAgentOutbound(adminId: string, conversationId: string) {
    return this.messageRepo.findOne({
      where: {
        adminId,
        conversationId,
        direction: MessageDirection.OUTBOUND,
        sendSource: MessageSendSource.AGENT,
      },
      order: { createdAt: "DESC" },
    });
  }

  async getMemoryFacts(adminId: string, customerId: string): Promise<AgentMemoryFactEntity[]> {
    const facts = await this.memoryRepo.find({
      where: { adminId, customerId },
      order: { createdAt: "DESC" },
      take: AGENT_MEMORY_FACTS_LIMIT,
    });
    return facts.reverse();
  }

  async addMemoryFact(adminId: string, customerId: string, fact: string, sourceTurnId?: string) {
    await this.memoryRepo.save(
      this.memoryRepo.create({ adminId, customerId, fact, sourceTurnId: sourceTurnId ?? null }),
    );
  }

  /** Verbatim history of the session that is not yet covered by the running summary. */
  async getRecentTurnMessages(session: AgentSessionEntity): Promise<AgentTurnMessageEntity[]> {
    return this.turnMessageRepo.find({
      where: { sessionId: session.id, seq: MoreThan(session.summarizedThroughSeq) },
      order: { seq: "ASC", position: "ASC" },
    });
  }

  /** Last raw WhatsApp messages before this session (first turn, alongside previousSummary). */
  async getPreviousRawTail(session: AgentSessionEntity): Promise<{ id: string; line: string }[]> {
    const rows = await this.messageRepo.find({
      where: {
        adminId: session.adminId,
        conversationId: session.conversationId,
        createdAt: LessThan(session.startedAt),
      },
      relations: AGENT_DESCRIBE_MESSAGE_RELATIONS,
      order: { createdAt: "DESC" },
      take: AGENT_PREVIOUS_RAW_MESSAGES,
    });
    return rows.reverse().map((m) => ({ id: m.id, line: describeMessage(m) }));
  }

  /**
   * Folds turns older than the last `keepTurns` into the running summary. A turn's tool calls and
   * results are stored with the turn, so they are always kept or summarized together.
   */
  async compact(
    session: AgentSessionEntity,
    options: { keepTurns?: number; providerId?: string | null; model?: string | null } = {},
  ): Promise<boolean> {
    const keepTurns = options.keepTurns ?? AGENT_KEEP_RECENT_TURNS;
    const cutoffSeq = session.turnCount - keepTurns;
    if (cutoffSeq <= session.summarizedThroughSeq) return false;

    const rows = await this.turnMessageRepo.find({
      where: { sessionId: session.id, seq: MoreThan(session.summarizedThroughSeq) },
      order: { seq: "ASC", position: "ASC" },
    });
    const toFold = rows.filter((r) => r.seq <= cutoffSeq);
    if (!toFold.length) return false;

    const summary = await this.summarizeTranscript({
      adminId: session.adminId,
      sessionId: session.id,
      conversationId: session.conversationId,
      agentId: session.agentId ?? session.adminId,
      earlierSummary: session.summary ?? session.previousSummary ?? null,
      transcript: renderTranscript(toFold),
      providerId: options.providerId,
      model: options.model,
    });
    if (!summary) return false;

    session.summary = summary;
    session.summarizedThroughSeq = cutoffSeq;
    await this.sessionRepo.update(session.id, {
      summary,
      summarizedThroughSeq: cutoffSeq,
    });
    return true;
  }

  private async summarizeEndedSession(
    session: AgentSessionEntity,
    providerId?: string | null,
  ): Promise<string | null> {
    try {
      const rows = await this.turnMessageRepo.find({
        where: { sessionId: session.id, seq: MoreThan(session.summarizedThroughSeq) },
        order: { seq: "ASC", position: "ASC" },
      });
      const summary = rows.length
        ? await this.summarizeTranscript({
            adminId: session.adminId,
            sessionId: session.id,
            conversationId: session.conversationId,
            agentId: session.agentId ?? session.adminId,
            earlierSummary: session.summary ?? session.previousSummary ?? null,
            transcript: renderTranscript(rows),
            providerId,
          })
        : session.summary ?? session.previousSummary ?? null;

      await this.sessionRepo.update(session.id, {
        summary: summary ?? session.summary ?? null,
        summarizedThroughSeq: session.turnCount,
        summaryStatus: summary ? AgentSummaryStatus.READY : AgentSummaryStatus.FAILED,
      });
      return summary;
    } catch (error) {
      this.logger.error(
        `Session summary failed for ${session.id}: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      await this.sessionRepo.update(session.id, { summaryStatus: AgentSummaryStatus.FAILED });
      return null;
    }
  }

  async summarizeTranscript(input: {
    adminId: string;
    sessionId: string;
    conversationId: string;
    agentId: string;
    earlierSummary: string | null;
    transcript: string;
    providerId?: string | null;
    model?: string | null;
  }): Promise<string | null> {
    const user = [
      input.earlierSummary ? `Earlier summary:\n${input.earlierSummary}` : null,
      `Transcript to add:\n${input.transcript}`,
      "Return the updated summary only. At most 12 bullets. Drop resolved items.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await this.orchestrator.runCompletion({
      tenantId: input.adminId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      userId: input.agentId,
      providerId: input.providerId,
      model: input.model,
      system: SUMMARY_SYSTEM_PROMPT,
      user,
      metadata: { source: "agent_session_summary" },
      usageSource: AiUsageSource.COMPACTION,
      usageApi: "agents.compact",
      usageActor: AiUsageActor.SYSTEM,
    });
    if (!result.ok || !result.content?.trim()) {
      this.logger.warn(`Summary call failed for session ${input.sessionId}: ${result.error ?? "empty"}`);
      return null;
    }
    return result.content.trim();
  }

  private async buildBootstrap(
    adminId: string,
    customerId: string,
    phoneNumber: string,
  ): Promise<string> {
    const normalizedPhone = normalizeEgyptianPhoneNumber(phoneNumber);
    const [owner, customer] = await Promise.all([
      this.userRepo.findOne({ where: { id: adminId }, relations: { company: true } }),
      this.customerRepo.findOne({ where: { id: customerId, adminId }, relations: { client: true } }),
    ]);
    const clientId =
      customer?.clientId ?? (await this.clients.findClientIdByPhone(adminId, normalizedPhone));

    const orderScope = clientId ? { adminId, clientId } : { adminId, normalizedPhoneNumber: normalizedPhone };
    const [orderCount, lastOrder] = await Promise.all([
      this.orderRepo.count({ where: orderScope }),
      this.orderRepo.findOne({
        where: orderScope,
        order: { created_at: "DESC" },
        relations: { status: true },
      }),
    ]);

    const company = owner?.company;
    const business = [
      `Store name: ${company?.name ?? owner?.name ?? "-"}`,
      company?.currency && `Currency: ${company.currency}`,
      company?.phone && `Store phone: ${company.phone}`,
      company?.website && `Website: ${company.website}`,
      company?.address && `Address: ${company.address}`,
      company?.businessType && `Business type: ${company.businessType}`,
      company?.country && `Country: ${company.country}`,
    ].filter(Boolean);

    const customerLines = [
      `Name on WhatsApp: ${customer?.name ?? "-"}`,
      customer?.client?.name && `Client record name: ${customer.client.name}`,
      `Phone: ${normalizedPhone}`,
      `Orders with the store: ${orderCount}`,
      lastOrder &&
        `Last order: ${lastOrder.orderNumber} — status "${lastOrder.status?.name ?? lastOrder.statusId}" — ${lastOrder.created_at ? new Date(lastOrder.created_at).toISOString().slice(0, 10) : ""}`,
    ].filter(Boolean);

    return `## Business\n${business.join("\n")}\n\n## Customer (looked up by phone)\n${customerLines.join("\n")}`;
  }
}

export function renderTranscript(rows: AgentTurnMessageEntity[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.role === "user") {
      lines.push(`[turn ${row.seq}] Customer input: ${clip(row.content, 2000)}`);
    } else if (row.role === "assistant") {
      for (const call of row.toolCalls ?? []) {
        lines.push(`Assistant called ${call.name}(${clip(JSON.stringify(call.arguments ?? {}), 800)})`);
      }
      if (row.content?.trim()) lines.push(`Assistant note: ${clip(row.content, 500)}`);
    } else if (row.role === "tool") {
      lines.push(`Tool result: ${clip(row.content, 600)}`);
    }
  }
  return lines.join("\n");
}

function clip(text: string | null | undefined, max: number): string {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
