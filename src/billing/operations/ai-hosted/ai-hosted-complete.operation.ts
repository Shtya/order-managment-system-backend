import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import {
  AllowanceGrant,
  AuthorizationRequirement,
  BillingOperationKey,
  BillingServiceKey,
  BillingUnit,
  ChargeResult,
  PricingSnapshot,
} from "entities/billing.entity";
import { BillingOperationStrategy } from "../billing-operation.strategy";
import {
  BillingConfigurationError,
  BillingValidationError,
} from "../../billing.errors";
import { AdminSettingsService } from "src/admin-settings/admin-settings.service";
import { ceilDiv } from "../ai-decision/ai-decision-evaluate.operation";

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

@Injectable()
export class AiHostedCompleteOperation extends BillingOperationStrategy<
  AiHostedUsage,
  AiHostedPricing
> {
  readonly service = BillingServiceKey.AI_HOSTED;
  readonly operation = BillingOperationKey.COMPLETE;
  readonly primaryUnit = BillingUnit.TOKEN;

  constructor(private readonly adminSettings: AdminSettingsService) {
    super();
  }

  private reservationSafetyMarginPercent(): number {
    const raw = process.env.BILLING_RESERVATION_SAFETY_MARGIN_PERCENT;
    if (!raw) return DEFAULT_RESERVATION_SAFETY_MARGIN_PERCENT;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      throw new BillingConfigurationError(
        "BILLING_RESERVATION_SAFETY_MARGIN_PERCENT must be an integer 0..100",
      );
    }
    return parsed;
  }

  async getSettingsSnapshot(): Promise<PricingSnapshot> {
    const settings = await this.adminSettings.getSettings();
    const hosted = settings?.billing?.aiHosted;
    const snapshot = {
      inputTokenPrice: hosted?.inputTokenPrice ?? 0,
      outputTokenPrice: hosted?.outputTokenPrice ?? 0,
      allowance: settings?.billing?.aiHosted?.allowance ?? { units: 0 },
      allowanceAnchorDate: settings?.billing?.allowanceAnchorDate ?? null,
      allowanceDurationDays: settings?.billing?.allowanceDurationDays ?? null,
      reservationSafetyMarginPercent: this.reservationSafetyMarginPercent(),
    };
    const version = createHash("sha256")
      .update(JSON.stringify(canonicalize(snapshot)))
      .digest("hex");
    return {
      version,
      capturedAt: new Date().toISOString(),
      rawSettings: snapshot,
    };
  }

  private toMicrosPerMillion(value: unknown, field: string): bigint {
    if (typeof value === "bigint") {
      if (value < 0n) throw new Error(`${field} must be >= 0`);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${field} must be a non-negative decimal`);
      }
      return BigInt(Math.round(value * 1_000_000));
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!/^\d+(\.\d+)?$/.test(trimmed)) {
        throw new Error(`${field} must be a non-negative decimal string`);
      }
      return BigInt(Math.round(Number(trimmed) * 1_000_000));
    }
    throw new Error(`${field} must be a decimal price`);
  }

  parsePricing(raw: unknown): AiHostedPricing {
    try {
      if (!raw || typeof raw !== "object") throw new Error("pricing missing");
      const r = raw as Record<string, unknown> & {
        tokenPrice?: number;
        inputTokenPrice?: number;
        outputTokenPrice?: number;
        allowance?: { units?: number } | null;
        allowanceDurationDays?: number | null;
        reservationSafetyMarginPercent?: number;
      };
      const inputTokenPriceMicros = this.toMicrosPerMillion(
        r.inputTokenPrice ?? r.tokenPrice ?? 0,
        "inputTokenPrice",
      );
      const outputTokenPriceMicros = this.toMicrosPerMillion(
        r.outputTokenPrice ?? r.tokenPrice ?? 0,
        "outputTokenPrice",
      );
      let reservationSafetyMarginPercent = 10;
      if (
        r.reservationSafetyMarginPercent !== undefined &&
        r.reservationSafetyMarginPercent !== null
      ) {
        const v = r.reservationSafetyMarginPercent;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) {
          throw new Error("reservationSafetyMarginPercent must be an integer 0..100");
        }
        reservationSafetyMarginPercent = v;
      }
      const durationDays = r.allowanceDurationDays ?? null;
      let allowance: { units: bigint; durationDays: number | null } | null = {
        units: 0n,
        durationDays,
      };
      if (r.allowance === null) allowance = null;
      else if (r.allowance !== undefined) {
        allowance = {
          units: BigInt(r.allowance.units ?? 0),
          durationDays,
        };
      }
      return {
        inputTokenPriceMicros,
        outputTokenPriceMicros,
        reservationSafetyMarginPercent,
        allowance,
      };
    } catch (err: any) {
      throw new BillingConfigurationError(
        `Invalid AI hosted pricing: ${err?.message ?? err}`,
      );
    }
  }

  parseUsage(raw: unknown): AiHostedUsage {
    try {
      if (!raw || typeof raw !== "object") throw new Error("usage must be an object");
      const r = raw as Record<string, unknown>;
      return {
        inputTokens: toTokens(r.inputTokens ?? 0, "inputTokens"),
        outputTokens: toTokens(r.outputTokens ?? 0, "outputTokens"),
      };
    } catch (err: any) {
      throw new BillingValidationError(
        `Invalid AI hosted usage: ${err?.message ?? err}`,
      );
    }
  }

  allowancePolicy(pricing: AiHostedPricing) {
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

  authorizationRequirement(
    estimated: AiHostedUsage,
    pricing: AiHostedPricing,
  ): AuthorizationRequirement {
    if (pricing.allowance === null) {
      return {
        maxAmount: 0n,
        maxUnits: {
          unit: BillingUnit.TOKEN,
          quantity: estimated.inputTokens + estimated.outputTokens,
        },
      };
    }
    const million = 1_000_000n;
    const base =
      ceilDiv(estimated.inputTokens * pricing.inputTokenPriceMicros, million) +
      ceilDiv(estimated.outputTokens * pricing.outputTokenPriceMicros, million);
    const percent = BigInt(pricing.reservationSafetyMarginPercent);
    return {
      maxAmount: ceilDiv(base * (100n + percent), 100n),
      maxUnits: {
        unit: BillingUnit.TOKEN,
        quantity: estimated.inputTokens + estimated.outputTokens,
      },
    };
  }

  calculateCharge(
    actual: AiHostedUsage,
    pricing: AiHostedPricing,
    allowance: AllowanceGrant,
  ): ChargeResult {
    const million = 1_000_000n;
    const inputGross = ceilDiv(
      actual.inputTokens * pricing.inputTokenPriceMicros,
      million,
    );
    const outputGross = ceilDiv(
      actual.outputTokens * pricing.outputTokenPriceMicros,
      million,
    );
    const grossAmount = inputGross + outputGross;

    if (pricing.allowance === null) {
      const total = actual.inputTokens + actual.outputTokens;
      return {
        lines: [
          tokenLine("INPUT_TOKENS", actual.inputTokens, actual.inputTokens, pricing.inputTokenPriceMicros, 0n),
          tokenLine("OUTPUT_TOKENS", actual.outputTokens, actual.outputTokens, pricing.outputTokenPriceMicros, 0n),
        ],
        grossAmount,
        payableAmount: 0n,
        allowanceUnitsConsumed: total,
      };
    }

    let remaining = allowance?.remainingUnits ?? 0n;
    if (remaining < 0n) remaining = 0n;
    const consume = (qty: bigint): bigint => {
      const take = remaining < qty ? remaining : qty;
      remaining -= take;
      return take;
    };
    const freeInput = consume(actual.inputTokens);
    const freeOutput = consume(actual.outputTokens);
    const inputAmount = ceilDiv(
      (actual.inputTokens - freeInput) * pricing.inputTokenPriceMicros,
      million,
    );
    const outputAmount = ceilDiv(
      (actual.outputTokens - freeOutput) * pricing.outputTokenPriceMicros,
      million,
    );
    return {
      lines: [
        tokenLine("INPUT_TOKENS", actual.inputTokens, freeInput, pricing.inputTokenPriceMicros, inputAmount),
        tokenLine("OUTPUT_TOKENS", actual.outputTokens, freeOutput, pricing.outputTokenPriceMicros, outputAmount),
      ],
      grossAmount,
      payableAmount: inputAmount + outputAmount,
      allowanceUnitsConsumed: freeInput + freeOutput,
    };
  }
}

function tokenLine(
  meter: string,
  quantity: bigint,
  freeQuantity: bigint,
  unitPricePerMillion: bigint,
  amount: bigint,
) {
  return {
    meter,
    unit: BillingUnit.TOKEN,
    quantity,
    freeQuantity,
    unitPricePerMillion,
    amount,
  };
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

export interface AiHostedUsage {
  inputTokens: bigint;
  outputTokens: bigint;
}

export interface AiHostedPricing {
  inputTokenPriceMicros: bigint;
  outputTokenPriceMicros: bigint;
  reservationSafetyMarginPercent: number;
  allowance: { units: bigint; durationDays: number | null } | null;
}
