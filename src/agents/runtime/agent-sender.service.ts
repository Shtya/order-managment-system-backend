import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  ConversationAiMode,
  ConversationEntity,
  MessageSendSource,
  WhatsappMessageEntity,
} from "entities/whatsapp.entity";
import { WhatsappService } from "src/whatsapp/whatsapp.service";
import { WhatsappAiService } from "src/whatsapp/services/whatsapp-ai.service";
import { AgentToolScope } from "./agent-runtime.constants";

export class AgentSendBlockedError extends Error {}

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
    await this.assertCanSend(scope);

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
  }

  /**
   * Downloads a public catalog image URL, uploads it to Meta (same path as upsell headers),
   * then sends a WhatsApp image message with optional caption.
   */
  async sendImage(
    scope: AgentToolScope,
    input: { url: string; caption?: string; extra?: Record<string, any> },
  ): Promise<{ wamid: string | null }> {
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

  /** Resolves a message of this conversation by our id, for reactions and quoted replies. */
  async findConversationMessage(scope: AgentToolScope, messageId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(String(messageId ?? ""))) return null;
    return this.messageRepo.findOne({
      where: { id: messageId, adminId: scope.adminId, conversationId: scope.conversationId },
      select: { id: true, messageId: true },
    });
  }

  private async assertCanSend(scope: AgentToolScope) {
    const conversation = await this.conversationRepo.findOne({
      where: { id: scope.conversationId, adminId: scope.adminId },
      select: { id: true, aiMode: true, agentPausedUntil: true },
    });
    if (!conversation || conversation.aiMode === ConversationAiMode.DISABLED) {
      throw new AgentSendBlockedError("AI replies were turned off for this conversation");
    }
    if (conversation.agentPausedUntil && conversation.agentPausedUntil.getTime() > Date.now()) {
      throw new AgentSendBlockedError("An employee is handling this conversation");
    }
    const context = await this.whatsappAiService.loadContext(scope.adminId, scope.accountId);
    const ai = this.whatsappAiService.resolve(context, conversation.aiMode);
    if (!ai.enabled || !ai.agentId) {
      throw new AgentSendBlockedError("AI replies were turned off for this account");
    }
  }
}
