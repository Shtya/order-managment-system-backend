import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { MoreThan, Not, Repository } from "typeorm";
import { AgentEntity } from "entities/agent.entity";
import {
  ConversationAiMode,
  ConversationEntity,
  MessageDirection,
  MessageSendSource,
  MessageStatus,
  WhatsappMessageEntity,
  WhatsappMessageType,
} from "entities/whatsapp.entity";
import { WhatsappAiService } from "src/whatsapp/services/whatsapp-ai.service";
import { AgentTurnJobData } from "src/queue/common/queue.constants";
import { AgentInputService, AgentInsight } from "./agent-input.service";

const CATCHUP_LIMIT = 20;

const ACK_PATTERN =
  /^(ok+|okay|k+|thanks?|thankyou|ty|thx|yes|yep|yup|تمامكده|تمام|ماشي|حاضر|شكراً?|ميرسي|اوكيه?|اوكي|اوkay)+$/iu;

@Injectable()
export class AgentPauseCatchupService {
  private readonly logger = new Logger(AgentPauseCatchupService.name);

  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,
    @InjectRepository(AgentEntity)
    private readonly agentRepo: Repository<AgentEntity>,
    @Inject(forwardRef(() => WhatsappAiService))
    private readonly whatsappAiService: WhatsappAiService,
    private readonly input: AgentInputService,
  ) {}

  /**
   * After the employee pause ends, start a turn only for customer messages that still need a reply.
   * Returns a new pause end if the employee is still handling the chat (caller should reschedule).
   */
  async run(data: AgentTurnJobData): Promise<{
    rescheduleUntil?: Date;
    messageIds: string[];
    accountId: string | null;
  }> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: data.conversationId, adminId: data.adminId },
    });
    if (!conversation) return { messageIds: [], accountId: data.accountId };

    if (conversation.humanHandoff) {
      return { messageIds: [], accountId: data.accountId };
    }
    if (conversation.agentPausedUntil && conversation.agentPausedUntil.getTime() > Date.now()) {
      return { messageIds: [], accountId: data.accountId, rescheduleUntil: conversation.agentPausedUntil };
    }
    if (conversation.aiMode === ConversationAiMode.DISABLED) {
      return { messageIds: [], accountId: data.accountId };
    }

    const last = await this.messageRepo.findOne({
      where: {
        adminId: data.adminId,
        conversationId: conversation.id,
        messageType: Not(WhatsappMessageType.REACTION),
      },
      order: { createdAt: "DESC" },
    });
    if (!last || last.direction !== MessageDirection.INBOUND) {
      return { messageIds: [], accountId: data.accountId };
    }

    const lastOutbound = await this.messageRepo.findOne({
      where: {
        adminId: data.adminId,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        messageType: Not(WhatsappMessageType.REACTION),
      },
      order: { createdAt: "DESC" },
    });

    const inbound = await this.messageRepo.find({
      where: {
        adminId: data.adminId,
        conversationId: conversation.id,
        direction: MessageDirection.INBOUND,
        ...(lastOutbound ? { createdAt: MoreThan(lastOutbound.createdAt) } : {}),
      },
      relations: { replyTo: true, reactionTo: true },
      order: { createdAt: "ASC" },
      take: CATCHUP_LIMIT,
    });
    const candidates = inbound.filter(
      (m) => m.status !== MessageStatus.DELETED && this.shouldAgentHandle(m),
    );
    if (!candidates.length) return { messageIds: [], accountId: data.accountId };

    const accountId = candidates[candidates.length - 1].accountId ?? data.accountId;
    const context = await this.whatsappAiService.loadContext(data.adminId, accountId);
    const ai = this.whatsappAiService.resolve(context, conversation.aiMode);
    if (!ai.enabled || !ai.agentId) return { messageIds: [], accountId };
    const agent = await this.agentRepo.findOne({
      where: { id: ai.agentId, adminId: data.adminId },
    });
    const insights = await this.input.understand(data.adminId, candidates, { agent });
    const byId = new Map(insights.map((i) => [i.messageId, i]));
    const kept = candidates.filter((m) => {
      const insight = byId.get(m.id);
      return insight && this.needsReply(insight);
    });
    if (!kept.length) {
      this.logger.debug(`Pause catch-up for ${conversation.id}: nothing needs a reply`);
      return { messageIds: [], accountId };
    }

    return { messageIds: kept.map((m) => m.id), accountId };
  }

  private shouldAgentHandle(message: WhatsappMessageEntity): boolean {
    const type = message.messageType;
    const raw: any = message.content ?? {};
    if (type === WhatsappMessageType.REACTION) {
      return (
        message.reactionTo?.sendSource === MessageSendSource.AGENT &&
        !!message.reactionTo.metadata?.agentPendingActionId
      );
    }
    const replyData =
      raw.interactive?.button_reply ??
      raw.interactive?.list_reply ??
      (raw.button ? { id: raw.button.payload, text: raw.button.text } : null);
    const isOptionAnswer = !!message.replyTo && !!replyData && type !== WhatsappMessageType.LOCATION;
    if (isOptionAnswer) return message.replyTo.sendSource === MessageSendSource.AGENT;
    return true;
  }

  private needsReply(insight: AgentInsight): boolean {
    if (insight.kind === "ignored" || insight.kind === "unsupported") return false;
    if (insight.kind === "reaction") return !!insight.parentMetadata?.agentPendingActionId;
    if (
      insight.kind === "location" ||
      insight.kind === "contacts" ||
      insight.kind === "choice" ||
      insight.kind === "audio" ||
      insight.kind === "image" ||
      insight.kind === "video" ||
      insight.kind === "document" ||
      insight.kind === "failed"
    ) {
      return true;
    }
    return !isAcknowledgement(insight.text);
  }
}

function isAcknowledgement(text: string): boolean {
  const original = String(text ?? "").trim();
  if (!original) return true;
  if (/[?؟]/.test(original)) return false;
  const compact = original
    .toLowerCase()
    .replace(/[\s.!,،ـ_-]+/g, "")
    .replace(/[👍👌❤♥✅🙏]/g, "");
  if (!compact) return true;
  if (compact.length > 24) return false;
  return ACK_PATTERN.test(compact);
}
