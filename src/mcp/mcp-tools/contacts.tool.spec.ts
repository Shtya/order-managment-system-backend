import { vi } from "vitest";

vi.mock("src/customer/customer.service", () => ({ CustomerService: class {} }));
vi.mock("src/conversation/conversation.service", () => ({ ConversationService: class {} }));
vi.mock("entities/user.entity", () => ({ User: class {} }));

import { resolveContactStatsPeriod } from "./contacts.tool";

describe("contacts stats period", () => {
  afterEach(() => vi.useRealTimers());

  it("defaults to all time without inventing date boundaries", () => {
    const result = resolveContactStatsPeriod({});

    expect(result.period.source).toBe("all_time");
    expect(result.period.timezone).toBe("Africa/Cairo");
    expect(result.startDate).toBeUndefined();
    expect(result.endDate).toBeUndefined();
    expect(result.period.startDate).toBeNull();
    expect(result.period.endDate).toBeNull();
  });

  it("accepts mixed date and date-time boundaries", () => {
    const result = resolveContactStatsPeriod({
      startDate: "2026-10-24",
      endDate: "2026-10-25T12:30:00+03:00",
    });

    expect(result.period.source).toBe("custom");
    expect(result.endDate.toISOString()).toBe("2026-10-25T09:30:00.000Z");
  });

  it("rejects partial, mixed-mode, and reversed periods", () => {
    expect(() =>
      resolveContactStatsPeriod({ startDate: "2026-10-24" }),
    ).toThrow(/both/);
    expect(() =>
      resolveContactStatsPeriod({
        range: "today",
        startDate: "2026-10-24",
        endDate: "2026-10-24",
      }),
    ).toThrow(/either/);
    expect(() =>
      resolveContactStatsPeriod({
        startDate: "2026-10-25T12:00:00Z",
        endDate: "2026-10-24T12:00:00Z",
      }),
    ).toThrow(/after/);
  });
});
