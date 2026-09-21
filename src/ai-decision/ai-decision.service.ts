import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  BillingOperationKey,
  BillingServiceKey,
} from 'entities/billing.entity';
import { BillingService } from 'src/billing/billing.service';
import { BillingConflictError } from 'src/billing/billing.errors';
import { tenantId } from 'src/category/category.service';
import { AiDecisionProvider } from './providers/ai-decision.provider';
import {
  AiDecisionInputTooLargeError,
  AiDecisionValidationError,
  ProviderChargedError,
  ProviderError,
  ProviderRateLimitedError,
  ProviderTimeoutError,
} from './ai-decision.errors';
import type {
  DecisionAnswers,
  DecisionState,
  QuestionMap,
} from './ai-decision.types';

export interface AiDecisionInput<Q extends QuestionMap> {
  me: any;
  /** Same key on every retry of this logical call, e.g. `${runId}:${stepId}:address-check`. */
  idempotencyKey: string;
  /** What to judge: text or structured data. */
  state: DecisionState;
  /** Any number and mix of noul / choice / score questions. */
  questions: Q;
  feature?: string;
  /**
   * Translation key (e.g. domains.automation.ai_address_completeness) or a
   * display title. Billing finalize appends this to the AI-usage wallet note.
   */
  note?: string;
  /** Optional per-call model override (pinned version). */
  model?: string;
}

@Injectable()
export class AiDecisionService {
  private readonly logger = new Logger(AiDecisionService.name);

  constructor(
    private readonly billing: BillingService,
    private readonly provider: AiDecisionProvider, // Jev today; not billing
  ) { }

  async decide<Q extends QuestionMap>(
    input: AiDecisionInput<Q>,
  ): Promise<{ answers: DecisionAnswers<Q>; modelVersion: string }> {
    
    const adminId = tenantId(input.me);
    const request = { state: input.state, questions: input.questions };
    const options = input.model ? { model: input.model } : undefined;
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          state: input.state,
          questions: input.questions,
          model: input.model ?? '',
        }),
      )
      .digest('hex');

    // Validates the request and estimates input tokens. Throws BEFORE anything
    // is reserved, so a bad request never touches the wallet.
    let estimated;
    try {
      estimated = this.provider.estimateUsage(request, options);
    } catch (err) {
      throw this.toHttpException(err);
    }

    const auth = await this.billing.authorize({
      adminId,
      service: BillingServiceKey.AI_DECISION,
      operation: BillingOperationKey.EVALUATE,
      idempotencyKey: input.idempotencyKey,
      estimatedUsage: estimated,
      context: {
        feature: input.feature ?? 'ai-decision',
        requestHash,
        ...(input.note ? { note: input.note } : {}),
      },
    });

    if (auth.authorized === false) {
      throw new HttpException(
        {
          message: 'Insufficient wallet balance',
          required: auth.required.toString(),
          available: auth.available.toString(),
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    if (auth.replay) {
      if (auth.replayPayload?.answers != null) {
        return auth.replayPayload as {
          answers: DecisionAnswers<Q>;
          modelVersion: string;
        };
      }
      throw new BillingConflictError(
        `Idempotency key already used: ${input.idempotencyKey}`,
      );
    }

    let result;
    try {
      result = await this.provider.decide(request, options);
    } catch (err) {
      await this.settleAfterProviderError(auth.authorizationId, err);
      throw err;
    }

    const replay = {
      answers: result.answers,
      modelVersion: result.modelVersion,
    };
    try {
      await this.billing.saveDecisionReplay(auth.authorizationId, replay);
    } catch (err) {
      this.logger.error(
        `failed to persist idempotent result (authorizationId=${auth.authorizationId})`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    try {
      await this.billing.finalize({
        authorizationId: auth.authorizationId,
        usage: result.usage,
      });
    } catch (billingErr) {
      this.logger.error(
        `finalize failed after a successful decision (authorizationId=${auth.authorizationId})`,
        billingErr instanceof Error ? billingErr.stack : String(billingErr),
      );
    }

    return replay;
  }

  /** Never throws: the caller rethrows the original provider error. */
  private async settleAfterProviderError(authorizationId: string, err: unknown) {
    try {
      if (err instanceof ProviderChargedError) {
        await this.billing.finalize({ authorizationId, usage: err.usage });
        return;
      }
      if (err instanceof ProviderTimeoutError) {
        this.logger.warn(`UNKNOWN_OUTCOME authorizationId=${authorizationId}`);
        await this.billing.release({ authorizationId, reason: 'PROVIDER_TIMEOUT' });
        return;
      }
      await this.billing.release({ authorizationId, reason: 'PROVIDER_ERROR' });
    } catch (billingErr) {
      this.logger.error(
        `billing settle failed (authorizationId=${authorizationId})`,
        billingErr instanceof Error ? billingErr.stack : String(billingErr),
      );
    }
  }

  toHttpException(err: unknown): unknown {
    if (err instanceof AiDecisionValidationError) {
      return new HttpException(
        { message: err.message, issues: err.issues },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (err instanceof AiDecisionInputTooLargeError) {
      return new HttpException(
        { message: err.message },
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    if (err instanceof HttpException) return err;

    if (err instanceof ProviderRateLimitedError) {
      return new HttpException(
        { message: err.message, code: err.code },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (err instanceof ProviderTimeoutError) {
      return new HttpException(
        { message: err.message, code: err.code },
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    if (err instanceof ProviderError) {
      return new HttpException(
        { message: err.message, code: err.code },
        HttpStatus.BAD_GATEWAY,
      );
    }
    return err;
  }
}
