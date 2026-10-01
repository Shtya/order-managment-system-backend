import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  BillingChargeEntity,
  BillingOperationKey,
  BillingServiceKey,
} from 'entities/billing.entity';
import { BillingService } from 'src/billing/billing.service';
import { AiUsageLedgerService } from 'src/ai/usage/ai-usage-ledger.service';
import {
  AiUsageActor,
  AiUsageBilledBy,
  AiUsageSource,
  AiUsageStatus,
} from 'entities/ai-usage.entity';
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
    private readonly usageLedger: AiUsageLedgerService,
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
      await this.settleAfterProviderError(auth.authorizationId, err, adminId, input, estimated);
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

    let charge: BillingChargeEntity | null = null;
    try {
      charge = await this.billing.finalize({
        authorizationId: auth.authorizationId,
        usage: result.usage,
      });
    } catch (billingErr) {
      this.logger.error(
        `finalize failed after a successful decision (authorizationId=${auth.authorizationId})`,
        billingErr instanceof Error ? billingErr.stack : String(billingErr),
      );
    }
    await this.recordUsage(adminId, input, result.usage, charge, AiUsageStatus.OK);
    return replay;
  }

  private async settleAfterProviderError(
    authorizationId: string,
    err: unknown,
    adminId: string,
    input: AiDecisionInput<any>,
    estimated: { modelId?: string; inputTokens?: number; outputTokens?: number },
  ) {
    try {
      if (err instanceof ProviderChargedError) {
        const charge = await this.billing.finalize({ authorizationId, usage: err.usage });
        await this.recordUsage(adminId, input, err.usage, charge, AiUsageStatus.OK);
        return;
      }
      if (err instanceof ProviderTimeoutError) {
        this.logger.warn(`UNKNOWN_OUTCOME authorizationId=${authorizationId}`);
        await this.billing.release({ authorizationId, reason: 'PROVIDER_TIMEOUT' });
        await this.recordUsage(adminId, input, estimated, null, AiUsageStatus.RELEASED);
        return;
      }
      await this.billing.release({ authorizationId, reason: 'PROVIDER_ERROR' });
      await this.recordUsage(adminId, input, estimated, null, AiUsageStatus.RELEASED);
    } catch (billingErr) {
      this.logger.error(
        `billing settle failed (authorizationId=${authorizationId})`,
        billingErr instanceof Error ? billingErr.stack : String(billingErr),
      );
    }
  }

  private async recordUsage(
    adminId: string,
    input: AiDecisionInput<any>,
    usage: { modelId?: string; inputTokens?: number; outputTokens?: number },
    charge: BillingChargeEntity | null,
    status: AiUsageStatus,
  ) {
    await this.usageLedger.record({
      adminId,
      source: AiUsageSource.ADDRESS_CHECK,
      api: 'aiDecision.decide',
      actor: input.feature?.startsWith('automation')
        ? AiUsageActor.SYSTEM
        : AiUsageActor.DEVELOPER,
      billedBy: AiUsageBilledBy.MADAR,
      providerCode: 'jev',
      modelCode: usage?.modelId ?? input.model ?? null,
      inputTokens: Number(usage?.inputTokens ?? 0),
      outputTokens: Number(usage?.outputTokens ?? 0),
      rounds: 1,
      status,
      grossAmount: charge?.grossAmount ?? 0n,
      payableAmount: charge?.payableAmount ?? 0n,
      freeUnits: charge?.allowanceUnitsConsumed ?? 0n,
      chargeId: charge?.id ?? null,
      idempotencyKey: input.idempotencyKey,
    });
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
