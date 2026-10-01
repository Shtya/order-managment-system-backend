import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import {
  BillingOperationKey,
  BillingServiceKey,
  BillingWalletPool,
} from "entities/billing.entity";
import { AgentMediaUsageStatus } from "entities/agent-conversation.entity";
import { BillingService } from "src/billing/billing.service";
import { AudioMediaProcessor } from "./processors/audio.processor";
import { DocumentMediaProcessor } from "./processors/document.processor";
import { ImageMediaProcessor } from "./processors/image.processor";
import { VideoMediaProcessor } from "./processors/video.processor";
import { AgentMediaUsageService } from "./agent-media-usage.service";
import { AiUsageLedgerService } from "src/ai/usage/ai-usage-ledger.service";
import {
  AiUsageActor,
  AiUsageBilledBy,
  AiUsageSource,
  AiUsageStatus,
} from "entities/ai-usage.entity";
import {
  MEDIA_LIMITS,
  MediaInsufficientBalanceError,
  MediaKind,
  MediaProcessInput,
  MediaProcessResult,
  MediaProviderChargedError,
  MediaUnderstandingError,
  MediaUsage,
} from "./media-config.service";

const NOTE_KEYS: Record<MediaKind, string> = {
  image: "domains.billing.media_image",
  video: "domains.billing.media_video",
  document: "domains.billing.media_document",
  audio: "domains.billing.media_audio",
};

@Injectable()
export class MediaUnderstandingService {
  private readonly logger = new Logger(MediaUnderstandingService.name);

  constructor(
    private readonly billing: BillingService,
    private readonly usageLog: AgentMediaUsageService,
    private readonly images: ImageMediaProcessor,
    private readonly videos: VideoMediaProcessor,
    private readonly documents: DocumentMediaProcessor,
    private readonly audios: AudioMediaProcessor,
    private readonly usageLedger: AiUsageLedgerService,
  ) {}

