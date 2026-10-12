import {
  businessDayRange,
  businessMonthRange,
  isIsoDate,
  isUuid,
  isoDateField,
  resolveQuickRange,
  splitDays,
  startOfBusinessDay,
  uuidField,
} from "./mcp-date.util";
import { assertDateOrder } from "./mcp-dto.util";

describe("mcp-date.util", () => {
  it("validates real calendar dates", () => {
    expect(isIsoDate("2026-05-03")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
    for (const bad of ["2026-13-45", "2026-02-30", "bad", "2026-5-3", "2026-05-03T00:00:00Z", ""]) {
      expect(isIsoDate(bad)).toBe(false);
    }
    const r = isoDateField("d").safeParse("2026-02-30");
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toMatch(/YYYY-MM-DD/);
  });

  it("uuidField and isoDateField reject garbage before the handler", () => {
    const id = uuidField("Bundle id.");
    expect(id.safeParse("not-a-uuid").success).toBe(false);
    expect(id.safeParse("33cee04d-6bb1-489b-881a-634a2a651413").success).toBe(true);
    const day = isoDateField("Range start.");
    expect(day.safeParse("2026-02-30").success).toBe(false);
    expect(day.safeParse("2026-05-31").success).toBe(true);
  });

  it("assertDateOrder rejects reversed ranges", () => {
    expect(() => assertDateOrder({ startDate: "2026-05-04", endDate: "2026-05-03" })).toThrow(/after/);
    expect(() => assertDateOrder({ startDate: "2026-05-03", endDate: "2026-05-04" })).not.toThrow();
    expect(() =>
      assertDateOrder({ postponedStartDate: "2026-05-04", postponedEndDate: "2026-05-03" }),
    ).toThrow(/postponedStartDate/);
  });

  it("validates uuids and allowed keywords", () => {
    expect(isUuid("33cee04d-6bb1-489b-881a-634a2a651413")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    const f = uuidField("store", ["all"]);
    expect(f.safeParse("all").success).toBe(true);
    expect(f.safeParse("33cee04d-6bb1-489b-881a-634a2a651413").success).toBe(true);
    const bad = f.safeParse("123");
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].message).toMatch(/UUID.*"all"/);
  });

  it("maps business days to Africa/Cairo instants, end inclusive", () => {
    // Cairo is UTC+3 in May 2026 (DST)
    const { start, end } = businessDayRange("2026-05-03", "2026-05-03");
    expect(start!.toISOString()).toBe("2026-05-02T21:00:00.000Z");
    expect(end!.toISOString()).toBe("2026-05-03T20:59:59.999Z");
    // UTC+2 in January
    expect(startOfBusinessDay("2026-01-10").toISOString()).toBe("2026-01-09T22:00:00.000Z");
  });

  it("maps a calendar month to Africa/Cairo instants, last day inclusive", () => {
    const may = businessMonthRange(2026, 5);
    const days = businessDayRange("2026-05-01", "2026-05-31");
    expect(may.start.toISOString()).toBe(days.start!.toISOString());
    expect(may.end.toISOString()).toBe(days.end!.toISOString());
    expect(may.start.toISOString()).toBe("2026-04-30T21:00:00.000Z");
    expect(may.end.toISOString()).toBe("2026-05-31T20:59:59.999Z");
    const jan = businessMonthRange(2026, 1);
    expect(jan.start.toISOString()).toBe("2025-12-31T22:00:00.000Z");
    expect(jan.end.toISOString()).toBe("2026-01-31T21:59:59.999Z");
  });

  it("start=end and a two-day range agree on the shared day", () => {
    const one = businessDayRange("2026-05-03", "2026-05-03");
    const two = businessDayRange("2026-05-02", "2026-05-03");
    expect(two.end!.getTime()).toBe(one.end!.getTime());
    expect(two.start!.getTime()).toBeLessThan(one.start!.getTime());
  });

  it("splits days into exactly N near-even inclusive buckets", () => {
    const b = splitDays("2026-04-01", "2026-06-30", 3);
    expect(b).toHaveLength(3);
    expect(b[0].startDate).toBe("2026-04-01");
    expect(b[2].endDate).toBe("2026-06-30");
    for (let i = 1; i < b.length; i++) expect(b[i].startDate > b[i - 1].endDate).toBe(true);
    expect(splitDays("2026-05-01", "2026-05-30", 12)).toHaveLength(12);
    expect(splitDays("2026-05-01", "2026-05-03", 12)).toHaveLength(3);
  });

  it("resolves quick ranges in calendar days", () => {
    expect(resolveQuickRange("last_month", "2026-03-15")).toEqual({ startDate: "2026-02-01", endDate: "2026-02-28" });
    expect(resolveQuickRange("last_30_days", "2026-03-15")).toEqual({ startDate: "2026-02-14", endDate: "2026-03-15" });
    // 2026-10-14 is a Wednesday; week starts Sunday 10-11
    expect(resolveQuickRange("this_week", "2026-10-14")).toEqual({ startDate: "2026-10-11", endDate: "2026-10-14" });
  });
});
