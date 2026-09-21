import { describe, expect, test, vi } from "vitest";
import { BillingUnit } from "entities/billing.entity";

vi.mock("src/admin-settings/admin-settings.service", () => ({
  AdminSettingsService: class AdminSettingsService {},
}));
import { AiDecisionEvaluateOperation } from "./ai-decision-evaluate.operation";

const pricing = {
  tokenPrice: 1,
  reservationSafetyMarginPercent: 10,
  allowance: { units: 0, durationDays: null },
};

const noAllowance = { unit: BillingUnit.TOKEN, remainingUnits: 0n };

describe("AiDecisionEvaluateOperation", () => {
  //mock the admin settings service
  const op = new AiDecisionEvaluateOperation({
    getSettings: vi.fn(),
  } as never);

  test("ceil rounding per line: 1 token at $1/1M = 1 micro", () => {
    const parsed = op.parsePricing(pricing);
    const charge = op.calculateCharge(
      { inputTokens: 1n, outputTokens: 1n },
      parsed,
      noAllowance,
    );
    expect(charge.lines[0].amount).toBe(1n);
    expect(charge.lines[1].amount).toBe(1n);
    expect(charge.grossAmount).toBe(2n);
    expect(charge.payableAmount).toBe(2n);
  });

  test("zero usage bills zero", () => {
    const parsed = op.parsePricing(pricing);
    const charge = op.calculateCharge(
      { inputTokens: 0n, outputTokens: 0n },
      parsed,
      noAllowance,
    );
    expect(charge.grossAmount).toBe(0n);
    expect(charge.payableAmount).toBe(0n);
  });

  test("allowance covers input first, then billable output", () => {
    const parsed = op.parsePricing(pricing);
    // single price: 10 free units cover input first
    const charge = op.calculateCharge(
      { inputTokens: 100n, outputTokens: 10n },
      parsed,
      { unit: BillingUnit.TOKEN, remainingUnits: 10n },
    );
    expect(charge.lines[0].freeQuantity).toBe(10n);
    expect(charge.lines[1].freeQuantity).toBe(0n);
    expect(charge.allowanceUnitsConsumed).toBe(10n);
  });

  test("legacy dual-price rows fall back to the input price", () => {
    const parsed = op.parsePricing({ inputPerMillion: 1 } as never);
    const charge = op.calculateCharge(
      { inputTokens: 1n, outputTokens: 1n },
      parsed,
      noAllowance,
    );
    expect(charge.payableAmount).toBe(2n);
  });

  test("huge numbers stay exact with bigint", () => {
    const parsed = op.parsePricing(pricing);
    const qty = 1000000000000n;
    const charge = op.calculateCharge(
      { inputTokens: qty, outputTokens: 0n },
      parsed,
      noAllowance,
    );
    expect(charge.lines[0].amount).toBe(qty);
  });

  test("null allowance is unlimited: reserves and charges zero", () => {
    const parsed = op.parsePricing({ ...pricing, allowance: null });
    const req = op.authorizationRequirement(
      { inputTokens: 1000000n, outputTokens: 0n },
      parsed,
    );
    expect(req.maxAmount).toBe(0n);
    const charge = op.calculateCharge(
      { inputTokens: 100n, outputTokens: 10n },
      parsed,
      noAllowance,
    );
    expect(charge.payableAmount).toBe(0n);
    expect(charge.allowanceUnitsConsumed).toBe(110n);
  });

  test("authorization adds 10% safety margin", () => {
    const parsed = op.parsePricing(pricing);
    const req = op.authorizationRequirement(
      { inputTokens: 1000000n, outputTokens: 0n },
      parsed,
    );
    // 1M tokens at $1/1M = $1 = 1_000_000 micros, plus 10% = 1_100_000
    expect(req.maxAmount).toBe(1_100_000n);
    expect(req.maxUnits.quantity).toBe(1000000n);
  });

  test("pricing parser rejects negative prices", () => {
    expect(() => op.parsePricing({ ...pricing, tokenPrice: -1 })).toThrow();
    expect(() => op.parsePricing(null)).toThrow();
  });

  test("settings snapshot is reused until cache revision changes", async () => {
    const settings = {
      billing: { aiDecision: pricing },
    };
    let revision = 0;
    const adminSettings = {
      getCacheRevision: () => revision,
      getSettings: vi.fn(async () => settings),
    };
    const cachedOp = new AiDecisionEvaluateOperation(adminSettings as never);

    const first = await cachedOp.getSettingsSnapshot();
    const second = await cachedOp.getSettingsSnapshot();
    expect(second).toBe(first);
    expect(adminSettings.getSettings).toHaveBeenCalledTimes(1);

    revision = 1;
    const third = await cachedOp.getSettingsSnapshot();
    expect(third).not.toBe(first);
    expect(adminSettings.getSettings).toHaveBeenCalledTimes(2);
  });
});
