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

function toRuleSummary(row: any) {
  const companies = Array.isArray(row?.targetCompanies) ? row.targetCompanies : [];
  return {
    id: row.id,
    name: row.name ?? null,
    ruleType: row.ruleType ?? null,
    isActive: row.isActive ?? null,
    priority: row.priority ?? null,
    targetCompanies: companies.map((c: any) => c.name ?? c.id ?? null).filter(Boolean),
  };
}

function toRuleResultDto(row: any) {
  const companies = Array.isArray(row?.targetCompanies) ? row.targetCompanies : [];
  return {
    id: row.id,
    name: row.name ?? null,
    description: row.description ?? null,
    ruleType: row.ruleType ?? null,
    isActive: row.isActive ?? null,
    priority: row.priority ?? null,
    condition: row.condition ?? null,
    // ShippingCompanyEntity.id === list_shipping_companies.providerId, not integrationId
    targetCompanyIds: companies.map((c: any) => c.id ?? c.providerId ?? null).filter(Boolean),
    targetCompanyNames: companies.map((c: any) => c.name ?? null).filter(Boolean),
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
