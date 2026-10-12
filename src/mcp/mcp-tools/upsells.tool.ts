import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { UpsellsService } from "src/upsells/upsells.service";
import { listPaging, parseSearchInput, resolveToolDates, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";
import { isoDateField, TREND_RANGES, uuidField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS
//    Service sorts createdAt only: advertise that single column.
//    No raw files on get.
// ═══════════════════════════════════════════════════════════════

const searchUpsellsInput = searchInput("upsell", {
  ...listPaging({
    items: "upsells",
    sortBy: ["createdAt"],
    search: "Matches trigger or upsell product name or SKU",
  }),
  status: z.enum(["active", "inactive"]).optional().describe("Keep active or inactive offers. Omit for all."),
  productId: uuidField(idDescription("Keep offers for this product (trigger or upsell).", TOOL.products.search)).optional(),
  startDate: isoDateField("Created-at range start, ISO date (YYYY-MM-DD)").optional(),
  endDate: isoDateField("Created-at range end, ISO date (YYYY-MM-DD)").optional(),
}, TOOL.upsells.search);

const upsellsStatsInput = z.strictObject({
  startDate: isoDateField("Range start, ISO date (YYYY-MM-DD)").optional(),
  endDate: isoDateField("Range end, ISO date (YYYY-MM-DD)").optional(),
  range: z.enum(TREND_RANGES).optional().describe(`Quick range. One of: ${TREND_RANGES.join(", ")}. Do not pass together with startDate/endDate.`),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: offer, products, message config. No files.
// ═══════════════════════════════════════════════════════════════

function toUpsellSummary(row: any) {
  return {
    id: row.id,
    isActive: row.isActive ?? null,
    triggerProduct: row.triggerProduct ? { id: row.triggerProduct.id ?? null, name: row.triggerProduct.name ?? null } : null,
    upsellProduct: row.upsellProduct ? { id: row.upsellProduct.id ?? null, name: row.upsellProduct.name ?? null } : null,
    createdAt: row.createdAt ?? null,
  };
}

function toUpsellResultDto(row: any) {
  return {
    id: row.id,
    isActive: row.isActive ?? null,
    triggerProduct: row.triggerProduct ? { id: row.triggerProduct.id ?? null, name: row.triggerProduct.name ?? null } : null,
    upsellProduct: row.upsellProduct ? { id: row.upsellProduct.id ?? null, name: row.upsellProduct.name ?? null } : null,
    upsellSku: row.upsellSku ? { id: row.upsellSku.id ?? null, sku: row.upsellSku.sku ?? null } : null,
    message: row.message ?? row.messageConfig ?? null,
    createdAt: row.createdAt ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpUpsellsTools {
  constructor(private upsells: UpsellsService) {}

  @McpReadTool({
    name: TOOL.upsells.search,
    description:
      "Search upsell offers or fetch one. Without `id`: paged summaries filtered by search text, status, product, or dates. With `id`: returns that offer with products and message config. Read-only.",
    parameters: searchUpsellsInput,
  })
  async searchUpsells(
    @Payload() input: z.infer<typeof searchUpsellsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "upsell");
    if (req.mode === "get") {
      return toolJson(toUpsellResultDto(await this.upsells.findOne(user, req.id)));
    }
    const dates = resolveToolDates(req.query);
    const result = await this.upsells.list(user, {
      ...req.query,
      startDate: dates.startDate,
      endDate: dates.endDate,
    });
    return toolPage("upsells", result, toUpsellSummary, req.query.limit);
  }

  @McpReadTool({
    name: TOOL.upsells.stats,
    description:
      "Upsell outcome counts: sent, accepted, rejected, noAnswer, expired, acceptedNonEligible, failedToAdd, delivered, pending. Optional startDate/endDate/range. Read-only.",
    parameters: upsellsStatsInput,
  })
  async getUpsellsStats(
    @Payload() input: z.infer<typeof upsellsStatsInput>,
    @McpUser() user: User,
  ) {
    const dates = resolveToolDates(input);
    return toolJson(await this.upsells.stats(user, {
      startDate: dates.startDate,
      endDate: dates.endDate,
    }));
  }
}
