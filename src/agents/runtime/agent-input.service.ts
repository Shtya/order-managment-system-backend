import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import {
  MessageDirection,
  WhatsappMessageEntity,
  WhatsappMessageType,
} from "entities/whatsapp.entity";
import { WhatsappApiService } from "src/whatsapp/services/WhatsappApi.service";
import { AiTranscriptionService } from "src/ai/services/ai-transcription.service";

export type AgentInsightKind =
  | "text"
  | "audio"
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

@Injectable()
export class AgentInputService {
  private readonly logger = new Logger(AgentInputService.name);

  constructor(
    @Inject(forwardRef(() => WhatsappApiService))
    private readonly whatsappApi: WhatsappApiService,
    private readonly transcription: AiTranscriptionService,
  ) {}

  async understand(
    adminId: string,
    messages: WhatsappMessageEntity[],
  ): Promise<AgentInsight[]> {
    return Promise.all(messages.map((m) => this.understandOne(adminId, m)));
  }

  private async understandOne(
    adminId: string,
    message: WhatsappMessageEntity,
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

      // case WhatsappMessageType.AUDIO:
      //   return this.transcribe(adminId, message, base);

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

  private async transcribe(
    adminId: string,
    message: WhatsappMessageEntity,
    base: { messageId: string; quoted: string | null },
  ): Promise<AgentInsight> {
    const audio: any = (message.content as any)?.audio ?? {};
    try {
      if (!audio.id || !message.accountId) throw new Error("Missing media id or account");
      const media = await this.whatsappApi.getMediaUrl(message.accountId, audio.id);
      const response = await this.whatsappApi.streamMedia(message.accountId, media?.url);
      const buffer = await readStream(response?.data ?? response);
      const text = await this.transcription.transcribe(adminId, buffer, {
        mimeType: audio.mime_type ?? media?.mime_type,
      });
      if (!text) return { ...base, kind: "failed", text: "[Voice note] (empty or inaudible)" };
      return { ...base, kind: "audio", text: `[Voice note transcript] ${text}` };
    } catch (error) {
      this.logger.warn(
        `Voice transcription failed for message ${message.id}: ${(error as Error)?.message}`,
      );
      return {
        ...base,
        kind: "failed",
        text: "[Voice note] (could not be processed right now)",
      };
    }
  }
}

/** Short readable form of any stored message (inbound raw webhook or outbound payload). */
export function describeMessage(message: WhatsappMessageEntity): string {
  const c: any = message.content ?? {};
  const who = message.direction === MessageDirection.OUTBOUND ? "Store" : "Customer";
  const type = String(message.messageType ?? c.type ?? "");
  let body = "";
  if (type === "text") body = c.text?.body ?? "";
  else if (type === "interactive")
    body =
      c.interactive?.body?.text ??
      c.interactive?.button_reply?.title ??
      c.interactive?.list_reply?.title ??
      "[interactive]";
  else if (type === "button") body = c.button?.text ?? "[button]";
  else if (type === "template") body = `[template ${c.template?.name ?? ""}]`;
  else if (type === "reaction") body = `[reaction ${c.reaction?.emoji ?? ""}]`;
  else if (type === "location") body = `[location ${c.location?.name ?? ""}]`;
  else body = `[${type || "message"}]`;
  return `${who} message: "${truncate(String(body), 400)}"`;
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
