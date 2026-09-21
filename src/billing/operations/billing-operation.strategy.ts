import {
  AllowanceGrant,
  AuthorizationRequirement,
  BillingOperationKey,
  BillingServiceKey,
  BillingUnit,
  ChargeResult,
  PricingSnapshot,
} from "entities/billing.entity";

export abstract class BillingOperationStrategy<TUsage, TPricing> {
  abstract readonly service: BillingServiceKey;
  abstract readonly operation: BillingOperationKey;
  abstract readonly primaryUnit: BillingUnit;

  abstract getSettingsSnapshot(): Promise<PricingSnapshot>;
  abstract parsePricing(raw: unknown): TPricing;
  abstract parseUsage(raw: unknown): TUsage;
  abstract allowancePolicy(pricing: TPricing): {
    capUnits: bigint | null;
    durationDays: number | null;
    reservationSafetyMarginPercent: number;
  };
  //It answers one question before the runs: how much should we lock in the wallet, and for ai how many tokens is that?
  abstract authorizationRequirement(
    estimated: TUsage,
    pricing: TPricing,
  ): AuthorizationRequirement;
  abstract calculateCharge(
    actual: TUsage,
    pricing: TPricing,
    allowance: AllowanceGrant,
  ): ChargeResult;
}
