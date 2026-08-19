export type AiProviderErrorKind =
  | "CONFIG"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "AUTH"
  | "NETWORK"
  | "HTTP"
  | "INVALID_RESPONSE"
  | "TOOL_ERROR"
  | "OUT_OF_ROUNDS";

export class AiProviderError extends Error {
  readonly kind: AiProviderErrorKind;
  readonly provider?: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      kind: AiProviderErrorKind;
      provider?: string;
      status?: number;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "AiProviderError";
    this.kind = options.kind;
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) {
      (this as any).cause = options.cause;
    }
  }

  static isRetryableKind(kind: AiProviderErrorKind): boolean {
    return ["TIMEOUT", "RATE_LIMITED", "NETWORK", "HTTP"].includes(kind);
  }
}

export class AiProviderConfigError extends AiProviderError {
  constructor(message: string, options: { provider?: string } = {}) {
    super(message, { kind: "CONFIG", ...options });
    this.name = "AiProviderConfigError";
  }
}

export class AiProviderTimeoutError extends AiProviderError {
  constructor(message: string, options: { provider?: string } = {}) {
    super(message, { kind: "TIMEOUT", retryable: true, ...options });
    this.name = "AiProviderTimeoutError";
  }
}

export class AiProviderRateLimitedError extends AiProviderError {
  constructor(
    message: string,
    options: { provider?: string; retryAfterMs?: number; status?: number } = {},
  ) {
    super(message, { kind: "RATE_LIMITED", retryable: true, ...options });
    this.name = "AiProviderRateLimitedError";
  }
}

export class AiProviderAuthError extends AiProviderError {
  constructor(
    message: string,
    options: { provider?: string; status?: number } = {},
  ) {
    super(message, { kind: "AUTH", ...options });
    this.name = "AiProviderAuthError";
  }
}

export class AiProviderNetworkError extends AiProviderError {
  constructor(
    message: string,
    options: { provider?: string; cause?: unknown } = {},
  ) {
    super(message, { kind: "NETWORK", retryable: true, ...options });
    this.name = "AiProviderNetworkError";
  }
}

export class AiProviderInvalidResponseError extends AiProviderError {
  constructor(
    message: string,
    options: { provider?: string; cause?: unknown } = {},
  ) {
    super(message, { kind: "INVALID_RESPONSE", ...options });
    this.name = "AiProviderInvalidResponseError";
  }
}

export class AiToolExecutionError extends AiProviderError {
  constructor(message: string, options: { toolName?: string } = {}) {
    super(message, { kind: "TOOL_ERROR", ...options });
    this.name = "AiToolExecutionError";
  }
}

export class AiStalePendingRequiresReviewError extends AiProviderError {
  constructor(message: string, options: { toolName?: string } = {}) {
    super(message, { kind: "TOOL_ERROR", ...options });
    this.name = "AiStalePendingRequiresReviewError";
  }
}

export function isAiProviderError(error: unknown): error is AiProviderError {
  return error instanceof AiProviderError;
}

export function toAiProviderError(
  error: unknown,
  provider?: string,
): AiProviderError {
  if (error instanceof AiProviderError) return error;

  const err = error as {
    name?: string;
    message?: string;
    status?: number;
    code?: string;
    response?: { status?: number };
  };
  const status = err?.response?.status ?? err?.status;
  const code = String(err?.code ?? "");
  const isTimeout =
    code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "timeout";
  const isNetwork =
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ERR_SOCKET_CONNECTION_TIMEOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT";

  const message = err?.message ?? "Unknown provider error";

  if (isTimeout) return new AiProviderTimeoutError(message, { provider });
  if (isNetwork) {
    return new AiProviderNetworkError(message, { provider, cause: error });
  }
  if (status === 401 || status === 403) {
    return new AiProviderAuthError(message, { provider, status });
  }
  if (status === 429) {
    return new AiProviderRateLimitedError(message, { provider, status });
  }
  if (status) {
    return new AiProviderError(message, {
      kind: "HTTP",
      provider,
      status,
      retryable: status >= 500 || status === 408 || status === 409,
    });
  }

  return new AiProviderError(message, {
    kind: "NETWORK",
    provider,
    retryable: true,
    cause: error,
  });
}
