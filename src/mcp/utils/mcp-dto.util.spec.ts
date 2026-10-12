import { z } from "zod";
import { resolveToolDates, searchInput } from "./mcp-dto.util";
import { TOOL } from "./mcp-tool-names";

const schema = searchInput(
  "client",
  {
    search: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(10),
    cursor: z.string().optional(),
  },
  TOOL.clients.search,
);

describe("searchInput", () => {
  it("rejects unknown keys instead of stripping them", () => {
    const page = schema.safeParse({ page: 2 });
    const startDate = schema.safeParse({ startDate: "2026-01-01" });
    expect(page.success).toBe(false);
    expect(startDate.success).toBe(false);
    expect(JSON.stringify(page.error)).toMatch(/page/);
    expect(JSON.stringify(startDate.error)).toMatch(/startDate/);
  });

  it("accepts known list fields", () => {
    expect(schema.safeParse({ search: "ahmed", limit: 5 }).success).toBe(true);
  });
});

describe("resolveToolDates", () => {
  it("rejects range together with dates", () => {
    let msg = "";
    try {
      resolveToolDates({ range: "last_month", startDate: "2026-09-01" });
    } catch (e: any) {
      msg = String(e.getError?.() ?? e.message);
    }
    expect(msg).toMatch(/not both/);
  });

  it("includes the end calendar day", () => {
    const { startDate, endDate } = resolveToolDates({
      startDate: "2026-09-30",
      endDate: "2026-09-30",
    });
    expect(startDate).toBeInstanceOf(Date);
    expect(endDate).toBeInstanceOf(Date);
    expect(endDate!.getTime() - startDate!.getTime()).toBeGreaterThan(80_000_000);
  });
});
