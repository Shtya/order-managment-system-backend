vi.mock("src/admin-settings/admin-settings.service", () => ({
  AdminSettingsService: class AdminSettingsService {},
}));
import { describe, expect, test } from "vitest";
import {
  BillingOperationKey,
  BillingServiceKey,
  BillingUnit,
} from "entities/billing.entity";
import { BillingOperationNotFoundError } from "../billing.errors";
import { BillingOperationRegistry } from "./billing-operation.registry";
import { BillingOperationStrategy } from "./billing-operation.strategy";

class StubOperation extends BillingOperationStrategy<unknown, unknown> {
  readonly service: BillingServiceKey;
  readonly operation: BillingOperationKey;
  readonly primaryUnit = BillingUnit.TOKEN;

  constructor(
    service: BillingServiceKey = BillingServiceKey.AI_DECISION,
    operation: BillingOperationKey = BillingOperationKey.EVALUATE,
  ) {
    super();
    this.service = service;
    this.operation = operation;
  }

  parsePricing(raw: unknown): unknown {
    return raw;
  }

  parseUsage(raw: unknown): unknown {
    return raw;
  }

  allowancePolicy(): {
    capUnits: bigint | null;
    durationDays: number | null;
    reservationSafetyMarginPercent: number;
  } {
    return {
      capUnits: 0n,
      durationDays: null,
      reservationSafetyMarginPercent: 0,
    };
  }

  async getSettingsSnapshot() {
    return { version: "stub", capturedAt: "", rawSettings: {} };
  }

  authorizationRequirement(): {
    maxAmount: bigint;
    maxUnits: { unit: BillingUnit; quantity: bigint };
  } {
    return {
      maxAmount: 0n,
      maxUnits: { unit: BillingUnit.TOKEN, quantity: 0n },
    };
  }

  calculateCharge() {
    return {
      lines: [],
      grossAmount: 0n,
      payableAmount: 0n,
      allowanceUnitsConsumed: 0n,
    };
  }
}

function stubOperation(
  service: BillingServiceKey = BillingServiceKey.AI_DECISION,
  operation: BillingOperationKey = BillingOperationKey.EVALUATE,
): BillingOperationStrategy<unknown, unknown> {
  return new StubOperation(service, operation);
}

describe("BillingOperationRegistry", () => {
  test("resolves a registered operation", () => {
    const op = stubOperation();
    const registry = new BillingOperationRegistry([op]);

    expect(
      registry.get(BillingServiceKey.AI_DECISION, BillingOperationKey.EVALUATE),
    ).toBe(op);
  });

  test("throws for unknown service:operation", () => {
    const registry = new BillingOperationRegistry([]);

    expect(() =>
      registry.get(BillingServiceKey.AI_DECISION, BillingOperationKey.EVALUATE),
    ).toThrow(BillingOperationNotFoundError);
  });

  test("throws on duplicate registration", () => {
    expect(
      () => new BillingOperationRegistry([stubOperation(), stubOperation()]),
    ).toThrow(/Duplicate billing operation/);
  });
});
