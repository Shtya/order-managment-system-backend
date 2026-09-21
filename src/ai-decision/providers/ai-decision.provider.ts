import type {
  DecideOptions,
  DecideRequest,
  DecideResult,
  DecisionUsage,
  QuestionMap,
} from '../ai-decision.types';

/**
 * Contract every decision provider implements (Jev today, another model later).
 *
 * It is an abstract class, not an interface, so it can be used directly as the
 * NestJS injection token:  constructor(private readonly provider: AiDecisionProvider)
 *
 * A provider knows NOTHING about wallets, pricing or billing. It only:
 *   1. validates and estimates a request (estimateUsage),
 *   2. sends it and returns typed answers plus the real usage (decide).
 */
export abstract class AiDecisionProvider {
  /** Short provider name, e.g. "jev". */
  abstract readonly name: string;

  /**
   * Default model id. Use a PINNED version (e.g. "jev-1.13.0"): confidence
   * thresholds are tuned per version, and this id is also the key used to look
   * up the price in the Super Admin billing config.
   */
  abstract readonly modelId: string;

  /**
   * Validates the request and estimates its cost driver (input tokens) WITHOUT
   * calling the provider. Called before billing.authorize().
   *
   * @throws AiDecisionValidationError       malformed request
   * @throws AiDecisionInputTooLargeError    over the provider's context limit
   */
  abstract estimateUsage<Q extends QuestionMap>(
    request: DecideRequest<Q>,
    options?: DecideOptions,
  ): DecisionUsage;

  /**
   * Sends the request and returns typed answers plus the real usage.
   *
   * @throws AiDecisionValidationError  malformed request
   * @throws ProviderChargedError       processed and billed, but unusable result
   * @throws ProviderTimeoutError       unknown outcome
   * @throws ProviderError              anything else (not processed)
   */
  abstract decide<Q extends QuestionMap>(
    request: DecideRequest<Q>,
    options?: DecideOptions,
  ): Promise<DecideResult<Q>>;
}
