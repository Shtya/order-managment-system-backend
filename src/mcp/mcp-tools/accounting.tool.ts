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
import { SupplierPaymentsService } from "src/supplier-payments/supplier-payments.service";
import { listPaging, parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, ref, TOOL } from "../utils/mcp-tool-names";
import { BUSINESS_TZ, businessDayRange, businessYmd, isoDateField, resolveQuickRange, splitDays, startOfBusinessDay, addDays, TREND_RANGES, isIsoDate, isUuid, uuidField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
//    Flat objects + runtime checks (no discriminated unions).
// ═══════════════════════════════════════════════════════════════

const DAY_RULE = `Calendar day in the business timezone (${BUSINESS_TZ})`;

/** Reports of accounting_stats that accept startDate/endDate. */
const DATED_REPORTS = ["summary", "last_expenses", "trend", "supplier_balances", "shipments_by_city"] as const;
const TREND_DEFAULT_RANGE = "last_30_days";
const TREND_DEFAULT_POINTS = 12;

// Value checks (uuid, date, enum, bounds) for accounting_stats run in
// parseAccountingStatsInput, not in Zod, so format problems and report-combination
// problems come back together in ONE message. Zod only checks basic types here.
const STATS_BOUNDS = { points: [1, 50], year: [2000, 2100], month: [1, 12], page: [1, 100000], limit: [1, 50] } as const;

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
      "Which report to return. summary (default): product cost, manual expenses, returns. last_expenses: latest 6 accepted purchases + 6 manual expenses (within startDate/endDate when given). trend: expense trend chart. supplier_balances: top 10 supplier balances. shipments_by_city: city shipments table. supplier_period: header KPIs (omit supplierId) or one supplier period (require supplierId + startDate + endDate). month: header KPIs (omit year/month) or live month snapshot (require year + month).",
    ),
  startDate: isoDateField(
    `Range start, YYYY-MM-DD (real calendar date). ${DAY_RULE}, inclusive. Accepted by: ${DATED_REPORTS.join(", ")}, and supplier_period with supplierId.`,
  ).optional(),
  endDate: isoDateField(
    `Range end, YYYY-MM-DD (real calendar date). ${DAY_RULE}, inclusive (the whole day counts). Same reports as startDate.`,
  ).optional(),
  range: z
    .enum(TREND_RANGES)
    .optional()
    .describe(
      `Quick range for report=trend, one of: ${TREND_RANGES.join(", ")}. ${BUSINESS_TZ} calendar days (weeks start Sunday). Do not combine with startDate/endDate. Default when no dates: ${TREND_DEFAULT_RANGE}.`,
    ),
  points: z
    .number()
    .optional()
    .describe(
      `Integer 1-50: number of trend buckets for report=trend (default ${TREND_DEFAULT_POINTS}). Exactly this many are returned unless the range has fewer days; then it is capped to one bucket per day and the output carries a \`note\` (e.g. today/yesterday always give 1 point). Days are split as evenly as possible (lengths differ by at most 1 day).`,
    ),
  year: z.number().optional().describe("Integer 2000-2100. Only valid with report=month; require month too."),
  month: z.number().optional().describe("Integer 1-12. Only valid with report=month; require year too."),
  supplierId: uuidField(idDescription("Supplier id (UUID) for report=supplier_period. Only valid there; require startDate + endDate with it.", TOOL.suppliers.search)).optional(),
  storeId: uuidField(idDescription("Store id (UUID).", TOOL.stores.list, 'Only valid with report=shipments_by_city. Pass "all" (or omit) to skip.'), ["all"]).optional(),
  search: z.string().optional().describe("Matches city name. Only valid with report=shipments_by_city."),
  page: z.number().optional().describe("Integer >= 1: page number. Only valid with report=shipments_by_city."),
  limit: z.number().optional().describe("Integer 1-50: rows per page. Only valid with report=shipments_by_city."),
});

