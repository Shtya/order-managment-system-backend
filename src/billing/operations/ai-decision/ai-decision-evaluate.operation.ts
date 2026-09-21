import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import {
  AllowanceGrant,
  AuthorizationRequirement,
  BillingOperationKey,
  BillingServiceKey,
  BillingUnit,
  ChargeResult,
} from "entities/billing.entity";
import { PricingSnapshot } from "entities/billing.entity";
import { BillingOperationStrategy } from "../billing-operation.strategy";
import {
  BillingConfigurationError,
  BillingValidationError,
} from "../../billing.errors";
import { AdminSettingsService } from "src/admin-settings/admin-settings.service";
import { AiDecisionBillingSettings } from "entities/adminSettings.entity";

export const AI_DECISION_BILLING_SETTINGS = Symbol(
  "AI_DECISION_BILLING_SETTINGS",
);

const DEFAULT_RESERVATION_SAFETY_MARGIN_PERCENT = 10;

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = canonicalize(value[k]);
    }
    return out;
  }
  return value;
}

export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

@Injectable()
export class AiDecisionEvaluateOperation extends BillingOperationStrategy<
  AiDecisionUsage,
  AiDecisionPricing
> {
  readonly service = BillingServiceKey.AI_DECISION;
  readonly operation = BillingOperationKey.EVALUATE;
  readonly primaryUnit = BillingUnit.TOKEN;

  private cachedSnapshot: PricingSnapshot | null = null;
  private cachedRevision = -1;
  private cachedMarginPercent = -1;

  constructor(
    private readonly adminSettings: AdminSettingsService,
  ) {
    super();
  }

  private reservationSafetyMarginPercent(): number {
    const raw = process.env.BILLING_RESERVATION_SAFETY_MARGIN_PERCENT;
    if (!raw) {
      return DEFAULT_RESERVATION_SAFETY_MARGIN_PERCENT;
    }
    const parsed = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      throw new BillingConfigurationError(
        "BILLING_RESERVATION_SAFETY_MARGIN_PERCENT must be an integer 0..100",
      );
    }
    return parsed;
  }

  //get the pricing snapshot from the admin settings
  async getSettingsSnapshot(): Promise<PricingSnapshot> {
    const revision = this.adminSettings.getCacheRevision();
    const marginPercent = this.reservationSafetyMarginPercent();
    if (
      this.cachedSnapshot &&
      this.cachedRevision === revision &&
      this.cachedMarginPercent === marginPercent
    ) {
      return this.cachedSnapshot;
    }

    const settings = await this.adminSettings.getSettings();
    const raw = settings?.billing?.aiDecision;
    if (!raw) {
      throw new BillingConfigurationError(
        "Billing pricing not configured: admin_settings.billing.aiDecision is missing",
      );
    }

    const snapshot = structuredClone(raw) as Record<string, unknown>;
    delete snapshot.reservationSafetyMarginBps;
    delete snapshot.reservationSafetyMarginPercent;
    snapshot.reservationSafetyMarginPercent = marginPercent;
    const version = createHash("sha256")
      .update(JSON.stringify(canonicalize(snapshot)))
      .digest("hex");

    this.cachedSnapshot = {
      version,
      capturedAt: new Date().toISOString(),
      rawSettings: snapshot,
    };
    this.cachedRevision = this.adminSettings.getCacheRevision();
    this.cachedMarginPercent = marginPercent;
    return this.cachedSnapshot;
  }

  // Decimal dollars per 1M tokens -> micros (1 dollar = 1,000,000 micros).
  private toMicrosPerMillion(value: unknown, field: string): bigint {
    if (typeof value === "bigint") {
      if (value < 0n) throw new Error(`${field} must be >= 0`);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${field} must be a non-negative decimal`);
      }
      return BigInt(Math.round(value * 1000000));
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!/^\d+(\.\d+)?$/.test(trimmed)) {
        throw new Error(`${field} must be a non-negative decimal string`);
      }
      return BigInt(Math.round(Number(trimmed) * 1000000));
    }
    throw new Error(`${field} must be a decimal price`);
  }

  //parse the pricing from the raw data
  parsePricing(raw: AiDecisionBillingSettings & { reservationSafetyMarginPercent: number }): AiDecisionPricing {
    try {
      // Legacy fallback: rows stored before the single-price migration only
      // have inputPerMillion.
      const legacy = raw as AiDecisionBillingSettings & {
        inputPerMillion?: unknown;
      };
      const tokenPriceMicros = this.toMicrosPerMillion(
        raw.tokenPrice ?? legacy.inputPerMillion,
        "tokenPrice",
      );

      let reservationSafetyMarginPercent = 10;
      if (raw.reservationSafetyMarginPercent !== undefined && raw.reservationSafetyMarginPercent !== null) {
        const v = raw.reservationSafetyMarginPercent;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) {
          throw new Error("reservationSafetyMarginPercent must be an integer 0..100");
        }
        reservationSafetyMarginPercent = v;
      }

      let allowance: AiDecisionAllowance | null = { units: 0n, durationDays: null };
      if (raw.allowance === null) {
        allowance = null;
      } else if (raw.allowance !== undefined) {
        allowance = { units: BigInt(raw.allowance.units ?? 0), durationDays: raw.allowance.durationDays };
      }

      return {
        tokenPriceMicros,
        reservationSafetyMarginPercent,
        allowance,
      };
    } catch (err: any) {
      throw new BillingConfigurationError(
        `Invalid AI decision pricing: ${err?.message ?? err}`,
      );
    }
  }

  parseUsage(raw: unknown): AiDecisionUsage {
    try {
      if (!raw || typeof raw !== "object") {
        throw new Error("usage must be an object");
      }
      const r = raw as Record<string, unknown>;
      return {
        inputTokens: toTokens(r.inputTokens ?? 0, "inputTokens"),
        outputTokens: toTokens(r.outputTokens ?? 0, "outputTokens"),
      };
    } catch (err: any) {
      throw new BillingValidationError(
        `Invalid AI decision usage: ${err?.message ?? err}`,
      );
    }
  }

  allowancePolicy(pricing: AiDecisionPricing): {
    capUnits: bigint | null;
    durationDays: number | null;
    reservationSafetyMarginPercent: number;
  } {
    if (pricing.allowance === null) {
      return {
        capUnits: null,
        durationDays: null,
        reservationSafetyMarginPercent: pricing.reservationSafetyMarginPercent,
      };
    }
    return {
      capUnits: pricing.allowance.units,
      durationDays: pricing.allowance.durationDays,
      reservationSafetyMarginPercent: pricing.reservationSafetyMarginPercent,
    };
  }

  //It answers one question before the AI runs: how much should we lock in the wallet, and how many tokens is that?
  authorizationRequirement(
    estimated: AiDecisionUsage,
    pricing: AiDecisionPricing,
  ): AuthorizationRequirement {
    // Unlimited free allowance reserves nothing.
    if (pricing.allowance === null) {
      return {
        maxAmount: 0n,
        maxUnits: {
          unit: BillingUnit.TOKEN,
          quantity: estimated.inputTokens + estimated.outputTokens,
        },
      };
    }
    const million = 1000000n;
    const base =
      ceilDiv(estimated.inputTokens * pricing.tokenPriceMicros, million) +
      ceilDiv(estimated.outputTokens * pricing.tokenPriceMicros, million);
    const percent = BigInt(pricing.reservationSafetyMarginPercent);
    const maxAmount = ceilDiv(base * (100n + percent), 100n);
    return {
      maxAmount,
      maxUnits: {
        unit: BillingUnit.TOKEN,
        quantity: estimated.inputTokens + estimated.outputTokens,
      },
    };
  }

  calculateCharge(
    actual: AiDecisionUsage,
    pricing: AiDecisionPricing,
    allowance: AllowanceGrant,
  ): ChargeResult {
    const million = 1000000n;

    // Unlimited free allowance covers everything.
    if (pricing.allowance === null) {
      const total = actual.inputTokens + actual.outputTokens;
      return {
        lines: [
          {
            meter: "INPUT_TOKENS",
            unit: BillingUnit.TOKEN,
            quantity: actual.inputTokens,
            freeQuantity: actual.inputTokens,
            unitPricePerMillion: pricing.tokenPriceMicros,
            amount: 0n,
          },
          {
            meter: "OUTPUT_TOKENS",
            unit: BillingUnit.TOKEN,
            quantity: actual.outputTokens,
            freeQuantity: actual.outputTokens,
            unitPricePerMillion: pricing.tokenPriceMicros,
            amount: 0n,
          },
        ],
        grossAmount:
          ceilDiv(actual.inputTokens * pricing.tokenPriceMicros, million) +
          ceilDiv(actual.outputTokens * pricing.tokenPriceMicros, million),
        payableAmount: 0n,
        allowanceUnitsConsumed: total,
      };
    }

    const inputGross = ceilDiv(actual.inputTokens * pricing.tokenPriceMicros, million);
    const outputGross = ceilDiv(actual.outputTokens * pricing.tokenPriceMicros, million);
    const grossAmount = inputGross + outputGross;

    // Free units cover input first, then output.
    let remaining = allowance?.remainingUnits ?? 0n;
    if (remaining < 0n) remaining = 0n;
    const consume = (qty: bigint): bigint => {
      const take = remaining < qty ? remaining : qty;
      remaining -= take;
      return take;
    };
    const freeInput = consume(actual.inputTokens);
    const freeOutput = consume(actual.outputTokens);

    const inputAmount = ceilDiv((actual.inputTokens - freeInput) * pricing.tokenPriceMicros, million);
    const outputAmount = ceilDiv((actual.outputTokens - freeOutput) * pricing.tokenPriceMicros, million);
    const payableAmount = inputAmount + outputAmount;

    return {
      lines: [
        {
          meter: "INPUT_TOKENS",
          unit: BillingUnit.TOKEN,
          quantity: actual.inputTokens,
          freeQuantity: freeInput,
          unitPricePerMillion: pricing.tokenPriceMicros,
          amount: inputAmount,
        },
        {
          meter: "OUTPUT_TOKENS",
          unit: BillingUnit.TOKEN,
          quantity: actual.outputTokens,
          freeQuantity: freeOutput,
          unitPricePerMillion: pricing.tokenPriceMicros,
          amount: outputAmount,
        },
      ],
      grossAmount,
      payableAmount,
      allowanceUnitsConsumed: freeInput + freeOutput,
    };
  }
}

export interface AiDecisionUsage {
  inputTokens: bigint;
  outputTokens: bigint;
}

export interface AiDecisionAllowance {
  units: bigint;
  durationDays: number | null;
}

export interface AiDecisionPricing {
  tokenPriceMicros: bigint;
  reservationSafetyMarginPercent: number;
  // Null = not limited (unlimited free).
  allowance: AiDecisionAllowance | null;
}

function toTokens(value: unknown, field: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${field} must be >= 0`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative integer`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`${field} must be a non-negative integer string`);
    }
    return BigInt(trimmed);
  }
  throw new Error(`${field} must be tokens as bigint/number/string`);
}