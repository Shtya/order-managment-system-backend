import { describe, expect, test } from "vitest";
import {
  BillingAuthorizationEntity,
  BillingOperationKey,
  BillingServiceKey,
  BillingUnit,
} from "entities/billing.entity";
import { AllowanceService } from "./allowance.service";

describe("AllowanceService", () => {
  test("two sequential reserves cannot exceed the cap", async () => {
    const row = { used: 0n, reserved: 0n };
    const manager = {
      query: async (sql: string, params: any[]) => {
        if (sql.includes("INSERT INTO billing_allowance_usage")) {
          return [];
        }
        if (sql.includes("WITH cur AS")) {
          const maxUnits = BigInt(params[3]);
          const cap = BigInt(params[4]);
          const available = cap - row.used - row.reserved;
          const n = available < 0n ? 0n : available < maxUnits ? available : maxUnits;
          row.reserved += n;
          return [{ n }];
        }
        if (sql.includes('"usedUnits" = "usedUnits" +')) {
          row.reserved -= BigInt(params[0]);
          row.used += BigInt(params[1]);
          return [];
        }
        if (sql.includes('"reservedUnits" = "reservedUnits" -')) {
          row.reserved -= BigInt(params[0]);
          return [];
        }
        return [];
      },
      findOne: async () =>
        ({
          id: "auth-1",
          adminId: "admin-1",
          service: BillingServiceKey.AI_DECISION,
          operation: BillingOperationKey.EVALUATE,
          allowanceReservedUnits: 80000n,
        }) as BillingAuthorizationEntity,
    };

    const allowance = new AllowanceService();
    const first = await allowance.reserve({
      adminId: "admin-1",
      service: BillingServiceKey.AI_DECISION,
      operation: BillingOperationKey.EVALUATE,
      unit: BillingUnit.TOKEN,
      maxUnits: 80000n,
      authorizationId: "a1",
      capUnits: 100000n,
      durationDays: null,
      accountCreatedAt: new Date(),
      manager: manager as any,
    });
    const second = await allowance.reserve({
      adminId: "admin-1",
      service: BillingServiceKey.AI_DECISION,
      operation: BillingOperationKey.EVALUATE,
      unit: BillingUnit.TOKEN,
      maxUnits: 50000n,
      authorizationId: "a2",
      capUnits: 100000n,
      durationDays: null,
      accountCreatedAt: new Date(),
      manager: manager as any,
    });
    expect(first.remainingUnits).toBe(80000n);
    expect(second.remainingUnits).toBe(20000n);
    expect(row.reserved).toBe(100000n);
  });

  test("expired duration books nothing", async () => {
    const allowance = new AllowanceService();
    const grant = await allowance.reserve({
      adminId: "admin-1",
      service: BillingServiceKey.AI_DECISION,
      operation: BillingOperationKey.EVALUATE,
      unit: BillingUnit.TOKEN,
      maxUnits: 50000n,
      authorizationId: "a1",
      capUnits: 100000n,
      durationDays: 1,
      accountCreatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      manager: { query: async () => [] } as any,
    });
    expect(grant.remainingUnits).toBe(0n);
  });
});
