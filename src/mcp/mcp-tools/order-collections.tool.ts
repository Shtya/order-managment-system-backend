import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { CollectionService } from "src/order-collections/collection.service";
import { assertDateOrder, listPaging } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { shippingCompanyIdDescription, TOOL } from "../utils/mcp-tool-names";
import { isoDateField, uuidField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS
//    Read-only. Service uses sortDir <- sortOrder mapping.
// ═══════════════════════════════════════════════════════════════

const listCollectionsInput = z.object({
  ...listPaging({
    items: "collections",
    sortBy: ["deliveredAt"],
    search: "Matches order number, customer name, or phone",
  }),
  shippingCompanyId: uuidField(shippingCompanyIdDescription()).optional(),
  collectionStatus: z
    .enum(["not_collected", "partial", "fully_collected", "pending"])
    .optional()
    .describe("Collection state. Omit for all delivered orders."),
  startDate: isoDateField("Delivered-at range start, ISO date (YYYY-MM-DD)").optional(),
  endDate: isoDateField("Delivered-at range end, ISO date (YYYY-MM-DD)").optional(),
});

const collectionsStatsInput = z.object({});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: delivered orders only, no record-a-collection.
// ═══════════════════════════════════════════════════════════════

function toCollectionSummary(row: any) {
  return {
    orderId: row.orderId ?? row.id ?? null,
    orderNumber: row.orderNumber ?? null,
    customerName: row.customerName ?? null,
    finalTotal: Number(row.finalTotal ?? row.collectibleAmount ?? 0),
    collectedAmount: Number(row.collectedAmount ?? 0),
    remainingBalance: Number(row.remainingBalance ?? 0),
    shippingCompany: typeof row.shippingCompany === "string" ? row.shippingCompany : (row.shippingCompany?.name ?? null),
    deliveredAt: row.deliveredAt ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpOrderCollectionsTools {
  constructor(private collections: CollectionService) {}

  @McpReadTool({
    name: TOOL.orderCollections.list,
    description:
      "List delivered orders with COD collection rows. Filter by search text, shipping company, collection status, or delivered-at dates. Read-only.",
    parameters: listCollectionsInput,
  })
  async listCollections(
    @Payload() query: z.infer<typeof listCollectionsInput>,
    @McpUser() user: User,
  ) {
    assertDateOrder(query as Record<string, unknown>);
    const result = await this.collections.listCollections(user, {
      ...query,
      sortDir: query.sortOrder,
    });
    return toolPage("collections", result, toCollectionSummary, query.limit);
  }

  @McpReadTool({
    name: TOOL.orderCollections.stats,
    description:
      "COD collection statistics for delivered orders: not/partial/fully collected counts, collected vs non-collected money, plus per-company breakdown. Read-only.",
    parameters: collectionsStatsInput,
  })
  async getCollectionsStats(@McpUser() user: User) {
    return toolJson(await this.collections.getCollectionStatistics(user));
  }
}
