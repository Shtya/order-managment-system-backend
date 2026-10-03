import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { AgentEntity } from "entities/agent.entity";
import {
  MessageActionIntent,
  MessageDirection,
  MessageSendSource,
  MessageStatus,
  WhatsappMessageEntity,
  WhatsappMessageType,
} from "entities/whatsapp.entity";
import { WhatsappApiService } from "src/whatsapp/services/WhatsappApi.service";
import { MediaUnderstandingService } from "src/ai/media/media-understanding.service";
import {
  MediaInsufficientBalanceError,
  MediaKind,
  MediaUnderstandingError,
} from "src/ai/media/media-config.service";

export type AgentInsightKind =
  | "text"
  | "audio"
  | "image"
  | "video"
  | "document"
  | "location"
  | "contacts"
  | "choice"
  | "reaction"
  | "unsupported"
  | "failed"
  | "ignored";

export type AgentInsight = {
  messageId: string;
  kind: AgentInsightKind;
  /** Normalized, channel-agnostic text the agent reads. Empty for ignored/unsupported items. */
  text: string;
  quoted?: string | null;
  /** Button/list option id when the customer picked an option. */
  choiceId?: string | null;
  /** The agent message a choice or reaction answers (for pending-action routing). */
  parentMetadata?: Record<string, any> | null;
};

const IGNORED_TYPES = new Set(["sticker", "system", "edit", "revoke", "ephemeral", "request_welcome"]);

const FAILED_LABEL: Record<MediaKind, string> = {
  image: "[Shared image] (could not be processed right now)",
  video: "[Shared video] (could not be processed right now)",
  document: "[Shared document] (could not be processed right now)",
  audio: "[Voice note] (could not be processed right now)",
};

@Injectable()
export class AgentInputService {
  private readonly logger = new Logger(AgentInputService.name);

  constructor(
    @Inject(forwardRef(() => WhatsappApiService))
    private readonly whatsappApi: WhatsappApiService,
    private readonly media: MediaUnderstandingService,
  ) {}

  async understand(
    adminId: string,
    messages: WhatsappMessageEntity[],
    options?: { agent?: AgentEntity | null },
  ): Promise<AgentInsight[]> {
    return Promise.all(messages.map((m) => this.understandOne(adminId, m, options?.agent)));
  }

  private async understandOne(
    adminId: string,
    message: WhatsappMessageEntity,
    agent?: AgentEntity | null,
  ): Promise<AgentInsight> {
    const raw: any = message.content ?? {};
    const type = String(message.messageType ?? raw.type ?? "unknown");
    const base = {
      messageId: message.id,
      quoted: message.replyTo ? describeMessage(message.replyTo) : null,
    };

    if (IGNORED_TYPES.has(type) || raw.video?.animated || raw.image?.animated) {
      return { ...base, kind: "ignored", text: "" };
    }

    switch (type) {
      case WhatsappMessageType.TEXT:
        return { ...base, kind: "text", text: String(raw.text?.body ?? "").trim() };

      case WhatsappMessageType.IMAGE:
        return this.processMedia(adminId, message, agent, "image", "acceptImage", base);
      case WhatsappMessageType.VIDEO:
        return this.processMedia(adminId, message, agent, "video", "acceptVideo", base);
      case WhatsappMessageType.DOCUMENT:
        return this.processMedia(adminId, message, agent, "document", "acceptDocument", base);
      case WhatsappMessageType.AUDIO:
        return this.processMedia(adminId, message, agent, "audio", "acceptAudio", base);

      case WhatsappMessageType.LOCATION: {
        const loc = raw.location ?? {};
        const parts = [
          loc.name && `name: ${loc.name}`,
          loc.address && `address: ${loc.address}`,
          `lat: ${loc.latitude}`,
          `lng: ${loc.longitude}`,
        ].filter(Boolean);
        return { ...base, kind: "location", text: `[Shared location] ${parts.join(", ")}` };
      }

      case WhatsappMessageType.CONTACTS: {
        const contacts = (raw.contacts ?? []).map((c: any) => {
          const name = c?.name?.formatted_name ?? c?.name?.first_name ?? "";
          const phones = (c?.phones ?? []).map((p: any) => p?.phone ?? p?.wa_id).filter(Boolean);
          return `${name} ${phones.join(" / ")}`.trim();
        });
        return { ...base, kind: "contacts", text: `[Shared contact] ${contacts.join("; ")}` };
      }

      case WhatsappMessageType.INTERACTIVE:
      case WhatsappMessageType.BUTTON: {
        const choice =
          raw.interactive?.button_reply ??
          raw.interactive?.list_reply ??
          (raw.button ? { id: raw.button.payload, title: raw.button.text } : null);
        if (!choice) break;
        const description = choice.description ? ` (${choice.description})` : "";
        return {
          ...base,
          kind: "choice",
          text: `[Picked option] "${choice.title ?? ""}"${description}`,
          choiceId: choice.id ?? null,
          parentMetadata: message.replyTo?.metadata ?? null,
        };
      }

      case WhatsappMessageType.REACTION: {
        const emoji = raw.reaction?.emoji;
        if (!emoji) return { ...base, kind: "ignored", text: "" };
        const target = message.reactionTo ? describeMessage(message.reactionTo) : "a message";
        return {
          ...base,
          quoted: null,
          kind: "reaction",
          text: `[Reacted ${emoji} to] ${target}`,
          parentMetadata: message.reactionTo?.metadata ?? null,
        };
      }
    }

    return { ...base, kind: "unsupported", text: "" };
  }