const searchExpensesInput = searchInput("expense", {
  id: uuidField(
    idDescription("expense ID. Pass it to get ONE expense with full details. Omit it to search and list.", TOOL.accounting.expensesSearch),
  ).optional(),
  ...listPaging({
    items: "expenses",
    sortBy: ["collectionDate", "amount", "createdAt"],
    defaultSortBy: "collectionDate",
    search: "Matches description, category name, or safe name",
  }),
  categoryId: uuidField(idDescription("Expense category id.", TOOL.accounting.expenseCategoriesList)).optional(),
  startDate: isoDateField(`Collection-date range start, YYYY-MM-DD. ${DAY_RULE}, inclusive.`).optional(),
  endDate: isoDateField(`Collection-date range end, YYYY-MM-DD. ${DAY_RULE}, inclusive (the whole day counts).`).optional(),
}, TOOL.accounting.expensesSearch);

const listExpenseCategoriesInput = z.object({
  isActive: z.boolean().optional().describe("True for active only, false for inactive only. Omit for all."),
});

const searchMonthlyClosingsInput = searchInput("monthly closing", {
  id: uuidField(
    idDescription(
      "monthly closing ID. Pass it to get ONE monthly closing with full details. Omit it to search and list.",
      TOOL.accounting.monthlyClosingsSearch,
    ),
  ).optional(),
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
  id: uuidField(
    idDescription(
      "supplier closing ID. Pass it to get ONE supplier closing with full details. Omit it to search and list.",
      TOOL.accounting.supplierClosingsSearch,
    ),
  ).optional(),
  ...listPaging({
    items: "supplier closings",
    sortBy: ["createdAt", "finalBalance", "startDate", "endDate"],
    defaultSortBy: "createdAt",
    search: "Matches supplier name",
  }),
  supplierId: uuidField(idDescription("Supplier id. Omit to list all suppliers.", TOOL.suppliers.search)).optional(),
  year: z.number().int().min(2000).max(2100).optional().describe("Keep closings whose period END date is in this year"),
  startDate: isoDateField("Keep closings whose period END date is on or after this day (YYYY-MM-DD, inclusive). Not the period start.").optional(),
  endDate: isoDateField("Keep closings whose period END date is on or before this day (YYYY-MM-DD, inclusive).").optional(),
}, TOOL.accounting.supplierClosingsSearch);

const searchSupplierPaymentsInput = searchInput("supplier payment", {
  id: uuidField(
    idDescription(
      "supplier payment ID. Pass it to get ONE payment with allocations. Omit it to search and list.",
      TOOL.accounting.supplierPaymentsSearch,
    ),
  ).optional(),
  ...listPaging({
    items: "supplier payments",
    sortBy: ["paymentDate"],
    defaultSortBy: "paymentDate",
    search: "Matches supplier name or allocated invoice receipt number",
  }),
  supplierId: uuidField(idDescription("Supplier id.", TOOL.suppliers.search)).optional(),
  invoiceId: uuidField(idDescription("Keep payments allocated to this purchase invoice.", TOOL.purchases.search)).optional(),
  startDate: isoDateField(`Payment-date range start, YYYY-MM-DD. ${DAY_RULE}, inclusive.`).optional(),
  endDate: isoDateField(`Payment-date range end, YYYY-MM-DD. ${DAY_RULE}, inclusive (the whole day counts).`).optional(),
}, TOOL.accounting.supplierPaymentsSearch);

const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

/** Throws one RpcException listing every problem, not just the first. */
function throwAll(problems: string[]) {
  if (problems.length === 1) throw new RpcException(problems[0]);
  if (problems.length > 1) {
    throw new RpcException(`${problems.length} problems: ${problems.map((p, i) => `(${i + 1}) ${p}`).join(" ")}`);
  }
}

function checkDateOrder(startDate: unknown, endDate: unknown, problems: string[]) {
  if (typeof startDate === "string" && typeof endDate === "string" && startDate > endDate) {
    problems.push(`\`startDate\` (${startDate}) is after \`endDate\` (${endDate}). Swap them.`);
  }
}

