import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { DashboardService } from "src/dashboard/dashboard.service";
import { AiDashboardService } from "src/dashboard/ai-dashboard.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { toolJson } from "../utils/mcp-result.util";
import { idDescription, shippingCompanyIdDescription, TOOL } from "../utils/mcp-tool-names";
import { uuidField, isoDateField, TREND_RANGES } from "../utils/mcp-date.util";
import { assertDateOrder } from "../utils/mcp-dto.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
//    Flat object + runtime checks (no discriminated union).
// ═══════════════════════════════════════════════════════════════

const dashboardStatsInput = z.object({
  report: z
    .enum(["summary", "weekly_trend", "top_cities", "top_products", "home", "top_products_chart"])
    .optional()
    .describe(
      "Which report to return. summary: KPIs, status breakdown, previous-range comparison (default). weekly_trend: created vs delivered per day for the last 7 days — do not pass range or dates. top_cities / top_products: ranking by delivered orders; may pass limit. home: home KPI cards. top_products_chart: top products chart; may pass limit.",
    ),
  range: z
    .enum(TREND_RANGES)
    .optional()
    .describe(
      `Quick range. One of: ${TREND_RANGES.join(", ")}. Omit and pass startDate/endDate for a custom range. Not valid with report=weekly_trend.`,
    ),
  startDate: isoDateField("Range start, ISO date (YYYY-MM-DD). Not valid with report=weekly_trend.").optional(),
  endDate: isoDateField("Range end, ISO date (YYYY-MM-DD). Not valid with report=weekly_trend.").optional(),
  storeId: uuidField(idDescription(
        "Store id.",
        TOOL.stores.list,
        'Pass "all" to skip.',
      ), ["all"]).optional(),
  shippingCompanyId: uuidField(shippingCompanyIdDescription("Shipping company id.", 'Pass "all" to skip.'), ["all"]).optional(),
  assignedUserId: uuidField(idDescription(
        "Employee id of the latest assignee.",
        TOOL.employees.list,
        'Pass "all" to skip.',
      ), ["all"]).optional(),
  productIds: z.array(uuidField(idDescription(
        "Keep orders containing any of these product ids.",
        TOOL.products.search,
        'Pass "all" to skip.',
      ), ["all"])).optional(),
  cityId: uuidField(idDescription(
        "City id.",
        TOOL.cities.list,
        'Pass "all" to skip.',
      ), ["all"]).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("How many rows to return. Only valid for report=top_cities, top_products, and top_products_chart."),
});

const dashboardAiStatsInput = z.object({
  report: z
    .enum(["overview", "credits", "cost_by_agent"])
    .optional()
    .describe("Which report to return. overview (default): AI usage overview. credits: wallet credits. cost_by_agent: cost grouped by agent."),
  range: z.enum(TREND_RANGES).optional().describe(`Quick range. One of: ${TREND_RANGES.join(", ")}. Only valid with report=overview and cost_by_agent.`),
  startDate: isoDateField("Range start, ISO date (YYYY-MM-DD). Only valid with report=overview and cost_by_agent.").optional(),
  endDate: isoDateField("Range end, ISO date (YYYY-MM-DD). Only valid with report=overview and cost_by_agent.").optional(),
});

const isSet = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0);

