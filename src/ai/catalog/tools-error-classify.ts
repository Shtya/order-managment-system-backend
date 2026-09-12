import {
  AiProviderErrorKind,
  isAiProviderError,
} from "../errors/provider.errors";

const TOOLS_UNSUPPORTED_PATTERNS = [
  /not a chat model/i,
  /tools? (is|are) not supported/i,
  /tool[s]? (calling|use) is not supported/i,
  /does not support (function |tool ?)?(calling|tools?)/i,
  /function calling is not supported/i,
  /unsupported[_ ]tool/i,
];

export type ClassifiedProviderFailure =
  | "TOOLS_UNSUPPORTED"
  | "TENANT_UNHEALTHY"
  | "OTHER";

export function isToolsUnsupportedMessage(message: string): boolean {
  const text = String(message || "");
  return TOOLS_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(text));
}

export function classifyProviderFailure(
  error: unknown,
): ClassifiedProviderFailure {
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  if (isToolsUnsupportedMessage(message)) return "TOOLS_UNSUPPORTED";

  if (isAiProviderError(error)) {
    if (error.kind === "TOOLS_UNSUPPORTED") return "TOOLS_UNSUPPORTED";
    if (
      error.kind === "TIMEOUT" ||
      error.kind === "RATE_LIMITED" ||
      error.kind === "NETWORK"
    ) {
      return "TENANT_UNHEALTHY";
    }
  }

  return "OTHER";
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "Unknown provider error");
}

export function errorKindOf(error: unknown): AiProviderErrorKind | undefined {
  return isAiProviderError(error) ? error.kind : undefined;
}

export function formatAttemptsSummary(
  attempts: Array<{
    provider: string;
    model?: string | null;
    error?: string;
  }>,
): string {
  if (!attempts.length) return "";
  return attempts
    .map((attempt) => {
      const model = attempt.model ? `/${attempt.model}` : "";
      const err = attempt.error ? `: ${attempt.error}` : "";
      return `${attempt.provider}${model}${err}`;
    })
    .join("; ");
}

export function attachAttemptsToError(
  error: unknown,
  attempts: Array<{ code: string; model: string | null }>,
  summary: string,
): unknown {
  if (error && typeof error === "object") {
    (error as any).aiAttempts = attempts;
    (error as any).attemptsSummary = summary;
  }
  return error;
}
