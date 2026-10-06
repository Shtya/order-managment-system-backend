import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { randomUUID } from "crypto";
import {
  ConversationEntity,
  MessageSendSource,
  WhatsappMessageEntity,
} from "entities/whatsapp.entity";
import { WhatsappService } from "src/whatsapp/whatsapp.service";
import { WhatsappAiService } from "src/whatsapp/services/whatsapp-ai.service";
import { RedisService } from "common/redis/RedisService";
import { AgentToolScope, isAgentSilenced } from "./agent-runtime.constants";
import { appendPlaygroundBubble, loadPlaygroundSession, playgroundBubbleFromSend } from "./agent-playground.session";

export class AgentSendBlockedError extends Error {}

/** Meta refuses the send because the customer 24-hour session window is closed. */
export class AgentCustomerWindowClosedError extends AgentSendBlockedError {
  constructor() {
    super("customer session window closed");
    this.name = "AgentCustomerWindowClosedError";
  }
}

function isCustomerSessionWindowError(error: unknown): boolean {
  const anyErr = error as { message?: string; response?: { data?: any }; status?: number };
  const payload = anyErr?.response?.data?.error ?? anyErr?.response?.data ?? {};
  const code = Number(payload?.code ?? payload?.error_subcode ?? "");
  const text = `${anyErr?.message ?? ""} ${payload?.message ?? ""} ${payload?.error_user_msg ?? ""} ${code}`.toLowerCase();
  return (
    code === 131047 ||
    text.includes("131047") ||
    text.includes("re-engagement") ||
    text.includes("24 hour") ||
    text.includes("24-hour") ||
    text.includes("outside the allowed window")
  );
}

@Injectable()
export class AgentSenderService {
  constructor(
    @Inject(forwardRef(() => WhatsappService))
    private readonly whatsappService: WhatsappService,
    @Inject(forwardRef(() => WhatsappAiService))
    private readonly whatsappAiService: WhatsappAiService,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Sends to the current customer only, from the account of the turn. Re-checks right before
   * sending that AI replies are still enabled and no employee took over during the turn.
   */
  async send(
    scope: AgentToolScope,
    data: Record<string, any>,
    extraMetadata: Record<string, any> = {},
  ): Promise<{ wamid: string | null }> {
    if (scope.playgroundKey) {
      return this.sendPlayground(scope, data);
    }
    await this.assertCanSend(scope);

    try {
      const response: any = await this.whatsappService.sendMessage(
        { id: scope.adminId, adminId: scope.adminId },
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: scope.phoneNumber,
          ...data,
          metadata: {
            agentTurnId: scope.turnId,
            agentSessionId: scope.sessionId,
            ...extraMetadata,
          },
        } as any,
        scope.accountId ?? undefined,
        undefined,
        undefined,
        undefined,
        MessageSendSource.AGENT,
        scope.agentId,
      );
      return { wamid: response?.messages?.[0]?.id ?? null };
    } catch (error) {
      if (isCustomerSessionWindowError(error)) {
        throw new AgentCustomerWindowClosedError();
      }
      throw error;
    }
  }

  /**
   * Downloads a public catalog image URL, uploads it to Meta (same path as upsell headers),
   * then sends a WhatsApp image message with optional caption.
   */
  async sendImage(
    scope: AgentToolScope,
    input: { url: string; caption?: string; extra?: Record<string, any> },
  ): Promise<{ wamid: string | null }> {
    if (scope.playgroundKey) {
      return this.sendPlayground(scope, {
        type: "image",
        image: {
          link: input.url,
          ...(input.caption ? { caption: input.caption } : {}),
        },
      });
    }
    const media = await this.whatsappService.uploadMedia(
      { id: scope.adminId, adminId: scope.adminId },
      { url: input.url },
      scope.accountId ?? undefined,
    );
    if (!media?.id) {
      throw new Error("WhatsApp media upload returned no id");
    }
    return this.send(
      scope,
      {
        type: "image",
        image: {
          id: media.id,
          ...(input.caption ? { caption: input.caption } : {}),
        },
        ...(input.extra ?? {}),
      },
    );
  }

  private async sendPlayground(
    scope: AgentToolScope,
    data: Record<string, any>,
  ): Promise<{ wamid: string | null }> {
    const key = scope.playgroundKey;
    if (!key) throw new Error("playground send missing key");
    const wamid = `playground:${randomUUID()}`;
    await appendPlaygroundBubble(this.redisService, key, playgroundBubbleFromSend(data, wamid), scope.playgroundHashId);
    return { wamid };
  }

  /** Resolves a message of this conversation by our id, for reactions and quoted replies. */
  async findConversationMessage(scope: AgentToolScope, messageId: string) {
    const id = String(messageId ?? "");
    if (scope.playgroundKey) {
      const session = await loadPlaygroundSession(this.redisService, scope.playgroundKey);
      const hit =
        session?.bubbles.find((row) => row.id === id) ||
        session?.inboundIds?.includes(id);
      return hit ? { id, messageId: id } : null;
    }
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return this.messageRepo.findOne({
      where: { id, adminId: scope.adminId, conversationId: scope.conversationId },
      select: { id: true, messageId: true },
    });
  }

  private async assertCanSend(scope: AgentToolScope) {
    const conversation = await this.conversationRepo.findOne({
      where: { id: scope.conversationId, adminId: scope.adminId },
      select: { id: true, aiMode: true, agentPausedUntil: true, humanHandoff: true },
    });
    if (!conversation || isAgentSilenced(conversation)) {
      throw new AgentSendBlockedError("AI replies were turned off for this conversation");
    }
    const context = await this.whatsappAiService.loadContext(scope.adminId, scope.accountId);
    const ai = this.whatsappAiService.resolve(context, conversation.aiMode);
    if (!scope.taskId && (!ai.enabled || !ai.agentId)) {
      throw new AgentSendBlockedError("AI replies were turned off for this account");
    }
  }
}