function parseDashboardStatsInput(input: z.infer<typeof dashboardStatsInput>) {
  assertDateOrder(input as Record<string, unknown>);
  const report = input.report ?? "summary";
  const dateKeys = (["range", "startDate", "endDate"] as const).filter((key) => isSet(input[key]));

  if (report === "weekly_trend") {
    if (dateKeys.length > 0) {
      throw new RpcException(
        `report=weekly_trend always covers the last 7 days. Remove ${dateKeys.join(", ")}.`,
      );
    }
    if (isSet(input.limit)) {
      throw new RpcException("report=weekly_trend does not take `limit`. Remove it.");
    }
  } else if ((report === "summary" || report === "home") && isSet(input.limit)) {
    throw new RpcException(
      "`limit` is only valid for report=top_cities, top_products, and top_products_chart. Remove it, or set report to one of those.",
    );
  }

  const { report: _report, limit, ...filters } = input;
  return {
    report,
    filters: {
      ...filters,
      ...(report === "top_cities" || report === "top_products" || report === "top_products_chart"
        ? { limit: limit ?? 5 }
        : {}),
    },
  };
}

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
  constructor(
    private dashboard: DashboardService,
    private aiDashboard: AiDashboardService,
  ) {}

  @McpReadTool({
    name: TOOL.dashboard.stats,
    description:
      "Order statistics. Pass `report`: summary (default — KPIs, status breakdown, previous-range comparison), weekly_trend (created vs delivered for the last 7 days; no date filters), top_cities, top_products, home (home KPI cards), or top_products_chart. Shared filters: storeId, cityId, shippingCompanyId, productIds, assignedUserId. Date filters (not for weekly_trend): range, or startDate + endDate. `limit` only for top_cities, top_products, and top_products_chart. Read-only.",
    parameters: dashboardStatsInput,
  })
  async getOrdersStats(
    @Payload() input: z.infer<typeof dashboardStatsInput>,
    @McpUser() user: User,
  ) {
    const req = parseDashboardStatsInput(input);

    if (req.report === "weekly_trend") {
      const result = await this.dashboard.getWeeklyTrend(user, req.filters);
      const rows = Array.isArray(result) ? result : [];
      return toolJson({ report: req.report, trend: rows.map(toTrendRow) });
    }
    if (req.report === "top_cities") {
      const result = await this.dashboard.getTopCitiesStats(user, req.filters);
      const rows = Array.isArray(result) ? result : [];
      return toolJson({ report: req.report, cities: rows.map(toTopCityRow) });
    }
    if (req.report === "top_products") {
      const result = await this.dashboard.getTopProductsStats(user, req.filters);
      const rows = Array.isArray(result) ? result : [];
      return toolJson({ report: req.report, products: rows.map(toTopProductRow) });
    }
    if (req.report === "home") {
      return toolJson({ report: req.report, ...(await this.dashboard.getSummary(user, req.filters)) });
    }
    if (req.report === "top_products_chart") {
      const result = await this.dashboard.getTopProducts(user, req.filters);
      const rows = Array.isArray(result) ? result : Array.isArray((result as any)?.records) ? (result as any).records : [];
      return toolJson({ report: req.report, products: rows });
    }

    const result = await this.dashboard.getAdvancedStats(user, req.filters);
    return toolJson({ report: req.report, ...toAdvancedStatsDto(result) });
  }

  @McpReadTool({
    name: TOOL.dashboard.aiStats,
    description:
      "AI usage statistics. Pass `report`: overview (default — usage overview, optional dates/range), credits (wallet credits, no dates), cost_by_agent (cost grouped by agent, optional dates/range). Read-only.",
    parameters: dashboardAiStatsInput,
  })
  async getAiStats(
    @Payload() input: z.infer<typeof dashboardAiStatsInput>,
    @McpUser() user: User,
  ) {
    const report = (input as any)?.report ?? "overview";
    assertDateOrder(input as Record<string, unknown>);
    if (report === "credits") {
      if (isSet((input as any).startDate) || isSet((input as any).endDate) || isSet((input as any).range)) {
        throw new RpcException("report=credits takes no dates. Remove startDate/endDate/range.");
      }
      return toolJson({ report, ...(await this.aiDashboard.credits(user)) });
    }
    const query = {
      ...(isSet((input as any).startDate) ? { startDate: (input as any).startDate } : {}),
      ...(isSet((input as any).endDate) ? { endDate: (input as any).endDate } : {}),
      ...(isSet((input as any).range) ? { range: (input as any).range } : {}),
    };
    if (report === "cost_by_agent") {
      return toolJson({ report, ...(await this.aiDashboard.costByAgent(user, query)) });
    }
    return toolJson({ report, ...(await this.aiDashboard.overview(user, query)) });
  }
}
