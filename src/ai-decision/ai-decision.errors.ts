import type { DecisionUsage } from './ai-decision.types';

/**
 * How the service should react (see AiDecisionService):
 *
 *  - AiDecisionValidationError / AiDecisionInputTooLargeError
 *      thrown BEFORE authorize(), nothing is reserved, nothing to settle.
 *  - ProviderChargedError
 *      the provider answered (HTTP 200) but the payload is unusable -> finalize(usage).
 *  - ProviderTimeoutError
 *      outcome unknown (the call may have been processed) -> release + alert.
 *  - every other ProviderError
 *      the provider did not process the request -> release.
 */

export class AiDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The request is malformed. Caller bug, not a provider problem. */
export class AiDecisionValidationError extends AiDecisionError {
  constructor(public readonly issues: string[]) {
    super(`Invalid decision request: ${issues.join('; ')}`);
  }
}

/** The (estimated) input is over the provider's context limit. */
export class AiDecisionInputTooLargeError extends AiDecisionError {
  constructor(
    public readonly estimatedTokens: number,
    public readonly maxTokens: number,
  ) {
    super(
      `Decision input is too large: ~${estimatedTokens} tokens (limit ${maxTokens}).`,
    );
  }
}

export type ProviderErrorCode =
  | 'AUTH'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'UPSTREAM';

export class ProviderError extends AiDecisionError {
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly originalError?: unknown;

  constructor(
    message: string,
    opts: {
      code: ProviderErrorCode;
      status?: number;
      retryable?: boolean;
      originalError?: unknown;
    },
  ) {
    super(message);
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.originalError = opts.originalError;
  }
}

/** 429 / 529 after the provider's retry budget is exhausted. Not processed. */
export class ProviderRateLimitedError extends ProviderError {
  constructor(status: number, message = 'Provider is rate limited or overloaded') {
    super(message, { code: 'RATE_LIMITED', status, retryable: true });
  }
}

/** No answer in time. The provider MAY have processed the request (unknown outcome). */
export class ProviderTimeoutError extends ProviderError {
  constructor(public readonly timeoutMs: number) {
    super(`Provider did not answer within ${timeoutMs}ms`, {
      code: 'TIMEOUT',
      retryable: false,
    });
  }
}

/**
 * The provider processed the request and reported usage, but the result cannot
 * be used (invalid JSON, missing or mismatched answers). It was billed, so the
 * service must finalize with `usage` instead of releasing.
 */
export class ProviderChargedError extends ProviderError {
  constructor(
    public readonly usage: DecisionUsage,
    message: string,
  ) {
    super(message, { code: 'INVALID_RESPONSE', retryable: false });
  }
}
