import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { AccountingService } from "src/accounting/services/accounting.service";
import { ExpensesService } from "src/accounting/services/expenses.service";
import { ExpenseCategoriesService } from "src/accounting/services/expense-categories.service";
import { MonthlyClosingService } from "src/accounting/services/monthly-closing.service";
import { listPaging, parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
//    Flat objects + runtime checks (no discriminated unions).
// ═══════════════════════════════════════════════════════════════

const accountingStatsInput = z.object({
  report: z
    .enum([
      "summary",
      "last_expenses",
      "trend",
      "supplier_balances",
      "shipments_by_city",
      "supplier_period",
      "month",
    ])
    .optional()
    .describe(
      "Which report to return. summary (default): product cost, manual expenses, returns. last_expenses: latest 6 purchases + 6 manual expenses. trend: expense trend chart. supplier_balances: top supplier balances. shipments_by_city: city shipments table. supplier_period: header KPIs (omit supplierId) or one supplier period (require supplierId + dates). month: header KPIs (omit year/month) or live month snapshot (require year + month).",
    ),
  startDate: z.string().optional().describe("Range start, ISO date (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("Range end, ISO date (YYYY-MM-DD)"),
  range: z.string().optional().describe("Quick range. Only valid with report=trend."),
  points: z.number().int().min(1).max(50).optional().describe("Trend points. Only valid with report=trend (service default 12)."),
  year: z.number().int().min(2000).max(2100).optional().describe("Year. Only valid with report=month; require month too."),
  month: z.number().int().min(1).max(12).optional().describe("Month 1-12. Only valid with report=month; require year too."),
  supplierId: z.string().optional().describe(idDescription("Supplier id for report=supplier_period. Only valid there; require startDate + endDate with it.", TOOL.suppliers.search)),
  storeId: z
    .string()
    .optional()
    .describe(idDescription("Store id.", TOOL.stores.list, 'Only valid with report=shipments_by_city. Pass "all" to skip.')),
  search: z.string().optional().describe("Matches city name. Only valid with report=shipments_by_city."),
  page: z.number().int().min(1).optional().describe("Page number. Only valid with report=shipments_by_city."),
  limit: z.number().int().min(1).max(50).optional().describe("Rows per page. Only valid with report=shipments_by_city."),
});

const searchExpensesInput = searchInput("expense", {
  ...listPaging({
    items: "expenses",
    sortBy: ["collectionDate", "amount", "createdAt"],
    defaultSortBy: "collectionDate",
    search: "Matches description, category name, or safe name",
  }),
  categoryId: z
    .string()
    .optional()
    .describe(idDescription("Expense category id.", TOOL.accounting.expenseCategoriesList)),
  startDate: z.string().optional().describe("Collection-date range start, ISO date (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("Collection-date range end, ISO date (YYYY-MM-DD)"),
}, TOOL.accounting.expensesSearch);

const listExpenseCategoriesInput = z.object({
  isActive: z.boolean().optional().describe("True for active only, false for inactive only. Omit for all."),
});

const searchMonthlyClosingsInput = searchInput("monthly closing", {
  ...listPaging({
    items: "monthly closings",
    sortBy: ["year", "month", "netProfit", "createdAt"],
    defaultSortBy: "year",
    search: "Matches profit or revenue amounts",
  }),
  year: z.number().int().min(2000).max(2100).optional().describe("Keep closings of this year"),
  month: z.number().int().min(1).max(12).optional().describe("Keep closings of this month (1-12)"),
}, TOOL.accounting.monthlyClosingsSearch);

const searchSupplierClosingsInput = searchInput("supplier closing", {
  ...listPaging({
    items: "supplier closings",
    sortBy: ["createdAt", "finalBalance", "startDate", "endDate"],
    defaultSortBy: "createdAt",
    search: "Matches supplier name",
  }),
  supplierId: z.string().optional().describe(idDescription("Supplier id. Omit to list all suppliers.", TOOL.suppliers.search)),
  year: z.number().int().min(2000).max(2100).optional().describe("Keep closings ending in this year"),
  startDate: z.string().optional().describe("Keep closings ending on or after this date (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("Keep closings ending on or before this date (YYYY-MM-DD)"),
}, TOOL.accounting.supplierClosingsSearch);

const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

function parseAccountingStatsInput(input: z.infer<typeof accountingStatsInput>) {
  const report = input.report ?? "summary";

  if (report !== "shipments_by_city" && isSet(input.limit)) {
    throw new RpcException("`limit` is only valid for report=shipments_by_city. Remove it.");
  }
  if (report !== "shipments_by_city" && (isSet(input.page) || isSet((input as any).search))) {
    throw new RpcException("`page` and `search` are only valid for report=shipments_by_city. Remove them.");
  }
  if (report !== "shipments_by_city" && isSet(input.storeId)) {
    throw new RpcException("`storeId` is only valid for report=shipments_by_city. Remove it.");
  }
  if (report !== "month" && (isSet(input.year) || isSet(input.month))) {
    throw new RpcException("`year`/`month` are only valid for report=month. Remove them.");
  }
  if (report !== "supplier_period" && isSet(input.supplierId)) {
    throw new RpcException("`supplierId` is only valid for report=supplier_period. Remove it.");
  }
  if (report !== "trend" && (isSet(input.range) || isSet(input.points))) {
    throw new RpcException("`range`/`points` are only valid for report=trend. Remove them.");
  }
  if (report === "month" && (isSet(input.startDate) || isSet(input.endDate))) {
    throw new RpcException("report=month takes `year` + `month`, not dates. Remove startDate/endDate.");
  }

  if (report === "month") {
    const hasYear = isSet(input.year);
    const hasMonth = isSet(input.month);
    if (hasYear !== hasMonth) {
      throw new RpcException("report=month needs both `year` and `month`, or neither (header KPIs).");
    }
  }
  if (report === "supplier_period" && isSet(input.supplierId)) {
    if (!isSet(input.startDate) || !isSet(input.endDate)) {
      throw new RpcException("report=supplier_period with `supplierId` requires `startDate` + `endDate`.");
    }
  }
  if (report === "supplier_period" && !isSet(input.supplierId)) {
    if (isSet(input.startDate) || isSet(input.endDate)) {
      throw new RpcException("report=supplier_period header takes no dates. Add `supplierId` with dates, or remove the dates.");
    }
  }

  return { report };
}

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
//    No file bytes; at most an attachment path.
// ═══════════════════════════════════════════════════════════════

const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v));

function toExpenseSummary(row: any) {
  return {
    id: row.id,
    description: row.description ?? null,
    amount: num(row.amount),
    collectionDate: row.collectionDate ?? null,
    category: row.category ? { id: row.category.id ?? row.categoryId ?? null, name: row.category.name ?? null } : null,
    safe: row.safe ? { id: row.safe.id ?? row.safeId ?? null, name: row.safe.name ?? null } : null,
  };
}

function toExpenseResultDto(row: any) {
  return {
    id: row.id,
    description: row.description ?? null,
    amount: num(row.amount),
    collectionDate: row.collectionDate ?? null,
    attachment: row.attachment ?? null,
    category: row.category ? { id: row.category.id ?? row.categoryId ?? null, name: row.category.name ?? null } : null,
    safe: row.safe ? { id: row.safe.id ?? row.safeId ?? null, name: row.safe.name ?? null } : null,
    user: row.user ? { id: row.user.id ?? null, name: row.user.name ?? null } : null,
    createdAt: row.createdAt ?? null,
  };
}

function toExpenseCategoryDto(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    isActive: row.isActive ?? null,
    expensesCount: num(row.expensesCount),
    totalCost: num(row.totalCost),
  };
}

function toMonthlyClosingSummary(row: any) {
  return {
    id: row.id,
    year: row.year ?? null,
    month: row.month ?? null,
    revenue: num(row.revenue),
    netProfit: num(row.netProfit),
    createdAt: row.createdAt ?? null,
  };
}

function toMonthlyClosingDto(row: any) {
  return {
    id: row.id,
    year: row.year ?? null,
    month: row.month ?? null,
    revenue: num(row.revenue),
    productCost: num(row.productCost),
    operationalExpenses: num(row.operationalExpenses),
    returnsCost: num(row.returnsCost),
    netProfit: num(row.netProfit),
    periodStart: row.periodStart ?? null,
    periodEnd: row.periodEnd ?? null,
    createdAt: row.createdAt ?? null,
  };
}

function toSupplierClosingSummary(row: any) {
  return {
    id: row.id,
    supplierId: row.supplierId ?? row.supplier?.id ?? null,
    supplierName: row.supplier?.name ?? null,
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
    finalBalance: num(row.finalBalance),
    createdAt: row.createdAt ?? row.created_at ?? null,
  };
}

function toSupplierClosingDto(row: any) {
  return {
    id: row.id,
    supplierId: row.supplierId ?? row.supplier?.id ?? null,
    supplierName: row.supplier?.name ?? null,
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
    totalPurchases: num(row.totalPurchases),
    totalPaid: num(row.totalPaid),
    totalReturns: num(row.totalReturns),
    finalBalance: num(row.finalBalance),
    createdAt: row.createdAt ?? row.created_at ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpAccountingTools {
  constructor(
    private accounting: AccountingService,
    private expenses: ExpensesService,
    private expenseCategories: ExpenseCategoriesService,
    private monthlyClosings: MonthlyClosingService,
  ) {}

  @McpReadTool({
    name: TOOL.accounting.stats,
    description:
      "Accounting overview stats. Pass `report`: summary (default), last_expenses, trend, supplier_balances, shipments_by_city, supplier_period, month. Shared dates: startDate + endDate. trend adds range/points. shipments_by_city adds storeId/search/page/limit. supplier_period: omit supplierId for header KPIs, or pass supplierId + dates for one period. month: omit year/month for header KPIs, or pass year + month for a live snapshot. Read-only.",
    parameters: accountingStatsInput,
  })
  async getAccountingStats(
    @Payload() input: z.infer<typeof accountingStatsInput>,
    @McpUser() user: User,
  ) {
    const { report } = parseAccountingStatsInput(input);
    const { report: _r, page, limit, ...filters } = input as any;

    if (report === "last_expenses") {
      const result = await this.accounting.getLastExpenses(user, filters);
      const purchases = Array.isArray((result as any)?.lastPurchases) ? (result as any).lastPurchases : [];
      const manual = Array.isArray((result as any)?.lastManualExpenses) ? (result as any).lastManualExpenses : [];
      return toolJson({
        report,
        lastPurchases: purchases.map((p: any) => ({
          id: p.id,
          total: num(p.total),
          supplierName: p.supplier?.name ?? null,
          statusUpdateDate: p.statusUpdateDate ?? null,
        })),
        lastManualExpenses: manual.map(toExpenseSummary),
      });
    }
    if (report === "trend") {
      const rows = await this.accounting.getExpensesTrend(user, filters);
      const trend = Array.isArray(rows) ? rows : [];
      return toolJson({
        report,
        trend: trend.map((r: any) => ({
          date: r.date ?? null,
          productCost: num(r.productCost),
          manualExpenses: num(r.manualExpenses),
          totalCost: num(r.totalCost),
        })),
      });
    }
    if (report === "supplier_balances") {
      const rows = await this.accounting.getTopSuppliersBalances(user, filters);
      return toolJson({ report, suppliers: Array.isArray(rows) ? rows : [] });
    }
    if (report === "shipments_by_city") {
      const result = await this.accounting.getShipmentsCityReport(user, {
        ...filters,
        page: page ?? 1,
        limit: limit ?? 10,
      });
      return toolJson({
        report,
        total_records: (result as any)?.total_records ?? 0,
        current_page: (result as any)?.current_page ?? 1,
        per_page: (result as any)?.per_page ?? (limit ?? 10),
        cities: ((result as any)?.records ?? []).map((r: any) => ({
          city: r.city ?? null,
          totalShipments: num(r.totalShipments),
          actualDeliveries: num(r.actualDeliveries),
          failedShipments: num(r.failedShipments),
          successRate: num(r.successRate),
          failureRate: num(r.failureRate),
        })),
      });
    }
    if (report === "supplier_period") {
      if (isSet((input as any).supplierId)) {
        return toolJson({
          report,
          ...(await this.accounting.getSupplierPeriodPreview(
            user,
            (input as any).supplierId,
            (input as any).startDate,
            (input as any).endDate,
          )),
        });
      }
      return toolJson({
        report,
        ...(await this.accounting.getSupplierPeriodPreview(user, null, null, null)),
      });
    }
    if (report === "month") {
      if (isSet((input as any).year) && isSet((input as any).month)) {
        return toolJson({
          report,
          ...(await this.monthlyClosings.getMonthPreview(user, {
            year: Number((input as any).year),
            month: Number((input as any).month),
          })),
        });
      }
      return toolJson({ report, ...(await this.monthlyClosings.getMonthStats(user)) });
    }

    return toolJson({
      report,
      ...(await this.accounting.getStats(user, filters)),
    });
  }

  @McpReadTool({
    name: TOOL.accounting.expensesSearch,
    description:
      "Search manual expenses or fetch one. Without `id`: paged summaries filtered by category, dates, or search text. With `id`: returns that single expense with category, safe, and user names. Read-only.",
    parameters: searchExpensesInput,
  })
  async searchExpenses(
    @Payload() input: z.infer<typeof searchExpensesInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "expense");
    if (req.mode === "get") {
      return toolJson(toExpenseResultDto(await this.expenses.getExpense(user, req.id)));
    }
    const result = await this.expenses.listExpenses(user, req.query);
    return toolPage("expenses", result, toExpenseSummary, req.query.limit);
  }

  @McpReadTool({
    name: TOOL.accounting.expenseCategoriesList,
    description:
      "List manual expense categories with expense counts and total cost. Optional isActive filter. Read-only.",
    parameters: listExpenseCategoriesInput,
  })
  async listExpenseCategories(
    @Payload() input: z.infer<typeof listExpenseCategoriesInput>,
    @McpUser() user: User,
  ) {
    const rows = await this.expenseCategories.listCategories(user, input);
    const records = Array.isArray(rows) ? rows : [];
    return toolJson({ categories: records.map(toExpenseCategoryDto) });
  }

  @McpReadTool({
    name: TOOL.accounting.monthlyClosingsSearch,
    description:
      "Search saved month-close documents or fetch one. Without `id`: paged list filtered by year, month, or search text. With `id`: returns that closing. Live month preview stays on `accounting_stats` report=month. Read-only.",
    parameters: searchMonthlyClosingsInput,
  })
  async searchMonthlyClosings(
    @Payload() input: z.infer<typeof searchMonthlyClosingsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "monthly closing");
    if (req.mode === "get") {
      return toolJson(toMonthlyClosingDto(await this.monthlyClosings.getClosing(user, req.id)));
    }
    const result = await this.monthlyClosings.listClosings(user, req.query);
    return toolPage("monthly_closings", result, toMonthlyClosingSummary, req.query.limit);
  }

  @McpReadTool({
    name: TOOL.accounting.supplierClosingsSearch,
    description:
      "Search saved supplier-period close documents or fetch one. Without `id`: paged list filtered by supplier, year, dates, or supplier name. With `id`: returns that closing. Period preview totals stay on `accounting_stats` report=supplier_period. Read-only.",
    parameters: searchSupplierClosingsInput,
  })
  async searchSupplierClosings(
    @Payload() input: z.infer<typeof searchSupplierClosingsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "supplier closing");
    if (req.mode === "get") {
      return toolJson(toSupplierClosingDto(await this.accounting.getSupplierClosing(user, req.id)));
    }
    const result = await this.accounting.listSupplierClosings(user, req.query);
    return toolPage("supplier_closings", result, toSupplierClosingSummary, req.query.limit);
  }
}
