import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { ProductsService } from "src/products/products.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { listPaging } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const listProductsInput = z.object({
  ...listPaging({
    items: "products",
    sortBy: ["created_at", "name", "sku", "salePrice", "isActive"],
    search: "Matches product name, slug, or variant SKU",
  }),
  categoryId: z
    .string()
    .optional()
    .describe(idDescription("Keep only products of this category.", TOOL.categories.list)),
  storeId: z
    .string()
    .optional()
    .describe(idDescription("Keep only products of this store.", TOOL.stores.list)),
});

export const getProductInput = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "ID of the product to retrieve.",
    ),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
//    Costs (wholesalePrice, unitCost) are never exposed.
// ═══════════════════════════════════════════════════════════════

function toProductSummary(row: any) {
  const skus = Array.isArray(row?.skus) ? row.skus : [];
  return {
    id: row.id,
    name: row.name ?? null,
    sku: row.sku ?? null,
    salePrice: row.salePrice ?? null,
    categoryName: row.category?.name ?? null,
    storeName: row.store?.name ?? null,
    variants: skus.map((s: any) => ({
      variantId: s.id ?? null,
      sku: s.sku ?? null,
      key: s.key ?? null,
      price: s.price ?? null,
      stockOnHand: s.stockOnHand ?? null,
      available: s.available ?? null,
    })),
  };
}

function toProductResultDto(row: any) {
  const skus = Array.isArray(row?.skus) ? row.skus : [];
  return {
    id: row.id,
    name: row.name ?? null,
    sku: row.sku ?? null,
    slug: row.slug ?? null,
    salePrice: row.salePrice ?? null,
    lowestPrice: row.lowestPrice ?? null,
    type: row.type ?? null,
    description: row.description ?? null,
    category: row.category
      ? { id: row.category.id ?? row.categoryId ?? null, name: row.category.name ?? null }
      : null,
    store: row.store
      ? { id: row.store.id ?? row.storeId ?? null, name: row.store.name ?? null }
      : null,
    warehouse: row.warehouse
      ? { id: row.warehouse.id ?? row.warehouseId ?? null, name: row.warehouse.name ?? null }
      : null,
    storageLocation: row.storageLocation
      ? {
          id: row.storageLocation.id ?? row.storageLocationId ?? null,
          name: row.storageLocation.name ?? null,
        }
      : null,
    variants: skus.map((s: any) => ({
      variantId: s.id ?? null,
      sku: s.sku ?? null,
      key: s.key ?? null,
      price: s.price ?? null,
      stockOnHand: s.stockOnHand ?? null,
      available: s.available ?? null,
      attributes: s.attributes ?? null,
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
export class McpProductsTools {
  constructor(private products: ProductsService) {}

  @McpReadTool({
    name: TOOL.products.list,
    description:
      "List the products with their variants and sale prices. Use the returned variantId and price when creating an order. Read-only.",
    parameters: listProductsInput,
  })
  async listProducts(
    @Payload() query: z.infer<typeof listProductsInput>,
    @McpUser() user: User,
  ) {
    const result = await this.products.list(user, query);
    return toolPage("products", result, toProductSummary, query.limit);
  }

  @McpReadTool({
    name: TOOL.products.get,
    description:
      "Get a single product with its variants, prices, and stock.",
    parameters: getProductInput,
  })
  async getProduct(
    @Payload() input: z.infer<typeof getProductInput>,
    @McpUser() user: User,
  ) {
    const result = await this.products.get(user, input.id);
    return toolJson(toProductResultDto(result));
  }
}
