import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { DashboardService } from "src/dashboard/dashboard.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { toolJson } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
//    These mirror the order-analysis reports page filters
//    (range + startDate/endDate + store/shipping/assignee/product/city).
//    No listPaging: the services take no page/sort, only a top-N limit.
// ═══════════════════════════════════════════════════════════════

const dashboardRange = z
  .enum([
    "today",
    "yesterday",
    "this_week",
    "last_week",
    "this_month",
    "last_month",
    "this_year",
  ])
  .optional()
  .describe(
    "Quick range. Omit and pass startDate/endDate for a custom range.",
  );

const dashboardDates = {
  startDate: z.string().optional().describe("Range start, ISO date (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("Range end, ISO date (YYYY-MM-DD)"),
};

const dashboardFilters = {
  storeId: z
    .string()
    .optional()
    .describe(
      idDescription(
        "Store id.",
        TOOL.stores.list,
        'Pass "all" to skip.',
      ),
    ),
  shippingCompanyId: z
    .string()
    .optional()
    .describe(
      idDescription(
        "Shipping company id.",
        TOOL.shippingCompanies.list,
        'Pass "all" to skip.',
      ),
    ),
  assignedUserId: z
    .string()
    .optional()
    .describe(
      idDescription(
        "Employee id of the latest assignee.",
        TOOL.employees.list,
        'Pass "all" to skip.',
      ),
    ),
  productIds: z
    .array(z.string())
    .optional()
    .describe(
      idDescription(
        "Keep orders containing any of these product ids.",
        TOOL.products.list,
        'Pass "all" to skip.',
      ),
    ),
  cityId: z
    .string()
    .optional()
    .describe(
      idDescription(
        "City id.",
        TOOL.cities.list,
        'Pass "all" to skip.',
      ),
    ),
};

const advancedStatsInput = z.object({
  range: dashboardRange,
  ...dashboardDates,
  ...dashboardFilters,
});

// weekly-trend always covers the last 7 days: no date params, like the service.
const weeklyTrendInput = z.object({
  ...dashboardFilters,
});

const topCitiesInput = z.object({
  range: dashboardRange,
  ...dashboardDates,
  ...dashboardFilters,
  limit: z.number().int().min(1).max(50).default(5).describe("How many top cities to return"),
});

const topProductsInput = z.object({
  range: dashboardRange,
  ...dashboardDates,
  ...dashboardFilters,
  limit: z.number().int().min(1).max(50).default(5).describe("How many top products to return"),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
//    advanced-stats aggregates come back as numeric strings from
//    Postgres, so they are converted to numbers here.
// ═══════════════════════════════════════════════════════════════

const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v));

function toAdvancedStatsDto(row: any) {
  const { statusBreakdown, comparison, ...kpis } = row ?? {};
  const stats: Record<string, number> = {};
  for (const [k, v] of Object.entries(kpis)) stats[k] = num(v);
  const breakdown = Array.isArray(statusBreakdown)
    ? statusBreakdown.map((s: any) => ({
        statusId: s.statusId ?? s.statusid ?? null,
        code: s.code ?? null,
        name: s.name ?? null,
        system: s.system ?? null,
        count: Number(s.count ?? 0),
      }))
    : [];
  let prev: Record<string, number> | null = null;
  if (comparison && typeof comparison === "object") {
    prev = {};
    for (const [k, v] of Object.entries(comparison)) prev[k] = num(v);
  }
  return { stats, statusBreakdown: breakdown, comparison: prev };
}

function toTrendRow(row: any) {
  return {
    date: row.date ?? null,
    dayOfWeek: row.day_of_week ?? null,
    created: Number(row.created ?? 0),
    delivered: Number(row.delivered ?? 0),
  };
}

function toTopCityRow(row: any) {
  return {
    id: row.id ?? null,
    nameEn: row.nameEn ?? null,
    nameAr: row.nameAr ?? null,
    totalOrders: Number(row.totalOrders ?? 0),
    correctedOrders: Number(row.correctedOrders ?? 0),
    confirmedCount: Number(row.confirmedCount ?? 0),
    shippedOrders: Number(row.shippedOrders ?? 0),
    deliveredTotal: Number(row.deliveredTotal ?? 0),
    deliveredFromConfirmed: Number(row.deliveredFromConfirmed ?? 0),
  };
}

function toTopProductRow(row: any) {
  return {
    id: row.id ?? null,
    name: row.name ?? null,
    totalOrders: Number(row.totalOrders ?? 0),
    correctedOrders: Number(row.correctedOrders ?? 0),
    confirmedCount: Number(row.confirmedCount ?? 0),
    shippedOrders: Number(row.shippedOrders ?? 0),
    deliveredTotal: Number(row.deliveredTotal ?? 0),
    deliveredFromConfirmed: Number(row.deliveredFromConfirmed ?? 0),
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpDashboardTools {
  constructor(private dashboard: DashboardService) {}

  @McpReadTool({
    name: TOOL.dashboard.advancedStats,
    description:
      "Order KPI stats with previous-range comparison and per-status breakdown for the order-analysis report filters. Read-only.",
    parameters: advancedStatsInput,
  })
  async getAdvancedStats(
    @Payload() query: z.infer<typeof advancedStatsInput>,
    @McpUser() user: User,
  ) {
    const result = await this.dashboard.getAdvancedStats(user, query);
    return toolJson(toAdvancedStatsDto(result));
  }

  @McpReadTool({
    name: TOOL.dashboard.weeklyTrend,
    description:
      "Created vs delivered orders per day for the last 7 days. Read-only.",
    parameters: weeklyTrendInput,
  })
  async getWeeklyTrend(
    @Payload() query: z.infer<typeof weeklyTrendInput>,
    @McpUser() user: User,
  ) {
    const result = await this.dashboard.getWeeklyTrend(user, query);
    const rows = Array.isArray(result) ? result : [];
    return toolJson({ trend: rows.map(toTrendRow) });
  }

  @McpReadTool({
    name: TOOL.dashboard.topCities,
    description:
      "Top cities by delivered orders with corrected/confirmed/shipped breakdown. Read-only.",
    parameters: topCitiesInput,
  })
  async getTopCities(
    @Payload() query: z.infer<typeof topCitiesInput>,
    @McpUser() user: User,
  ) {
    const result = await this.dashboard.getTopCitiesStats(user, query);
    const rows = Array.isArray(result) ? result : [];
    return toolJson({ cities: rows.map(toTopCityRow) });
  }

  @McpReadTool({
    name: TOOL.dashboard.topProducts,
    description:
      "Top products by delivered orders with corrected/confirmed/shipped breakdown. Read-only.",
    parameters: topProductsInput,
  })
  async getTopProducts(
    @Payload() query: z.infer<typeof topProductsInput>,
    @McpUser() user: User,
  ) {
    const result = await this.dashboard.getTopProductsStats(user, query);
    const rows = Array.isArray(result) ? result : [];
    return toolJson({ products: rows.map(toTopProductRow) });
  }
}