export function parseAccountingStatsInput(input: z.infer<typeof accountingStatsInput>) {
  const report = input.report ?? "summary";
  const problems: string[] = [];

  // 1) value/format checks
  for (const key of ["startDate", "endDate"] as const) {
    if (isSet(input[key]) && !isIsoDate(input[key])) {
      problems.push(`\`${key}\` "${input[key]}" must be a real calendar date in YYYY-MM-DD format (e.g. 2026-05-31).`);
    }
  }
  if (isSet(input.supplierId) && !isUuid(input.supplierId)) {
    problems.push(`\`supplierId\` "${input.supplierId}" must be a UUID. Find it with ${ref(TOOL.suppliers.search)}.`);
  }
  if (isSet(input.storeId) && input.storeId !== "all" && !isUuid(input.storeId)) {
    problems.push(`\`storeId\` "${input.storeId}" must be a UUID or "all". Find it with ${ref(TOOL.stores.list)}.`);
  }
  if (isSet(input.range) && !(TREND_RANGES as readonly string[]).includes(input.range!)) {
    problems.push(`\`range\` "${input.range}" is not supported. Use one of: ${TREND_RANGES.join(", ")}.`);
  }
  for (const [key, [min, max]] of Object.entries(STATS_BOUNDS) as [keyof typeof STATS_BOUNDS, readonly [number, number]][]) {
    const v = input[key];
    if (isSet(v) && (!Number.isInteger(v) || (v as number) < min || (v as number) > max)) {
      problems.push(`\`${key}\` must be an integer from ${min} to ${max} (got ${v}).`);
    }
  }

  // 2) report-combination checks
  const hasDates = isSet(input.startDate) || isSet(input.endDate);

  if (report !== "shipments_by_city") {
    const extra = (["storeId", "search", "page", "limit"] as const).filter((k) => isSet(input[k]));
    if (extra.length) problems.push(`${extra.map((k) => `\`${k}\``).join(", ")} only valid for report=shipments_by_city. Remove.`);
  }
  if (report !== "month" && (isSet(input.year) || isSet(input.month))) {
    problems.push("`year`/`month` are only valid for report=month. Remove them.");
  }
  if (report !== "supplier_period" && isSet(input.supplierId)) {
    problems.push("`supplierId` is only valid for report=supplier_period. Remove it.");
  }
  if (report !== "trend" && (isSet(input.range) || isSet(input.points))) {
    problems.push("`range`/`points` are only valid for report=trend. Remove them.");
  }
  if (report === "trend" && isSet(input.range) && hasDates) {
    problems.push("report=trend takes `range` OR `startDate`/`endDate`, not both. Remove one.");
  }
  if (report === "month") {
    if (hasDates) problems.push("report=month takes `year` + `month`, not dates. Remove startDate/endDate.");
    if (isSet(input.year) !== isSet(input.month)) {
      problems.push("report=month needs both `year` and `month`, or neither (header KPIs).");
    }
  }
  if (report === "supplier_period") {
    if (isSet(input.supplierId)) {
      if (!isSet(input.startDate) || !isSet(input.endDate)) {
        problems.push("report=supplier_period with `supplierId` requires both `startDate` and `endDate`.");
      }
    } else if (hasDates) {
      problems.push("report=supplier_period header takes no dates. Add `supplierId` with dates, or remove the dates.");
    }
  }
  if (isIsoDate(input.startDate) && isIsoDate(input.endDate)) checkDateOrder(input.startDate, input.endDate, problems);
  throwAll(problems);

  return { report };
}

/** Rejects startDate > endDate on search tools. */
function assertDateOrder(q: { startDate?: string; endDate?: string }) {
  const problems: string[] = [];
  checkDateOrder(q.startDate, q.endDate, problems);
  throwAll(problems);
}

/** Business-day instants as ISO strings for services that take date strings. */
function dayBoundsIso(startDate?: string, endDate?: string) {
  const { start, end } = businessDayRange(startDate, endDate);
  return { startDate: start?.toISOString(), endDate: end?.toISOString() };
}

/** Inclusive days -> trend buckets ([start, nextStart) instants) for the service. */
export function buildTrendBuckets(input: { range?: string; startDate?: string; endDate?: string; points?: number }, today = businessYmd()) {
  let startDate = input.startDate;
  let endDate = input.endDate;
  if (!startDate && !endDate) {
    ({ startDate, endDate } = resolveQuickRange((input.range ?? TREND_DEFAULT_RANGE) as any, today));
  } else if (!startDate) {
    startDate = addDays(endDate!, -29);
  } else if (!endDate) {
    endDate = today < startDate ? startDate : today;
  }
  const requested = input.points ?? TREND_DEFAULT_POINTS;
  const days = splitDays(startDate!, endDate!, requested);
  const note =
    days.length < requested
      ? `points capped from ${requested} to ${days.length}: the range has only ${days.length} day(s) and buckets are at least one day.`
      : undefined;
  return {
    startDate: startDate!,
    endDate: endDate!,
    requestedPoints: requested,
    note,
    buckets: days.map((d) => ({
      ...d,
      start: startOfBusinessDay(d.startDate),
      end: startOfBusinessDay(addDays(d.endDate, 1)),
    })),
  };
}

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
//    No file bytes; at most an attachment path.
// ═══════════════════════════════════════════════════════════════

const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v));

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Inclusive first/last calendar day of a closing month (YYYY-MM-DD). */
function monthPeriod(year: number, month: number) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${year}-${pad2(month)}-01`, end: `${year}-${pad2(month)}-${pad2(last)}` };
}

