import { Inject, Injectable, Provider } from "@nestjs/common";
import {
  BillingOperationKey,
  BillingServiceKey,
} from "entities/billing.entity";
import { BillingOperationNotFoundError } from "../billing.errors";
import { BillingOperationStrategy } from "./billing-operation.strategy";
import { AiDecisionEvaluateOperation } from "./ai-decision/ai-decision-evaluate.operation";

export const BILLING_OPERATIONS = Symbol("BILLING_OPERATIONS");

export const billingOperationProviders: Provider[] = [
  AiDecisionEvaluateOperation,
  {
    provide: BILLING_OPERATIONS,
    useFactory: (aiDecision: AiDecisionEvaluateOperation) => [aiDecision],
    inject: [AiDecisionEvaluateOperation],
  },
];

@Injectable()
export class BillingOperationRegistry {
  private readonly map = new Map<
    string,
    BillingOperationStrategy<unknown, unknown>
  >();

  constructor(
    @Inject(BILLING_OPERATIONS)
    operations: BillingOperationStrategy<unknown, unknown>[],
  ) {
    for (const op of operations ?? []) {
      const key = `${op.service}:${op.operation}`;
      if (this.map.has(key)) {
        throw new Error(`Duplicate billing operation ${key}`);
      }
      this.map.set(key, op);
    }
  }

  get(
    service: BillingServiceKey,
    operation: BillingOperationKey,
  ): BillingOperationStrategy<unknown, unknown> {
    const op = this.map.get(`${service}:${operation}`);
    if (!op) {
      throw new BillingOperationNotFoundError(service, operation);
    }
    return op;
  }
}