  private async processMedia(
    adminId: string,
    message: WhatsappMessageEntity,
    agent: AgentEntity | null | undefined,
    kind: MediaKind,
    flag: "acceptImage" | "acceptVideo" | "acceptDocument" | "acceptAudio",
    base: { messageId: string; quoted: string | null },
  ): Promise<AgentInsight> {
    if (!agent?.[flag]) {
      return { ...base, kind: "unsupported", text: "" };
    }
    const raw: any = message.content ?? {};
    const media = raw[kind] ?? {};
    const mediaId = media.id;
    const caption = String(media.caption ?? "").trim();
    try {
      if (!mediaId || !message.accountId) {
        throw new MediaUnderstandingError("Missing media id or account", "MISSING_MEDIA");
      }
      const meta = await this.whatsappApi.getMediaUrl(message.accountId, mediaId);
      const response = await this.whatsappApi.streamMedia(message.accountId, meta?.url);
      const buffer = await readStream(response?.data ?? response);
      const result = await this.media.process({
        adminId,
        agentId: agent.id,
        conversationId: message.conversationId,
        messageId: message.id,
        idempotencyKey: `media:${message.id}`,
        kind,
        buffer,
        mimeType: media.mime_type ?? meta?.mime_type,
        filename: media.filename,
        caption,
      });
      return { ...base, kind, text: result.text };
    } catch (error) {
      this.logger.warn(
        `${kind} processing failed for message ${message.id}: ${(error as Error)?.message}`,
      );
      const label =
        error instanceof MediaInsufficientBalanceError
          ? FAILED_LABEL[kind].replace(
              "could not be processed right now",
              "could not be processed: insufficient wallet balance",
            )
          : FAILED_LABEL[kind];
      return { ...base, kind: "failed", text: label };
    }
  }
}

const formatTime = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: tz,
  }).format(d);

export function describeMessage(m: WhatsappMessageEntity, tz = "Africa/Cairo"): string {
  const who = speakerLabel(m);
  const limit = who.startsWith("Staff") ? 800 : 400;

  let line = `[${formatTime(m.createdAt, tz)}] ${who}: "${truncate(bodyOf(m), limit)}"`;

  if (m.replyTo) line += ` (replying to: "${truncate(bodyOf(m.replyTo), 80)}")`;
  if (m.direction === MessageDirection.OUTBOUND && m.status === MessageStatus.FAILED)
    line += " [NOT DELIVERED]";
  if (m.actionIntent && m.actionIntent !== MessageActionIntent.NONE)
    line += ` [asked customer: ${m.actionIntent}, ${m.actionStatus}]`;

  return line;
}

 
/** Short readable form of any stored message (inbound raw webhook or outbound payload). */
export function bodyOf(message: WhatsappMessageEntity): string {
  const c: any = message.content ?? {};
  const who = speakerLabel(message);
  const type = String(message.messageType ?? c.type ?? "");
  let body = "";
  if (type === "text") body = c.text?.body ?? "";
  else if (type === "audio")
    return message.metadata?.transcript ?? c.audio?.transcript ?? "[voice note, no transcript]"; // adjust to where you store it
  
  else if (type === "interactive")
    body =
      c.interactive?.body?.text ??
      c.interactive?.button_reply?.title ??
      c.interactive?.list_reply?.title ??
      "[interactive]";
  else if (type === "button") body = c.button?.text ?? "[button]";
  else if (type === "template") body = `[template ${c.template?.name ?? ""}]`;
  else if (type === "reaction") body = `[reaction ${c.reaction?.emoji ?? ""}]`;
  else  if (type === "location") {
    const l = c.location ?? {};
    return `[location ${l.name ?? ""} ${l.address ?? ""} (${l.latitude}, ${l.longitude})]`.replace(/\s+/g, " ");
  }
  else if (type === "image" || type === "video" || type === "document" || type === "audio") {
    const caption = String(c[type]?.caption ?? c.caption ?? "").trim();
    body = caption || `[${type}]`;
  } else body = `[${type || "message"}]`;
  return `${who}: "${truncate(String(body), 400)}"`;
}

function speakerLabel(message: WhatsappMessageEntity): string {
  if (message.direction !== MessageDirection.OUTBOUND) return "Customer";
  if (message.sendSource === MessageSendSource.AGENT) return "Agent";
  if (message.sendSource === MessageSendSource.SYSTEM) return "System";
  if (message.sendSource === MessageSendSource.USER) {
    const name = message.sentByUser?.name?.trim();
    return name ? `Staff (${name})` : "Staff";
  }
  return "System";
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function readStream(stream: any): Promise<Buffer> {
  if (Buffer.isBuffer(stream)) return stream;
  if (!stream || typeof stream.on !== "function") throw new Error("No media stream");
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