function toExpenseSummary(row: any) {
  return {
    id: row.id,
    description: row.description ?? null,
    amount: num(row.amount),
    collectionDate: row.collectionDate ?? null,
    category: row.category ? { id: row.category.id ?? row.categoryId ?? null, name: row.category.name ?? null } : null,
    safe: row.safe ? { id: row.safe.id ?? row.safeId ?? null, name: row.safe.name ?? null } : null,
    createdAt: row.createdAt ?? null,
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

function toLastPurchase(p: any) {
  return {
    id: p.id,
    total: num(p.total),
    supplierId: p.supplierId ?? p.supplier?.id ?? null,
    // null when the purchase has no supplier (supplierId is nullable)
    supplierName: p.supplier?.name ?? null,
    statusUpdateDate: p.statusUpdateDate ?? null,
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

/** Same field names as the live month snapshot (accounting_stats report=month). */
function toMonthlyClosingDto(row: any) {
  return {
    id: row.id,
    year: row.year ?? null,
    month: row.month ?? null,
    revenue: num(row.revenue),
    returnedRevenue: num(row.returnedRevenue),
    productCost: num(row.productCost),
    operationalExpenses: num(row.operationalExpenses),
    returnsCost: num(row.returnsCost),
    grossProfit: num(row.grossProfit),
    netProfit: num(row.netProfit),
    period: row.year && row.month ? monthPeriod(Number(row.year), Number(row.month)) : null,
    createdAt: row.createdAt ?? null,
  };
}

function toMonthSnapshot(p: any) {
  return {
    isClosed: !!p?.isClosed,
    year: p?.year ?? null,
    month: p?.month ?? null,
    revenue: num(p?.revenue),
    returnedRevenue: num(p?.returnedRevenue),
    // service field `cogs`: product cost of delivered orders net of returned items' cost
    productCost: num(p?.cogs),
    operationalExpenses: num(p?.operationalExpenses),
    returnsCost: num(p?.returnsCost),
    grossProfit: num(p?.grossProfit),
    netProfit: num(p?.netProfit),
    period: p?.year && p?.month ? monthPeriod(Number(p.year), Number(p.month)) : null,
  };
}

function toMonthHeader(s: any) {
  const c = s?.currentMonthStats ?? {};
  return {
    lastMonthProfit: {
      year: s?.lastMonthProfit?.year ?? null,
      month: s?.lastMonthProfit?.month ?? null,
      netProfit: num(s?.lastMonthProfit?.netProfit),
    },
    currentMonthStats: {
      revenue: num(c.revenue),
      totalCosts: num(c.totalCosts),
      netProfit: num(c.netProfit),
      productCost: num(c.productCost),
      operationalExpenses: num(c.operationalExpenses),
      returnsCost: num(c.returnsCost),
    },
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
    totalTaken: num(row.totalTakenFromReturns ?? row.totalTaken),
    // snapshot of the supplier's whole outstanding due balance when the closing was saved, not a period net
    finalBalance: num(row.finalBalance),
    createdAt: row.createdAt ?? row.created_at ?? null,
  };
}

function toPaymentAllocations(row: any) {
  const allocations = Array.isArray(row?.allocations) ? row.allocations : [];
  return allocations.map((a: any) => ({
    id: a.id ?? null,
    invoiceId: a.invoiceId ?? a.invoice?.id ?? null,
    receiptNumber: a.invoice?.receiptNumber ?? null,
    amount: num(a.amount),
    invoiceRemainingAfterPay: a.invoiceRemainingAfterPay == null ? null : num(a.invoiceRemainingAfterPay),
    unallocated: !(a.invoiceId ?? a.invoice?.id),
  }));
}

function toSupplierPaymentSummary(row: any) {
  const allocations = toPaymentAllocations(row);
  return {
    id: row.id,
    paymentDate: row.paymentDate ?? null,
    amount: num(row.amount),
    currency: row.currency ?? null,
    notes: row.notes ?? null,
    supplierBalanceAfterPay: num(row.supplierBalanceAfterPay),
    supplier: row.supplier
      ? { id: row.supplier.id ?? row.supplierId ?? null, name: row.supplier.name ?? null }
      : { id: row.supplierId ?? null, name: null },
    safe: row.safe
      ? { id: row.safe.id ?? row.safeId ?? null, name: row.safe.name ?? null }
      : { id: row.safeId ?? null, name: null },
    createdBy: row.createdByUser
      ? { id: row.createdByUser.id ?? row.createdByUserId ?? null, name: row.createdByUser.name ?? null }
      : null,
    allocationsCount: allocations.length,
    allocations: allocations.map((a: any) => ({
      invoiceId: a.invoiceId,
      receiptNumber: a.receiptNumber,
      amount: a.amount,
      unallocated: a.unallocated,
    })),
    createdAt: row.createdAt ?? null,
  };
}

function toSupplierPaymentDto(row: any) {
  return {
    ...toSupplierPaymentSummary(row),
    allocations: toPaymentAllocations(row),
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

function toSupplierPeriod(r: any, startDate: string | null, endDate: string | null) {
  return {
    totalPurchases: num(r?.totalPurchases),
    totalPaid: num(r?.totalPaid),
    totalReturns: num(r?.totalReturns),
    totalTaken: num(r?.totalTaken),
    netPurchases: num(r?.netPurchases),
    netPayments: num(r?.netPayments),
    purchasesCount: num(r?.pCount),
    returnsCount: num(r?.rCount),
    // current outstanding due balance (live, not limited to the period)
    finalBalance: num(r?.finalBalance),
    period: startDate || endDate ? { start: startDate, end: endDate } : null,
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
    private supplierPayments: SupplierPaymentsService,
  ) {}

  @McpReadTool({
    name: TOOL.accounting.stats,
    description:
      `Accounting overview stats. Pass \`report\`: summary (default), last_expenses, trend, supplier_balances, shipments_by_city, supplier_period, month. ` +
      `Dates: startDate/endDate are YYYY-MM-DD ${BUSINESS_TZ} calendar days, both inclusive; accepted ONLY by ${DATED_REPORTS.join(", ")}, and supplier_period with supplierId (required there). Omit them for all time (trend defaults to ${TREND_DEFAULT_RANGE}). ` +
      `last_expenses with dates returns the latest 6 of each kind inside that range (purchases by accept date, expenses by collection date) and echoes \`period\`. trend adds range OR dates, plus points; each bucket has startDate/endDate (inclusive); if points exceeds the number of days it is capped (one bucket per day) and a \`note\` says so. All parameter problems are reported together in one error. shipments_by_city adds storeId/search/page/limit. ` +
      `supplier_period: omit supplierId for header KPIs (no dates), or pass supplierId + startDate + endDate for one period; finalBalance is the supplier's CURRENT outstanding balance, not period-limited. ` +
      `month: omit year/month for header KPIs, or pass year + month for a live snapshot (same fields as a saved closing in ${ref(TOOL.accounting.monthlyClosingsSearch)}; month is a ${BUSINESS_TZ} calendar month, period.end inclusive). No dates. All amounts are numbers. Read-only.`,
    parameters: accountingStatsInput,
  })
  async getAccountingStats(
    @Payload() input: z.infer<typeof accountingStatsInput>,
    @McpUser() user: User,
  ) {
    const { report } = parseAccountingStatsInput(input);
    const { startDate, endDate } = input;
    const bounds = businessDayRange(startDate, endDate);
    const iso = dayBoundsIso(startDate, endDate);

    if (report === "last_expenses") {
      const result = await this.accounting.getLastExpenses(user, { startDate: bounds.start, endDate: bounds.end }, true);
      const purchases = Array.isArray((result as any)?.lastPurchases) ? (result as any).lastPurchases : [];
      const manual = Array.isArray((result as any)?.lastManualExpenses) ? (result as any).lastManualExpenses : [];
      return toolJson({
        report,
        period: startDate || endDate ? { start: startDate ?? null, end: endDate ?? null } : null,
        lastPurchases: purchases.map(toLastPurchase),
        lastManualExpenses: manual.map(toExpenseSummary),
      });
    }
    if (report === "trend") {
      const plan = buildTrendBuckets(input);
      const rows = await this.accounting.getExpensesTrendBuckets(
        user,
        plan.buckets.map((b) => ({ start: b.start, end: b.end })),
      );
      const byIndex = new Map((Array.isArray(rows) ? rows : []).map((r: any) => [r.index, r]));
      return toolJson({
        report,
        startDate: plan.startDate,
        endDate: plan.endDate,
        points: plan.buckets.length,
        ...(plan.note ? { requestedPoints: plan.requestedPoints, note: plan.note } : {}),
        trend: plan.buckets.map((b, i) => {
          const r: any = byIndex.get(i) ?? {};
          return {
            startDate: b.startDate,
            endDate: b.endDate,
            productCost: num(r.productCost),
            manualExpenses: num(r.manualExpenses),
            totalCost: num(r.totalCost),
          };
        }),
      });
    }
    if (report === "supplier_balances") {
      const rows = await this.accounting.getTopSuppliersBalances(user, { startDate: bounds.start, endDate: bounds.end }, true);
      return toolJson({ report, suppliers: Array.isArray(rows) ? rows : [] });
    }
    if (report === "shipments_by_city") {
      const page = input.page ?? 1;
      const limit = input.limit ?? 10;
      const result = await this.accounting.getShipmentsCityReport(user, {
        ...iso,
        storeId: input.storeId && input.storeId !== "all" ? input.storeId : undefined,
        search: input.search || undefined,
        page,
        limit,
      });
      return toolJson({
        report,
        total_records: (result as any)?.total_records ?? 0,
        current_page: (result as any)?.current_page ?? page,
        per_page: (result as any)?.per_page ?? limit,
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
      if (isSet(input.supplierId)) {
        const r = await this.accounting.getSupplierPeriodPreview(user, input.supplierId!, iso.startDate!, iso.endDate!);
        return toolJson({ report, supplierId: input.supplierId, ...toSupplierPeriod(r, startDate!, endDate!) });
      }
      const r = await this.accounting.getSupplierPeriodPreview(user, null, null, null);
      return toolJson({ report, ...toSupplierPeriod(r, null, null) });
    }
    if (report === "month") {
      if (isSet(input.year) && isSet(input.month)) {
        const p = await this.monthlyClosings.getMonthPreview(user, {
          year: Number(input.year),
          month: Number(input.month),
        });
        return toolJson({ report, ...toMonthSnapshot(p) });
      }
      return toolJson({ report, ...toMonthHeader(await this.monthlyClosings.getMonthStats(user)) });
    }

    return toolJson({
      report,
      ...(await this.accounting.getStats(user, iso)),
    });
  }

  @McpReadTool({
    name: TOOL.accounting.expensesSearch,
    description:
      `Search manual expenses or fetch one. Without \`id\`: paged summaries (with createdAt) filtered by category, collection dates, or search text. startDate/endDate are YYYY-MM-DD ${BUSINESS_TZ} calendar days of collectionDate, both inclusive (startDate=endDate gives that one day). With \`id\`: returns that single expense with category, safe, and user names. Read-only.`,
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
    assertDateOrder(req.query);
    const result = await this.expenses.listExpenses(user, {
      ...req.query,
      ...dayBoundsIso(req.query.startDate, req.query.endDate),
    });
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
      `Search saved month-close documents or fetch one. Without \`id\`: paged list filtered by year, month, or search text; sortBy year/month sorts chronologically in sortOrder. With \`id\`: returns that closing with the same field names as the live snapshot (productCost, grossProfit, netProfit, period.start/end as inclusive YYYY-MM-DD ${BUSINESS_TZ} calendar days). Live month preview stays on ${ref(TOOL.accounting.stats)} report=month. Read-only.`,
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
      `Search saved supplier-period close documents or fetch one. Without \`id\`: paged list filtered by supplier, supplier name, year, or dates; year/startDate/endDate all filter on the closing's period END date (calendar day, inclusive). With \`id\`: returns that closing with totalPurchases, totalPaid, totalReturns, totalTaken (refunds taken back on returns) and finalBalance (the supplier's whole outstanding balance at the moment the closing was saved, not the period net). Period preview totals stay on ${ref(TOOL.accounting.stats)} report=supplier_period. Read-only.`,
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
    assertDateOrder(req.query);
    const result = await this.accounting.listSupplierClosings(user, req.query);
    return toolPage("supplier_closings", result, toSupplierClosingSummary, req.query.limit);
  }

  @McpReadTool({
    name: TOOL.accounting.supplierPaymentsSearch,
    description:
      `Search supplier payments (Accounts → Supplier payments) or fetch one. Without \`id\`: paged rows filtered by supplier, allocated invoice, payment dates, or search (supplier name / invoice receipt number). startDate/endDate are YYYY-MM-DD ${BUSINESS_TZ} calendar days of paymentDate, both inclusive. Sort is paymentDate (then createdAt). With \`id\`: that payment with safe, creator, supplierBalanceAfterPay, and allocations (invoice id, receipt number, amount, remaining). Create/export are not offered. Read-only.`,
    parameters: searchSupplierPaymentsInput,
  })
  async searchSupplierPayments(
    @Payload() input: z.infer<typeof searchSupplierPaymentsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "supplier payment");
    if (req.mode === "get") {
      return toolJson(toSupplierPaymentDto(await this.supplierPayments.findOne(user, req.id)));
    }
    assertDateOrder(req.query);
    const q = req.query as typeof req.query & { invoiceId?: string };
    const result = await this.supplierPayments.findAll(user, {
      ...q,
      ...dayBoundsIso(q.startDate, q.endDate),
      sortOrder: (q as any).sortOrder,
    } as any);
    return toolPage("supplier_payments", result, toSupplierPaymentSummary, (q as any).limit);
  }
}
