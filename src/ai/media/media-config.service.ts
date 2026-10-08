import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import OpenAI from "openai";
import {
  AiIntegrationEntity,
  AiIntegrationScope,
  AiProviderCode,
} from "entities/ai.entity";
import { EncryptionService } from "common/encryption.service";

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
  constructor(
    private readonly config: ConfigService,
    @InjectRepository(AiIntegrationEntity)
    private readonly integrationRepo: Repository<AiIntegrationEntity>,
    private readonly encryption: EncryptionService,
  ) {}

  models(): MadarMediaModels {
    return {
      visionModel: this.config.get<string>("AI_MEDIA_VISION_MODEL") || "gpt-5-nano",
      documentModel:
        this.config.get<string>("AI_MEDIA_DOCUMENT_MODEL") || "gpt-5-nano",
      transcribeModel:
        this.config.get<string>("AI_MEDIA_TRANSCRIBE_MODEL") || "gpt-transcribe",
      timeoutMs: Number(this.config.get("AI_MEDIA_TIMEOUT_MS")) || 90_000,
    };
  }

  async createOpenAi(): Promise<OpenAI> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) {
      throw new MediaUnderstandingError(
        "Madar OpenAI key is not configured (system OpenAI integration or AI_OPENAI_API_KEY)",
        "MISSING_API_KEY",
      );
    }
    return new OpenAI({
      apiKey,
      timeout: this.models().timeoutMs,
      maxRetries: 1,
    });
  }

  private async resolveApiKey(): Promise<string> {
    const fromIntegration = await this.systemOpenAiApiKey();
    if (fromIntegration) return fromIntegration;
    return this.config.get<string>("AI_OPENAI_API_KEY") || "";
  }

  private async systemOpenAiApiKey(): Promise<string> {
    const integration = await this.integrationRepo
      .createQueryBuilder("i")
      .innerJoinAndSelect("i.provider", "p")
      .where("i.scope = :scope", { scope: AiIntegrationScope.SYSTEM })
      .andWhere("i.adminId IS NULL")
      .andWhere("LOWER(p.code) = :code", { code: AiProviderCode.OPENAI })
      .getOne();
    if (!integration?.encryptedCredentials) return "";
    try {
      const { ciphertext, iv, tag } = integration.encryptedCredentials as {
        ciphertext?: string;
        iv?: string;
        tag?: string;
      };
      if (!ciphertext || !iv || !tag) return "";
      const raw = this.encryption.decrypt(ciphertext, iv, tag);
      const parsed =
        typeof raw === "string"
          ? (() => {
              try {
                return JSON.parse(raw);
              } catch {
                return null;
              }
            })()
          : raw;
      const key =
        parsed && typeof parsed === "object"
          ? parsed.apiKey ?? parsed.apikey ?? parsed.api_Key ?? parsed.token
          : "";
      return typeof key === "string" ? key.trim() : "";
    } catch {
      return "";
    }
  }
}
