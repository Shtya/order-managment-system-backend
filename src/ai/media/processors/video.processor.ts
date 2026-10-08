import fs from "fs";
import path from "path";
import os from "os";
import { Injectable } from "@nestjs/common";
import { toFile } from "openai";
import {
  MEDIA_LIMITS,
  MediaConfigService,
  MediaUnderstandingError,
  type MediaUsage,
} from "../media-config.service";
import {
  probeDurationSeconds,
  probeHasAudio,
  runFfmpeg,
} from "common/ffmpeg/ffmpeg.util";
import {
  removeTempPath,
  writeTempFile,
} from "common/ffmpeg/temp-file.util";

@Injectable()
export class VideoMediaProcessor {
  constructor(private readonly mediaConfig: MediaConfigService) {}

  async estimate(
    buffer: Buffer,
    mimeType?: string,
  ): Promise<MediaUsage> {
    const filePath = writeTempFile(buffer, extFor(mimeType));

    try {
      const duration = await this.duration(filePath);
      const frames = frameCount(duration);
      const hasAudio = await probeHasAudio(filePath);

      return {
        inputTokens: frames * 1500 + 400,
        outputTokens: 500,
        audioSeconds: hasAudio ? Math.ceil(duration) : 0,
      };
    } finally {
      removeTempPath(filePath);
    }
  }

  async process(
    buffer: Buffer,
    mimeType?: string,
    caption?: string,
  ): Promise<{
    text: string;
    usage: MediaUsage;
    models: {
      vision: string;
      transcribe?: string;
    };
  }> {
    const models = this.mediaConfig.models();
    const client = await this.mediaConfig.createOpenAi();

    const filePath = writeTempFile(
      buffer,
      extFor(mimeType),
    );

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "video-analysis-"),
    );

    const audioPath = path.join(tempDir, "audio.mp3");
    const framesDir = path.join(tempDir, "frames");

    fs.mkdirSync(framesDir);

    try {
      const duration = await this.duration(filePath);
      const audioDetected = await probeHasAudio(filePath);

      let transcript: string | null = null;
      let audioSeconds = 0;

      // -------------------------
      // Audio understanding
      // -------------------------

      if (audioDetected) {
        await runFfmpeg([
          "-y",
          "-i",
          filePath,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "mp3",
          "-b:a",
          "64k",
          audioPath,
        ]);

        const audioFile = await toFile(
          fs.readFileSync(audioPath),
          "audio.mp3",
          {
            type: "audio/mpeg",
          },
        );

        const transcription =
          await client.audio.transcriptions.create({
            file: audioFile,
            model: models.transcribeModel,
            language: "ar",
          });

        transcript =
          String(transcription.text ?? "").trim() || null;

        audioSeconds = Math.ceil(duration);
      }

      // -------------------------
      // Visual understanding
      // -------------------------

      const framePaths = await extractFrames(
        filePath,
        framesDir,
        duration,
      );

      let description = "";
      let inputTokens = 0;
      let outputTokens = 0;

      if (framePaths.length) {
        const captionText = caption?.trim()
          ? `Customer message:\n${caption.trim()}`
          : "No customer message was provided.";

        const content: any[] = [
          {
            type: "text",
            text: `You are the visual-understanding layer of a WhatsApp customer-support agent for an ERP/business system.

Analyze these video frames together in the context of the customer's message.

Extract only information relevant to the customer's request, such as:
- Products and quantities
- Damage or condition
- Packaging
- Labels, documents, receipts, or screens
- Locations and visible addresses
- Other important visual information

Rules:
- Do NOT answer the customer.
- Do NOT describe irrelevant visual details.
- Do NOT invent or guess information.
- Preserve names, numbers, IDs, SKUs, and phone numbers exactly as shown.
- Do not normalize or correct identifiers.
- If something is unclear, say it is unclear.
- Use all frames together to understand the situation.

${captionText}

Return a concise factual description for the main AI agent.`,
          },
        ];

        for (const framePath of framePaths) {
          const b64 = fs
            .readFileSync(framePath)
            .toString("base64");

          content.push({
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${b64}`,
              detail: "low",
            },
          });
        }

        const response =
          await client.chat.completions.create({
            model: models.visionModel,
            messages: [
              {
                role: "user",
                content,
              },
            ],
          });

        description =
          response.choices[0]?.message?.content?.trim() || "";

        inputTokens =
          response.usage?.prompt_tokens ??
          framePaths.length * 1200;

        outputTokens =
          response.usage?.completion_tokens ?? 0;
      }

      const speech = transcript || "none";
      const visual = description || "none";

      return {
        text: `[Shared video] speech: ${speech} visual: ${visual}`,
        usage: {
          inputTokens,
          outputTokens,
          audioSeconds,
        },
        models: {
          vision: models.visionModel,
          transcribe: audioDetected
            ? models.transcribeModel
            : undefined,
        },
      };
    } finally {
      removeTempPath(filePath);
      fs.rmSync(tempDir, {
        recursive: true,
        force: true,
      });
    }
  }

  private async duration(
    filePath: string,
  ): Promise<number> {
    const duration =
      await probeDurationSeconds(filePath);

    if (
      duration >
      MEDIA_LIMITS.maxDurationSeconds
    ) {
      throw new MediaUnderstandingError(
        `Video is longer than ${MEDIA_LIMITS.maxDurationSeconds} seconds`,
        "DURATION_LIMIT",
      );
    }

    return duration;
  }
}

function frameCount(duration: number): number {
  if (duration <= 10) return 3;
  if (duration <= 30) return 6;
  if (duration <= 60) return 10;
  if (duration <= 120) return 15;

  return 20;
}

async function extractFrames(
  videoPath: string,
  outputDir: string,
  duration: number,
): Promise<string[]> {
  const count = frameCount(duration);
  const fps = count / duration;

  const outputPattern = path.join(
    outputDir,
    "frame-%03d.jpg",
  );

  await runFfmpeg([
    "-y",
    "-i",
    videoPath,
    "-vf",
    `fps=${fps}`,
    "-q:v",
    "3",
    outputPattern,
  ]);

  return fs
    .readdirSync(outputDir)
    .filter((file) => file.endsWith(".jpg"))
    .sort()
    .map((file) =>
      path.join(outputDir, file),
    );
}

function extFor(mimeType?: string): string {
  const mime = mimeType || "";

  if (mime.includes("quicktime")) return "mov";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("3gpp")) return "3gp";

  return "mp4";
}