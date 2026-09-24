import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiDecisionProvider } from './ai-decision.provider';
import {
  AiDecisionInputTooLargeError,
  ProviderChargedError,
  ProviderError,
  ProviderRateLimitedError,
  ProviderTimeoutError,
} from '../ai-decision.errors';
import type {
  DecideOptions,
  DecideRequest,
  DecideResult,
  DecisionAnswers,
  DecisionUsage,
  QuestionMap,
} from '../ai-decision.types';
import { assertValidRequest, validateAnswers } from '../ai-decision.validation';

export const JEV_OPTIONS = Symbol('JEV_OPTIONS');

export interface JevProviderOptions {
  apiKey: string;
  /** e.g. https://api.typesafe.ai */
  baseUrl: string;
  /** Pinned version, e.g. "jev-1.13.0". Avoid the "jev-latest" alias in production. */
  model: string;
  /** Jev usually answers in well under a second, keep this short. */
  timeoutMs: number;
  /** Retries for 429/529 only (the request was not processed, safe to retry). */
  maxRetries: number;
  /** Local token estimate. Lower = more conservative (over-reserves). */
  charsPerToken: number;
  /**
   * Tokens Jev bills on top of the JSON payload (system wrapper).
   * Calibrated from live usage: ~189 payload chars → 311 billed tokens.
   */
  inputTokenOverhead: number;
  /** Provider context limit for state + all questions. */
  maxInputTokens: number;
}

export function loadJevOptions(env: NodeJS.ProcessEnv = process.env): JevProviderOptions {
  const apiKey = env.TYPESAFE_API_KEY;
  
  return {
    apiKey,
    baseUrl: (env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, ''),
    model: env.JEV_MODEL ?? 'jev-1.13.0',
    timeoutMs: Number(env.JEV_TIMEOUT_MS ?? 10_000),
    maxRetries: Number(env.JEV_MAX_RETRIES ?? 2),
    charsPerToken: Number(env.JEV_CHARS_PER_TOKEN ?? 1),
    inputTokenOverhead: Number(env.JEV_INPUT_TOKEN_OVERHEAD ?? 160),
    maxInputTokens: Number(env.JEV_MAX_INPUT_TOKENS ?? 64_000),
  };
}

@Injectable()
export class JevDecisionProvider extends AiDecisionProvider {
  readonly name = 'jev';
  readonly modelId: string;
  private readonly logger = new Logger(JevDecisionProvider.name);

  constructor(@Inject(JEV_OPTIONS) private readonly options: JevProviderOptions) {
    super();
    this.modelId = options.model;
  }

  // -------------------------------------------------------------------------
  // Estimate (no network)
  // -------------------------------------------------------------------------

  estimateUsage<Q extends QuestionMap>(
    request: DecideRequest<Q>,
    options: DecideOptions = {},
  ): DecisionUsage {
    assertValidRequest(request);

    // Bill the same JSON Jev receives, plus a wrapper the API adds server-side.
    const chars = this.requestBody(request, options).length;
    const payloadTokens = Math.max(1, Math.ceil(chars / this.options.charsPerToken));
    const inputTokens = payloadTokens + this.options.inputTokenOverhead;

    if (inputTokens > this.options.maxInputTokens) {
      throw new AiDecisionInputTooLargeError(inputTokens, this.options.maxInputTokens);
    }

    // Jev output tokens are free, so they are not part of the worst case.
    return { modelId: options.model ?? this.modelId, inputTokens, outputTokens: 0 };
  }

  // -------------------------------------------------------------------------
  // Decide
  // -------------------------------------------------------------------------

  async decide<Q extends QuestionMap>(
    request: DecideRequest<Q>,
    options: DecideOptions = {},
  ): Promise<DecideResult<Q>> {
    const estimated = this.estimateUsage(request, options); // validates too
    const modelId = estimated.modelId;
    const body = this.requestBody(request, options);

    // HTTP 200 from here on means the provider processed (and billed) the request.
    const text = await this.post(body, options);

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderChargedError(estimated, 'Provider returned invalid JSON');
    }

