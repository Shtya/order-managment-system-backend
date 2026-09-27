import { Injectable, Logger } from "@nestjs/common";
import OpenAI, { toFile } from "openai";
import { AiProviderSelectorService } from "../orchestrator/provider-selector.service";

const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const TRANSCRIPTION_TIMEOUT_MS = 60_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export class AiTranscriptionError extends Error {}

@Injectable()
export class AiTranscriptionService {
  private readonly logger = new Logger(AiTranscriptionService.name);

  constructor(private readonly providerSelector: AiProviderSelectorService) {}

  /** Speech-to-text biased to Arabic. Uses the tenant's OpenAI integration, falling back to the server key. */
  async transcribe(
    tenantId: string,
    audio: Buffer,
    options: { mimeType?: string; language?: string } = {},
  ): Promise<string> {
    if (!audio?.length) throw new AiTranscriptionError("Empty audio");
    if (audio.length > MAX_AUDIO_BYTES) {
      throw new AiTranscriptionError("Audio is larger than 25MB");
    }

    const apiKey = await this.resolveApiKey(tenantId);
    if (!apiKey) {
      throw new AiTranscriptionError("No OpenAI key configured for transcription");
    }

    const client = new OpenAI({ apiKey, timeout: TRANSCRIPTION_TIMEOUT_MS, maxRetries: 1 });
    const mimeType = options.mimeType?.split(";")[0]?.trim() || "audio/ogg";
    const file = await toFile(audio, `voice.${extensionFor(mimeType)}`, { type: mimeType });
    const result = await client.audio.transcriptions.create({
      file,
      model: process.env.AI_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIPTION_MODEL,
      language: options.language ?? "ar",
    });
    return String(result.text ?? "").trim();
  }

  private async resolveApiKey(tenantId: string): Promise<string | null> {
    try {
      const provider = await this.providerSelector.select("openai", tenantId);
      const key = provider.getConfig().apiKey;
      if (key) return key;
    } catch (error) {
      this.logger.debug(
        `No tenant OpenAI provider for transcription (${tenantId}): ${(error as Error)?.message}`,
      );
    }
    return process.env.AI_OPENAI_API_KEY || null;
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
