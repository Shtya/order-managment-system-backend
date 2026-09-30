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
import { AiMediaBillingSettings } from "entities/adminSettings.entity";
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
export class AiMediaProcessOperation extends BillingOperationStrategy<
  AiMediaUsage,
  AiMediaPricing
> {
  readonly service = BillingServiceKey.AI_MEDIA;
  readonly operation = BillingOperationKey.PROCESS;
  readonly primaryUnit = BillingUnit.TOKEN;

  private cachedSnapshot: PricingSnapshot | null = null;
  private cachedRevision = -1;
  private cachedMarginPercent = -1;

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
    const raw = settings?.billing?.aiMedia ?? {
      tokenPrice: 0.5,
      audioMinutePrice: 0.006,
      allowance: { units: 0, durationDays: null },
    };

    const snapshot = structuredClone(raw) as Record<string, unknown>;
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
    this.cachedRevision = revision;
    this.cachedMarginPercent = marginPercent;
    return this.cachedSnapshot;
  }

  private toMicros(value: unknown, field: string): bigint {
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

  parsePricing(
    raw: AiMediaBillingSettings & { reservationSafetyMarginPercent?: number },
  ): AiMediaPricing {
    try {
      const tokenPriceMicros = this.toMicros(raw.tokenPrice ?? 0.5, "tokenPrice");
      const audioMinutePriceMicros = this.toMicros(
        raw.audioMinutePrice ?? 0.006,
        "audioMinutePrice",
      );
      let reservationSafetyMarginPercent = 10;
      if (
        raw.reservationSafetyMarginPercent !== undefined &&
        raw.reservationSafetyMarginPercent !== null
      ) {
        const v = raw.reservationSafetyMarginPercent;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) {
          throw new Error("reservationSafetyMarginPercent must be an integer 0..100");
        }
        reservationSafetyMarginPercent = v;
      }
      let allowance: { units: bigint; durationDays: number | null } | null = {
        units: 0n,
        durationDays: null,
      };
      if (raw.allowance === null) allowance = null;
      else if (raw.allowance !== undefined) {
        allowance = {
          units: BigInt(raw.allowance.units ?? 0),
          durationDays: raw.allowance.durationDays ?? null,
        };
      }
      return {
        tokenPriceMicros,
        audioMinutePriceMicros,
        reservationSafetyMarginPercent,
        allowance,
      };
    } catch (err: any) {
      throw new BillingConfigurationError(
        `Invalid AI media pricing: ${err?.message ?? err}`,
      );
    }
  }

  parseUsage(raw: unknown): AiMediaUsage {
    try {
      if (!raw || typeof raw !== "object") throw new Error("usage must be an object");
      const r = raw as Record<string, unknown>;
      return {
        inputTokens: toNonNegInt(r.inputTokens ?? 0, "inputTokens"),
        outputTokens: toNonNegInt(r.outputTokens ?? 0, "outputTokens"),
        audioSeconds: toNonNegInt(r.audioSeconds ?? 0, "audioSeconds"),
      };
    } catch (err: any) {
      throw new BillingValidationError(
        `Invalid AI media usage: ${err?.message ?? err}`,
      );
    }
  }

  allowancePolicy(pricing: AiMediaPricing) {
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
    estimated: AiMediaUsage,
    pricing: AiMediaPricing,
  ): AuthorizationRequirement {
    const tokenQty = estimated.inputTokens + estimated.outputTokens;
    if (pricing.allowance === null) {
      return {
        maxAmount: 0n,
        maxUnits: { unit: BillingUnit.TOKEN, quantity: tokenQty },
      };
    }
    const million = 1_000_000n;
    const tokenBase =
      ceilDiv(estimated.inputTokens * pricing.tokenPriceMicros, million) +
      ceilDiv(estimated.outputTokens * pricing.tokenPriceMicros, million);
    const audioBase = ceilDiv(
      estimated.audioSeconds * pricing.audioMinutePriceMicros,
      60n,
    );
    const percent = BigInt(pricing.reservationSafetyMarginPercent);
    const maxAmount = ceilDiv((tokenBase + audioBase) * (100n + percent), 100n);
    return {
      maxAmount,
      maxUnits: { unit: BillingUnit.TOKEN, quantity: tokenQty },
    };
  }

  calculateCharge(
    actual: AiMediaUsage,
    pricing: AiMediaPricing,
    allowance: AllowanceGrant,
  ): ChargeResult {
    const million = 1_000_000n;
    const audioGross = ceilDiv(
      actual.audioSeconds * pricing.audioMinutePriceMicros,
      60n,
    );
    const inputGross = ceilDiv(actual.inputTokens * pricing.tokenPriceMicros, million);
    const outputGross = ceilDiv(actual.outputTokens * pricing.tokenPriceMicros, million);
    const grossAmount = inputGross + outputGross + audioGross;
    const audioPricePerMillionSeconds = ceilDiv(
      pricing.audioMinutePriceMicros * million,
      60n,
    );

    if (pricing.allowance === null) {
      const total = actual.inputTokens + actual.outputTokens;
      return {
        lines: [
          tokenLine("INPUT_TOKENS", actual.inputTokens, actual.inputTokens, pricing.tokenPriceMicros, 0n),
          tokenLine("OUTPUT_TOKENS", actual.outputTokens, actual.outputTokens, pricing.tokenPriceMicros, 0n),
          {
            meter: "AUDIO_SECONDS",
            unit: BillingUnit.AUDIO_SECOND,
            quantity: actual.audioSeconds,
            freeQuantity: actual.audioSeconds,
            unitPricePerMillion: audioPricePerMillionSeconds,
            amount: 0n,
          },
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
      (actual.inputTokens - freeInput) * pricing.tokenPriceMicros,
      million,
    );
    const outputAmount = ceilDiv(
      (actual.outputTokens - freeOutput) * pricing.tokenPriceMicros,
      million,
    );
    const payableAmount = inputAmount + outputAmount + audioGross;

    return {
      lines: [
        tokenLine("INPUT_TOKENS", actual.inputTokens, freeInput, pricing.tokenPriceMicros, inputAmount),
        tokenLine("OUTPUT_TOKENS", actual.outputTokens, freeOutput, pricing.tokenPriceMicros, outputAmount),
        {
          meter: "AUDIO_SECONDS",
          unit: BillingUnit.AUDIO_SECOND,
          quantity: actual.audioSeconds,
          freeQuantity: 0n,
          unitPricePerMillion: audioPricePerMillionSeconds,
          amount: audioGross,
        },
      ],
      grossAmount,
      payableAmount,
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

function toNonNegInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${field} must be >= 0`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${field} must be a non-negative number`);
    }
    return BigInt(Math.round(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error(`${field} must be a non-negative number string`);
    }
    return BigInt(Math.round(Number(trimmed)));
  }
  throw new Error(`${field} must be an integer`);
}

export interface AiMediaUsage {
  inputTokens: bigint;
  outputTokens: bigint;
  audioSeconds: bigint;
}

export interface AiMediaPricing {
  tokenPriceMicros: bigint;
  audioMinutePriceMicros: bigint;
  reservationSafetyMarginPercent: number;
  allowance: { units: bigint; durationDays: number | null } | null;
}
