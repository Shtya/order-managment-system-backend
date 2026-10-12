import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { UpsellsService } from "src/upsells/upsells.service";
import { listPaging, parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";

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
  productId: z
    .string()
    .optional()
    .describe(idDescription("Keep offers for this product (trigger or upsell).", TOOL.products.search)),
  startDate: z.string().optional().describe("Created-at range start, ISO date (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("Created-at range end, ISO date (YYYY-MM-DD)"),
});

const upsellsStatsInput = z.object({
  startDate: z.string().optional().describe("Range start, ISO date (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("Range end, ISO date (YYYY-MM-DD)"),
  range: z.string().optional().describe("Quick range"),
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
    const result = await this.upsells.list(user, req.query);
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
    return toolJson(await this.upsells.stats(user, input));
  }
}
