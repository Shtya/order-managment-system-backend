import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OpenAI from "openai";

export type MediaKind = "image" | "video" | "document" | "audio";

export type MediaUsage = {
  inputTokens: number;
  outputTokens: number;
  audioSeconds: number;
};

export type MediaProcessInput = {
  adminId: string;
  agentId: string;
  conversationId?: string | null;
  messageId: string;
  idempotencyKey: string;
  kind: MediaKind;
  buffer: Buffer;
  mimeType?: string;
  filename?: string;
  caption?: string;
};

export type MediaProcessResult = {
  status: "ok";
  kind: MediaKind;
  text: string;
  usage: MediaUsage;
  models?: { vision?: string; transcribe?: string; document?: string };
  authorizationId?: string;
  chargeId?: string | null;
  chargedAmountMicros: string;
};

export type MadarMediaModels = {
  apiKey: string;
  visionModel: string;
  documentModel: string;
  transcribeModel: string;
  timeoutMs: number;
};

export const MEDIA_LIMITS = {
  imageBytes: 5 * 1024 * 1024,
  audioBytes: 16 * 1024 * 1024,
  videoBytes: 50 * 1024 * 1024,
  documentBytes: 32 * 1024 * 1024,
  openaiAudioBytes: 25 * 1024 * 1024,
  maxDurationSeconds: 180,
};

export class MediaUnderstandingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "MediaUnderstandingError";
  }
}

export class MediaInsufficientBalanceError extends MediaUnderstandingError {
  constructor() {
    super("Insufficient wallet balance", "INSUFFICIENT_BALANCE");
  }
}

export class MediaProviderChargedError extends MediaUnderstandingError {
  constructor(
    readonly usage: {
      inputTokens: number;
      outputTokens: number;
      audioSeconds: number;
    },
  ) {
    super("Provider billed this request before it failed", "PROVIDER_CHARGED");
  }
}

@Injectable()
export class MediaConfigService {
  constructor(private readonly config: ConfigService) {}

  models(): MadarMediaModels {
    return {
      apiKey: this.config.get<string>("AI_OPENAI_API_KEY") || "",
      visionModel: this.config.get<string>("AI_MEDIA_VISION_MODEL") || "gpt-5-nano",
      documentModel:
        this.config.get<string>("AI_MEDIA_DOCUMENT_MODEL") || "gpt-5-nano",
      transcribeModel:
        this.config.get<string>("AI_MEDIA_TRANSCRIBE_MODEL") || "gpt-transcribe",
      timeoutMs: Number(this.config.get("AI_MEDIA_TIMEOUT_MS")) || 90_000,
    };
  }

  createOpenAi(): OpenAI {
    const { apiKey, timeoutMs } = this.models();
    if (!apiKey) {
      throw new MediaUnderstandingError(
        "Madar OpenAI key is not configured (AI_OPENAI_API_KEY)",
        "MISSING_API_KEY",
      );
    }
    return new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 1 });
  }
}