  async process(input: MediaProcessInput): Promise<MediaProcessResult> {
    this.assertSize(input);
    const estimated = await this.estimate(input);
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          messageId: input.messageId,
          kind: input.kind,
          bytes: input.buffer.length,
        }),
      )
      .digest("hex");

    const auth = await this.billing.authorize({
      adminId: input.adminId,
      service: BillingServiceKey.AI_MEDIA,
      operation: BillingOperationKey.PROCESS,
      idempotencyKey: input.idempotencyKey,
      estimatedUsage: estimated,
      walletPool: BillingWalletPool.AI,
      context: {
        feature: "agent-media",
        requestHash,
        note: NOTE_KEYS[input.kind],
        mediaKind: input.kind,
        messageId: input.messageId,
        agentId: input.agentId,
      },
    });

    if (auth.authorized === false) {
      await this.usageLog.upsert({
        adminId: input.adminId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        kind: input.kind,
        status: AgentMediaUsageStatus.FAILED,
        errorCode: "INSUFFICIENT_BALANCE",
        error: "Insufficient wallet balance",
        inputTokens: estimated.inputTokens,
        outputTokens: estimated.outputTokens,
        audioSeconds: estimated.audioSeconds,
        chargedAmount: 0n,
      });
      throw new MediaInsufficientBalanceError();
    }

    if (auth.replay) {
      const answers = auth.replayPayload?.answers as
        | { text?: string; kind?: MediaKind; usage?: MediaUsage; models?: any }
        | undefined;
      if (answers?.text) {
        return {
          status: "ok",
          kind: input.kind,
          text: answers.text,
          usage: answers.usage ?? estimated,
          models: answers.models,
          authorizationId: auth.authorizationId,
          chargeId: null,
          chargedAmountMicros: "0",
        };
      }
    }

    let processed: {
      text: string;
      usage: MediaUsage;
      models?: { vision?: string; transcribe?: string; document?: string };
    };
    try {
      processed = await this.runProcessor(input);
    } catch (err) {
      await this.settleAfterProviderError(auth.authorizationId, err);
      await this.recordFailure(input, estimated, auth.authorizationId, err);
      throw err;
    }

    try {
      await this.billing.saveDecisionReplay(auth.authorizationId, {
        answers: {
          text: processed.text,
          kind: input.kind,
          usage: processed.usage,
          models: processed.models,
        },
        modelVersion: processed.models?.vision
          || processed.models?.document
          || processed.models?.transcribe
          || "madar-media",
      });
    } catch (err) {
      this.logger.error(
        `failed to persist media replay (authorizationId=${auth.authorizationId})`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    let chargeId: string | null = null;
    let chargedAmount = 0n;
    let charge = null as Awaited<ReturnType<BillingService["finalize"]>> | null;
    try {
      charge = await this.billing.finalize({
        authorizationId: auth.authorizationId,
        usage: processed.usage,
      });
      chargeId = charge?.id ?? null;
      chargedAmount = charge?.payableAmount ?? 0n;
    } catch (billingErr) {
      this.logger.error(
        `finalize failed after media processing (authorizationId=${auth.authorizationId})`,
        billingErr instanceof Error ? billingErr.stack : String(billingErr),
      );
    }

    await this.usageLog.upsert({
      adminId: input.adminId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      kind: input.kind,
      status: AgentMediaUsageStatus.OK,
      inputTokens: processed.usage.inputTokens,
      outputTokens: processed.usage.outputTokens,
      audioSeconds: processed.usage.audioSeconds,
      chargedAmount,
      authorizationId: auth.authorizationId,
      chargeId,
      visionModel: processed.models?.vision ?? null,
      transcribeModel: processed.models?.transcribe ?? null,
      documentModel: processed.models?.document ?? null,
    }).then((mediaUsageId) =>
      this.recordLedger(input, {
        mediaUsageId,
        inputTokens: processed.usage.inputTokens,
        outputTokens: processed.usage.outputTokens,
        audioSeconds: processed.usage.audioSeconds,
        modelCode:
          processed.models?.vision ??
          processed.models?.transcribe ??
          processed.models?.document ??
          null,
        status: AiUsageStatus.OK,
        chargeId,
        grossAmount: charge?.grossAmount ?? 0n,
        payableAmount: chargedAmount,
        freeUnits: charge?.allowanceUnitsConsumed ?? 0n,
        idempotencyKey: input.idempotencyKey,
      }),
    );

    return {
      status: "ok",
      kind: input.kind,
      text: processed.text,
      usage: processed.usage,
      models: processed.models,
      authorizationId: auth.authorizationId,
      chargeId,
      chargedAmountMicros: chargedAmount.toString(),
    };
  }

  private async estimate(input: MediaProcessInput): Promise<MediaUsage> {
    switch (input.kind) {
      case "image":
        return this.images.estimate();
      case "document":
        return this.documents.estimate(input.buffer);
      case "audio":
        return this.audios.estimate(input.buffer, input.mimeType);
      case "video":
        return this.videos.estimate(input.buffer, input.mimeType);
    }
  }

  private async runProcessor(input: MediaProcessInput) {
    switch (input.kind) {
      case "image": {
        const result = await this.images.process(
          input.buffer,
          input.mimeType,
          input.caption,
        );
        return {
          text: result.text,
          usage: result.usage,
          models: { vision: result.model },
        };
      }
      case "document": {
        const result = await this.documents.process(
          input.buffer,
          input.mimeType,
          input.filename,
          input.caption,
        );
        return {
          text: result.text,
          usage: result.usage,
          models: { document: result.model },
        };
      }
      case "audio": {
        const result = await this.audios.process(input.buffer, input.mimeType);
        return {
          text: result.text,
          usage: result.usage,
          models: { transcribe: result.model },
        };
      }
      case "video": {
        const result = await this.videos.process(
          input.buffer,
          input.mimeType,
          input.caption,
        );
        return { text: result.text, usage: result.usage, models: result.models };
      }
    }
  }

  private assertSize(input: MediaProcessInput) {
    const size = input.buffer?.length ?? 0;
    if (!size) {
      throw new MediaUnderstandingError("Missing media file", "MISSING_MEDIA");
    }
    const limits: Record<MediaKind, number> = {
      image: MEDIA_LIMITS.imageBytes,
      audio: MEDIA_LIMITS.audioBytes,
      video: MEDIA_LIMITS.videoBytes,
      document: MEDIA_LIMITS.documentBytes,
    };
    if (size > limits[input.kind]) {
      throw new MediaUnderstandingError(
        `${input.kind} is larger than the allowed size`,
        "SIZE_LIMIT",
      );
    }
    if (input.kind === "audio" && size > MEDIA_LIMITS.openaiAudioBytes) {
      throw new MediaUnderstandingError("Audio is larger than 25MB", "SIZE_LIMIT");
    }
  }

  private async settleAfterProviderError(authorizationId: string, err: unknown) {
    try {
      if (err instanceof MediaProviderChargedError) {
        await this.billing.finalize({ authorizationId, usage: err.usage });
        return;
      }
      await this.billing.release({
        authorizationId,
        reason: "PROVIDER_ERROR",
      });
    } catch (billingErr) {
      this.logger.error(
        `billing settle failed (authorizationId=${authorizationId})`,
        billingErr instanceof Error ? billingErr.stack : String(billingErr),
      );
    }
  }

  private async recordFailure(
    input: MediaProcessInput,
    estimated: MediaUsage,
    authorizationId: string,
    err: unknown,
  ) {
    const code =
      err instanceof MediaUnderstandingError ? err.code : "PROVIDER_ERROR";
    const message = err instanceof Error ? err.message : String(err);
    await this.usageLog.upsert({
      adminId: input.adminId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      kind: input.kind,
      status: AgentMediaUsageStatus.FAILED,
      errorCode: code,
      error: message,
      inputTokens: estimated.inputTokens,
      outputTokens: estimated.outputTokens,
      audioSeconds: estimated.audioSeconds,
      chargedAmount: 0n,
      authorizationId,
    }).then((mediaUsageId) =>
      this.recordLedger(input, {
        mediaUsageId,
        inputTokens: estimated.inputTokens,
        outputTokens: estimated.outputTokens,
        audioSeconds: estimated.audioSeconds,
        modelCode: null,
        status: AiUsageStatus.FAILED,
        chargeId: null,
        grossAmount: 0n,
        payableAmount: 0n,
        freeUnits: 0n,
        idempotencyKey: `${input.idempotencyKey}:failed`,
      }),
    );
  }

  private async recordLedger(
    input: MediaProcessInput,
    extras: {
      mediaUsageId: string | null;
      inputTokens: number;
      outputTokens: number;
      audioSeconds: number;
      modelCode: string | null;
      status: AiUsageStatus;
      chargeId: string | null;
      grossAmount: bigint;
      payableAmount: bigint;
      freeUnits: bigint;
      idempotencyKey: string;
    },
  ) {
    await this.usageLedger.record({
      adminId: input.adminId,
      source: AiUsageSource.MEDIA,
      api: "media.process",
      actor: AiUsageActor.CUSTOMER,
      billedBy: AiUsageBilledBy.MADAR,
      providerCode: "madar-media",
      modelCode: extras.modelCode,
      inputTokens: extras.inputTokens,
      outputTokens: extras.outputTokens,
      audioSeconds: extras.audioSeconds,
      rounds: 1,
      status: extras.status,
      grossAmount: extras.grossAmount,
      payableAmount: extras.payableAmount,
      freeUnits: extras.freeUnits,
      chargeId: extras.chargeId,
      idempotencyKey: extras.idempotencyKey,
      mediaUsageId: extras.mediaUsageId,
      agentId: input.agentId,
      conversationId: input.conversationId ?? null,
    });
  }
}