    const usage = this.readUsage(json?.usage, modelId) ?? estimated;
    if (usage === estimated) {
      this.logger.warn('Provider response had no usage, falling back to the estimate');
    }

    const issues = validateAnswers(request.questions, json?.answers);
    if (issues.length) {
      throw new ProviderChargedError(usage, `Invalid provider answers: ${issues.join('; ')}`);
    }

    // Calibration signal: an under-estimate means the reservation was too small.
    if (usage.inputTokens > estimated.inputTokens) {
      this.logger.warn(
        `Input under-estimated: estimated=${estimated.inputTokens} actual=${usage.inputTokens}. ` +
          `Lower JEV_CHARS_PER_TOKEN (currently ${this.options.charsPerToken}).`,
      );
    }
    console.log('json', JSON.stringify(json, null, 2));
    return {
      answers: json.answers as DecisionAnswers<Q>,
      usage,
      modelVersion: typeof json.model === 'string' ? json.model : modelId,
    };
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  /** Returns the raw response text for a 2xx, throws a typed error otherwise. */
  private async post(body: string, options: DecideOptions): Promise<string> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onCallerAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onCallerAbort, { once: true });

      let status: number;
      let text: string;
      let retryAfter: string | null;

      try {
        const res = await fetch(`${this.options.baseUrl}/v1/systemone`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: controller.signal,
        });
        status = res.status;
        retryAfter = res.headers.get('retry-after');
        text = await res.text(); // read inside the timeout window
      } catch (err) {
        if (timedOut) throw new ProviderTimeoutError(timeoutMs); // unknown outcome
        if (options.signal?.aborted) throw err; // caller cancelled
        throw new ProviderError('Network error calling the provider', {
          code: 'NETWORK',
          retryable: false,
          originalError: err,
        });
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onCallerAbort);
      }

      if (status >= 200 && status < 300) return text;

      // 429 / 529: not processed, safe to retry with backoff.
      if ((status === 429 || status === 529) && attempt < this.options.maxRetries) {
        await sleep(backoffMs(attempt, retryAfter));
        continue;
      }

      throw this.mapHttpError(status, text);
    }
  }

  private mapHttpError(status: number, text: string): ProviderError {
    const detail = extractMessage(text);
    if (status === 429 || status === 529) return new ProviderRateLimitedError(status);
    if (status === 401 || status === 403) {
      return new ProviderError(`Provider auth failed: ${detail}`, { code: 'AUTH', status });
    }
    if (status === 422 || status === 400) {
      return new ProviderError(`Provider rejected the request: ${detail}`, {
        code: 'INVALID_REQUEST',
        status,
      });
    }
    if (status === 503) {
      return new ProviderError(`Provider unavailable: ${detail}`, {
        code: 'UNAVAILABLE',
        status,
        retryable: true,
      });
    }
    return new ProviderError(`Provider error ${status}: ${detail}`, {
      code: 'UPSTREAM',
      status,
    });
  }

  private requestBody<Q extends QuestionMap>(
    request: DecideRequest<Q>,
    options: DecideOptions,
  ): string {
    return JSON.stringify({
      model: options.model ?? this.modelId,
      state: request.state,
      questions: request.questions,
    });
  }

  private readUsage(raw: any, modelId: string): DecisionUsage | null {
    const i = raw?.input_tokens;
    const o = raw?.output_tokens;
    if (!Number.isInteger(i) || i < 0 || !Number.isInteger(o) || o < 0) return null;
    return { modelId, inputTokens: i, outputTokens: o };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  const exp = Math.min(2_000, 250 * 2 ** attempt);
  return exp + Math.floor(Math.random() * 100);
}

function extractMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    const m = j?.message ?? j?.error?.message;
    if (typeof m === 'string') return m.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300);
}
