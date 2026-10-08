import { describe, expect, test, vi } from "vitest";
import { BillingUnit } from "entities/billing.entity";

vi.mock("src/admin-settings/admin-settings.service", () => ({
  AdminSettingsService: class AdminSettingsService {},
}));
import { AiHostedCompleteOperation } from "./ai-hosted-complete.operation";

const pricing = {
  inputTokenPrice: 1,
  outputTokenPrice: 2,
  reservationSafetyMarginPercent: 10,
  allowance: { units: 0 },
};

const noAllowance = { unit: BillingUnit.TOKEN, remainingUnits: 0n };

describe("AiHostedCompleteOperation", () => {
  const op = new AiHostedCompleteOperation({
    getSettings: vi.fn(),
  } as never);

  test("input and output use different prices", () => {
    const parsed = op.parsePricing(pricing);
    const charge = op.calculateCharge(
      { inputTokens: 1_000_000n, outputTokens: 1_000_000n },
      parsed,
      noAllowance,
    );
    expect(charge.lines[0].amount).toBe(1_000_000n);
    expect(charge.lines[1].amount).toBe(2_000_000n);
    expect(charge.payableAmount).toBe(3_000_000n);
  });

  test("allowance covers input first", () => {
    const parsed = op.parsePricing(pricing);
    const charge = op.calculateCharge(
      { inputTokens: 100n, outputTokens: 10n },
      parsed,
      { unit: BillingUnit.TOKEN, remainingUnits: 10n },
    );
    expect(charge.lines[0].freeQuantity).toBe(10n);
    expect(charge.lines[1].freeQuantity).toBe(0n);
  });

  test("null allowance is unlimited", () => {
    const parsed = op.parsePricing({ ...pricing, allowance: null });
    const charge = op.calculateCharge(
      { inputTokens: 100n, outputTokens: 10n },
      parsed,
      noAllowance,
    );
    expect(charge.payableAmount).toBe(0n);
    expect(charge.allowanceUnitsConsumed).toBe(110n);
  });
});
