import { execFile } from "child_process";
import { promisify } from "util";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { MediaUnderstandingError } from "src/ai/media/media-config.service";

const execFileAsync = promisify(execFile);

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || ffmpegStatic || "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.FFPROBE_PATH || ffprobeStatic?.path || "ffprobe";
}

export async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(ffmpegBin(), args, { timeout: 60_000 });
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new MediaUnderstandingError("ffmpeg is not installed", "FFMPEG_MISSING");
    }
    throw new MediaUnderstandingError(
      err?.message || "ffmpeg failed",
      "FFMPEG_FAILED",
    );
  }
}

export async function runFfprobe(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(ffprobeBin(), args, { timeout: 30_000 });
    return String(stdout ?? "").trim();
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new MediaUnderstandingError("ffprobe is not installed", "FFMPEG_MISSING");
    }
    throw new MediaUnderstandingError(
      err?.message || "ffprobe failed",
      "INVALID_MEDIA",
    );
  }
}

export async function probeDurationSeconds(filePath: string): Promise<number> {
  const result = await runFfprobe([
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number(result);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MediaUnderstandingError("Could not read media duration", "INVALID_MEDIA");
  }
  return duration;
}

export async function probeHasAudio(filePath: string): Promise<boolean> {
  const result = await runFfprobe([
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=index",
    "-of",
    "csv=p=0",
    filePath,
  ]);
  return Boolean(result);
}
