import { Injectable } from "@nestjs/common";
import { toFile } from "openai";
import {
  MEDIA_LIMITS,
  MediaConfigService,
  MediaUnderstandingError,
  type MediaUsage,
} from "../media-config.service";
import { removeTempPath, writeTempFile } from "common/ffmpeg/temp-file.util";
import { probeDurationSeconds } from "common/ffmpeg/ffmpeg.util";

@Injectable()
export class AudioMediaProcessor {
  constructor(private readonly mediaConfig: MediaConfigService) {}

  async estimate(buffer: Buffer, mimeType?: string): Promise<MediaUsage> {
    const duration = await this.durationOf(buffer, mimeType);
    return { inputTokens: 0, outputTokens: 0, audioSeconds: Math.ceil(duration) };
  }

  async process(
    buffer: Buffer,
    mimeType?: string,
  ): Promise<{ text: string; usage: MediaUsage; model: string }> {
    const models = this.mediaConfig.models();
    const usage = await this.estimate(buffer, mimeType);
    const client = this.mediaConfig.createOpenAi();
    const mime = mimeType?.split(";")[0]?.trim() || "audio/ogg";
    const file = await toFile(buffer, `voice.${extensionFor(mime)}`, { type: mime });
    const result = await client.audio.transcriptions.create({
      file,
      model: models.transcribeModel,
      language: "ar",
    });
    const transcript = String(result.text ?? "").trim();
    if (!transcript) {
      throw new MediaUnderstandingError("Empty transcript", "EMPTY_TRANSCRIPT");
    }
    return {
      text: `[Voice note transcript] ${transcript}`,
      usage,
      model: models.transcribeModel,
    };
  }

  private async durationOf(buffer: Buffer, mimeType?: string): Promise<number> {
    const ext = extensionFor(mimeType || "audio/ogg");
    const filePath = writeTempFile(buffer, ext);
    try {
      const duration = await probeDurationSeconds(filePath);
      if (duration > MEDIA_LIMITS.maxDurationSeconds) {
        throw new MediaUnderstandingError(
          `Audio is longer than ${MEDIA_LIMITS.maxDurationSeconds} seconds`,
          "DURATION_LIMIT",
        );
      }
      return duration;
    } finally {
      removeTempPath(filePath);
    }
  }
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("amr")) return "amr";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("webm")) return "webm";
  return "ogg";
}
