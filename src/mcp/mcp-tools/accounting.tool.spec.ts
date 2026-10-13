import { vi } from "vitest";

// The tool file pulls in services/entities with circular imports; the pure
// input helpers under test don't need them.
vi.mock("src/accounting/services/accounting.service", () => ({ AccountingService: class {} }));
vi.mock("src/accounting/services/expenses.service", () => ({ ExpensesService: class {} }));
vi.mock("src/accounting/services/expense-categories.service", () => ({ ExpenseCategoriesService: class {} }));
vi.mock("src/accounting/services/monthly-closing.service", () => ({ MonthlyClosingService: class {} }));
vi.mock("src/supplier-payments/supplier-payments.service", () => ({ SupplierPaymentsService: class {} }));
vi.mock("entities/user.entity", () => ({
  User: class {},
  Role: class {},
  Permission: class {},
  SystemRole: { SUPER_ADMIN: "super_admin", ADMIN: "admin", USER: "user" },
}));

import { buildTrendBuckets, parseAccountingStatsInput } from "./accounting.tool";

describe("accounting tool input", () => {
  it("reports every invalid parameter at once", () => {
    expect(() =>
      parseAccountingStatsInput({ report: "summary", limit: 5, year: 2026, supplierId: "x", points: 3 } as any),
    ).toThrow(/5 problems/);
  });

  it("rejects startDate after endDate", () => {
    expect(() => parseAccountingStatsInput({ startDate: "2026-05-04", endDate: "2026-05-03" } as any)).toThrow(/after/);
  });

  it("rejects range with dates on trend", () => {
    expect(() =>
      parseAccountingStatsInput({ report: "trend", range: "this_month", startDate: "2026-05-01" } as any),
    ).toThrow(/range/);
  });

  it("trend returns exactly `points` buckets, default 12", () => {
    expect(buildTrendBuckets({}, "2026-10-12").buckets).toHaveLength(12);
    expect(buildTrendBuckets({ points: 5 }, "2026-10-12").buckets).toHaveLength(5);
    const plan = buildTrendBuckets({ startDate: "2026-04-01", endDate: "2026-06-30", points: 3 });
    expect(plan.buckets.map((b) => b.startDate)).toEqual(["2026-04-01", "2026-05-02", "2026-06-01"]);
    expect(plan.buckets[2].endDate).toBe("2026-06-30");
    // buckets are contiguous: each end instant is the next start instant
    for (let i = 1; i < plan.buckets.length; i++) {
      expect(plan.buckets[i].start.getTime()).toBe(plan.buckets[i - 1].end.getTime());
    }
  });
});

describe("accounting tool follow-up", () => {
  it("reports format and combination problems in one message", () => {
    let msg = "";
    try {
      parseAccountingStatsInput({ report: "summary", startDate: "2026-02-30", supplierId: "bad", range: "banana", points: 3, year: 2026 } as any);
    } catch (e: any) {
      msg = String(e.getError?.() ?? e.message);
    }
    expect(msg).toMatch(/startDate/);
    expect(msg).toMatch(/supplierId.*UUID/);
    expect(msg).toMatch(/range.*not supported/);
    expect(msg).toMatch(/only valid for report=month/);
    expect(msg).toMatch(/only valid for report=trend/);
  });

  it("rejects out-of-range numbers at runtime", () => {
    expect(() => parseAccountingStatsInput({ report: "trend", points: 0 } as any)).toThrow(/points/);
    expect(() => parseAccountingStatsInput({ report: "month", year: 2026, month: 13 } as any)).toThrow(/month/);
  });

  it("notes when one-day ranges cap points", () => {
    const plan = buildTrendBuckets({ range: "today", points: 5 }, "2026-10-12");
    expect(plan.buckets).toHaveLength(1);
    expect(plan.note).toMatch(/capped from 5 to 1/);
    expect(buildTrendBuckets({ points: 5 }, "2026-10-12").note).toBeUndefined();
  });

  it("last_expenses passes business-day bounds and echoes the period", async () => {
    const { McpAccountingTools } = await import("./accounting.tool");
    const getLastExpenses = vi.fn().mockResolvedValue({ lastPurchases: [], lastManualExpenses: [] });
    const tools = new McpAccountingTools({ getLastExpenses } as any, {} as any, {} as any, {} as any, {} as any);
    const res: any = await tools.getAccountingStats({ report: "last_expenses", startDate: "2026-05-03", endDate: "2026-05-03" } as any, {} as any);
    const [, filters, exact] = getLastExpenses.mock.calls[0];
    expect(exact).toBe(true);
    expect(filters.startDate.toISOString()).toBe("2026-05-02T21:00:00.000Z");
    expect(filters.endDate.toISOString()).toBe("2026-05-03T20:59:59.999Z");
    expect(JSON.parse(res.content[0].text).period).toEqual({ start: "2026-05-03", end: "2026-05-03" });
  });
});
