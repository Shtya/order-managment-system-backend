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
    const sniffed = sniffAudio(buffer, mimeType);
    const mime = sniffed.mime;
    const ext = sniffed.ext;
    const file = await toFile(buffer, `voice.${ext}`, { type: mime });
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
    const ext = sniffAudio(buffer, mimeType).ext;
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

function sniffAudio(buffer: Buffer, mimeType?: string): { mime: string; ext: string } {
  const magic = buffer.subarray(0, 4);
  if (magic.length >= 4 && magic[0] === 0x1a && magic[1] === 0x45 && magic[2] === 0xdf && magic[3] === 0xa3) {
    return { mime: "audio/webm", ext: "webm" };
  }
  if (magic.toString("ascii") === "OggS") {
    return { mime: "audio/ogg", ext: "ogg" };
  }
  if (magic.toString("ascii") === "RIFF") {
    return { mime: "audio/wav", ext: "wav" };
  }
  if (magic.toString("ascii") === "fLaC") {
    return { mime: "audio/flac", ext: "flac" };
  }
  if (magic[0] === 0xff && magic[1] === 0xfb) {
    return { mime: "audio/mpeg", ext: "mp3" };
  }
  const mime = mimeType?.split(";")[0]?.trim() || "audio/ogg";
  return { mime, ext: extensionFor(mime) };
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
