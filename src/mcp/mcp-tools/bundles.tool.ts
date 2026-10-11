import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { BundlesService } from "src/bundles/bundles.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { listPaging, parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

export const searchBundlesInput = searchInput("bundle", {
  ...listPaging({
    items: "bundles",
    sortBy: ["created_at", "name", "sku", "price", "isActive"],
    search: "Matches bundle name or SKU",
  }),
  categoryId: z
    .string()
    .optional()
    .describe(idDescription("Keep only bundles of this category.", TOOL.categories.list)),
  storeId: z
    .string()
    .optional()
    .describe(idDescription("Keep only bundles of this store.", TOOL.stores.list)),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toBundleSummary(row: any) {
  const items = Array.isArray(row?.items) ? row.items : [];
  return {
    id: row.id,
    name: row.name ?? null,
    sku: row.sku ?? null,
    price: row.price ?? null,
    items: items.map((i: any) => ({
      variantId: i.variantId ?? i.variant?.id ?? null,
      quantity: i.quantity ?? i.qty ?? null,
    })),
  };
}

function toBundleResultDto(row: any) {
  const items = Array.isArray(row?.items) ? row.items : [];
  return {
    id: row.id,
    name: row.name ?? null,
    sku: row.sku ?? null,
    slug: row.slug ?? null,
    price: row.price ?? null,
    isActive: row.isActive ?? null,
    category: row.category
      ? { id: row.category.id ?? row.categoryId ?? null, name: row.category.name ?? null }
      : null,
    store: row.store
      ? { id: row.store.id ?? row.storeId ?? null, name: row.store.name ?? null }
      : null,
    items: items.map((i: any) => ({
      variantId: i.variantId ?? i.variant?.id ?? null,
      sku: i.variant?.sku ?? null,
      productName: i.variant?.product?.name ?? null,
      quantity: i.quantity ?? i.qty ?? null,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpBundlesTools {
  constructor(private bundles: BundlesService) {}

  @McpReadTool({
    name: TOOL.bundles.search,
    description:
      `Search bundles or fetch one. Without \`id\`: lists bundles with paging, filtered by search text, category, or store. With \`id\`: returns that single bundle with full details.`,
    parameters: searchBundlesInput,
  })
  async searchBundles(@Payload() input: z.infer<typeof searchBundlesInput>, @McpUser() user: User) {
    const req = parseSearchInput(input, "bundle");

    if (req.mode === "get") {
      return toolJson(toBundleResultDto(await this.bundles.get(user, req.id)));
    }
    const result = await this.bundles.list(user, req.query);
    return toolPage("bundles", result, toBundleSummary, req.query.limit);
  }
}
