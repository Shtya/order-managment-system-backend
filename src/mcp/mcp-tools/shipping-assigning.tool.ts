import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { ShippingAssigningService } from "src/shipping-assigning/shipping-assigning.service";
import { parseSearchInput, resolveToolDates, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";
import { isoDateField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS
//    Read-only. Service sorts priority then createdAt (fixed):
//    no sortBy advertised. isActive maps boolean -> "true"/"false".
// ═══════════════════════════════════════════════════════════════

const searchRulesInput = searchInput("shipping assigning rule", {
  page: z.number().int().min(1).default(1).describe("Page number, starting at 1"),
  limit: z.number().int().min(1).max(50).default(10).describe("The number of rules to return"),
  search: z.string().optional().describe("Matches rule name"),
  ruleType: z
    .enum(["equal_distribution", "payment_method", "order_total", "store", "city"])
    .optional()
    .describe("Keep rules of this type"),
  isActive: z.boolean().optional().describe("True for active only, false for inactive only. Omit for all."),
  startDate: isoDateField("Created-at range start, ISO date (YYYY-MM-DD)").optional(),
  endDate: isoDateField("Created-at range end, ISO date (YYYY-MM-DD)").optional(),
}, TOOL.shippingAssigning.search);

const rulesStatsInput = z.strictObject({});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: no dry-run resolve/preview.
// ═══════════════════════════════════════════════════════════════

function toTargetCompany(c: any) {
  // ShippingCompanyEntity.id === list_shipping_companies.providerId, not integrationId
  return {
    id: c?.id ?? c?.providerId ?? null,
    name: c?.name ?? null,
    code: c?.code ?? null,
    isActive: c?.isActive ?? null,
  };
}

function toRuleStore(s: any) {
  return {
    id: s?.id ?? null,
    name: s?.name ?? null,
    storeUrl: s?.storeUrl ?? null,
    provider: s?.provider ?? null,
    isActive: s?.isActive ?? null,
  };
}

function toRuleCondition(condition: any, stores: any[]) {
  const storeIdsFromJoin = stores.map((s) => s?.id).filter(Boolean);
  return {
    paymentMethod: condition?.paymentMethod ?? null,
    storeIds: Array.isArray(condition?.storeIds) && condition.storeIds.length
      ? condition.storeIds
      : storeIdsFromJoin,
    cityIds: Array.isArray(condition?.cityIds) ? condition.cityIds : [],
    minAmount: condition?.minAmount ?? null,
    maxAmount: condition?.maxAmount ?? null,
  };
}

function toRuleSummary(row: any) {
  const companies = Array.isArray(row?.targetCompanies) ? row.targetCompanies : [];
  const stores = Array.isArray(row?.stores) ? row.stores : [];
  return {
    id: row.id,
    name: row.name ?? null,
    description: row.description ?? null,
    ruleType: row.ruleType ?? null,
    isActive: row.isActive ?? null,
    priority: row.priority ?? null,
    lastAssignedCompanyId: row.lastAssignedCompanyId ?? null,
    condition: toRuleCondition(row?.condition, stores),
    targetCompanies: companies.map(toTargetCompany),
    stores: stores.map(toRuleStore),
    createdAt: row.createdAt ?? row.created_at ?? null,
  };
}

function toRuleResultDto(row: any) {
  const companies = Array.isArray(row?.targetCompanies) ? row.targetCompanies : [];
  const stores = Array.isArray(row?.stores) ? row.stores : [];
  return {
    id: row.id,
    adminId: row.adminId ?? null,
    name: row.name ?? null,
    description: row.description ?? null,
    ruleType: row.ruleType ?? null,
    isActive: row.isActive ?? null,
    priority: row.priority ?? null,
    lastAssignedCompanyId: row.lastAssignedCompanyId ?? null,
    condition: toRuleCondition(row?.condition, stores),
    targetCompanies: companies.map(toTargetCompany),
    stores: stores.map(toRuleStore),
    createdAt: row.createdAt ?? row.created_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpShippingAssigningTools {
  constructor(private rules: ShippingAssigningService) {}

  @McpReadTool({
    name: TOOL.shippingAssigning.search,
    description:
      "Search auto-assign shipping rules or fetch one. Without `id`: paged list filtered by name, type, active flag, or dates. With `id`: returns that rule with condition and target companies. Read-only.",
    parameters: searchRulesInput,
  })
  async searchRules(
    @Payload() input: z.infer<typeof searchRulesInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "shipping assigning rule");
    if (req.mode === "get") {
      return toolJson(toRuleResultDto(await this.rules.getRuleDetails(user, req.id)));
    }
    const { isActive, ...rest } = req.query as typeof req.query & { isActive?: boolean };
    const dates = resolveToolDates(rest);
    const result = await this.rules.listRules(user, {
      ...rest,
      startDate: dates.startDate,
      endDate: dates.endDate,
      ...(isActive === undefined ? {} : { isActive: isActive ? "true" : "false" }),
    });
    return toolPage("rules", result, toRuleSummary, (rest as any).limit ?? 10);
  }

  @McpReadTool({
    name: TOOL.shippingAssigning.stats,
    description: "Shipping rule totals: total, active, by type. Read-only.",
    parameters: rulesStatsInput,
  })
  async getRulesStats(@McpUser() user: User) {
    return toolJson(await this.rules.getRulesStats(user));
  }
}
