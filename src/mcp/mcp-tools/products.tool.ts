import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { ProductsService } from "src/products/products.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { ProductType } from "entities/sku.entity";
import { CreateProductDto, UpdateProductDto } from "dto/product.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput, toolInputFor } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const searchProductsInput = searchInput("product", {
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
}, TOOL.products.search);

const saveProductFields = toolInputFor<UpdateProductDto>()(
  z.object({
    name: z.string().optional().describe("Product name"),
    slug: z.string().optional().describe("URL slug, lowercase letters, numbers and dashes"),
    type: z.enum(ProductType).optional().describe("Product type. Create only, do not send on update"),
    salePrice: z.number().optional().describe("Sale price"),
    lowestPrice: z.number().optional().describe("Lowest allowed price"),
    wholesalePrice: z.number().optional().describe("Purchase cost per unit (invoice lines only, never exposed on search)"),
    categoryId: z
      .string()
      .optional()
      .describe(idDescription("Category id.", TOOL.categories.list)),
    storeId: z
      .string()
      .optional()
      .describe(idDescription("Store id.", TOOL.stores.list)),
    warehouseId: z.string().optional().describe(idDescription("Warehouse id.", TOOL.warehouses.search)),
    storageLocationId: z.string().optional().describe(idDescription("Storage location id.", TOOL.warehouses.locationsSearch)),
    description: z.string().optional().describe("Product description"),
    callCenterProductDescription: z.string().optional().describe("Call-center description"),
    aiEnabled: z.boolean().optional().describe("Whether AI description is enabled"),
    aiDescription: z.string().optional().describe("AI-generated description"),
    aiKeywords: z.array(z.string()).optional().describe("AI keywords, up to 20"),
    upsellingEnabled: z.boolean().optional().describe("Whether upselling is enabled"),
    upsellingProducts: z
      .array(
        z.object({
          productId: z
            .string()
            .describe(idDescription("Upsell product id.", TOOL.products.search)),
          label: z.string().optional().describe("Upsell label"),
          callCenterDescription: z.string().optional().describe("Call-center description for this upsell"),
        }),
      )
      .optional()
      .describe("Upsell products"),
    combinations: z
      .array(
        z.object({
          sku: z.string().describe("Variant SKU"),
          key: z.string().optional().describe("Variant key, generated from attributes if omitted"),
          price: z.number().optional().describe("Price per variant"),
          stockOnHand: z.number().optional().describe("Stock on hand for this variant"),
          attributes: z.record(z.string(), z.string()).optional().describe("Variant attributes, e.g. { color: \"red\" }"),
        }),
      )
      .optional()
      .describe("Variant combinations for variable products"),
    isActive: z.boolean().optional().describe("False to deactivate. Update only"),
    // mainImage / images / orphan ids / removeImgs / purchase / receipt upload never offered
  }),
);

const saveProductInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe(
      'Required. "create" to add a new product. "update" to change an existing one. Never infer from id.',
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      idDescription("Product ID.", TOOL.products.search, "Required for mode=update. Forbidden for mode=create."),
    ),
  sku: z
    .string()
    .optional()
    .describe("Product SKU. Required for create. Do not send on update."),
  ...saveProductFields.shape,
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
    name: TOOL.products.search,
    description:
      "Search products or fetch one. Without `id`: lists products with variants and sale prices, filtered by search text, category, or store. Use the returned variantId and price when creating an order. With `id`: returns that single product with full details. Read-only.",
    parameters: searchProductsInput,
  })
  async searchProducts(
    @Payload() input: z.infer<typeof searchProductsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "product");
    if (req.mode === "get") {
      return toolJson(toProductResultDto(await this.products.get(user, req.id)));
    }
    const result = await this.products.list(user, req.query);
    return toolPage("products", result, toProductSummary, req.query.limit);
  }

  @McpSaveTool({
    name: TOOL.products.save,
    description:
      'Create or update a product. Required: mode ("create" or "update"). Required for create: name, slug, sku. Optional: type, prices, categoryId, storeId, warehouseId, storageLocationId, descriptions, AI fields, upselling, combinations. For update: `id` plus any fields to change. Do not send `sku` or `type` on update. No picture fields.',
    parameters: saveProductInput,
  })
  async saveProduct(
    @Payload() input: z.infer<typeof saveProductInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "product", TOOL.products.search);
    if (req.mode === "create") {
      const parsed = await parseDto(CreateProductDto, {
        ...req.fields,
        sku: (input as any).sku,
        // Service requires an image unless skipped: MCP never uploads images.
        skipRemoteCheck: true,
      });
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toProductResultDto(await this.products.create(user, parsed.dto)));
    }
    for (const k of ["sku", "type"] as const) {
      const v = (req.fields as Record<string, unknown>)[k];
      if (v !== undefined && v !== "") {
        throw new RpcException(
          `${k} is create-only. Do not send it on update. Find the product with ${TOOL.products.search}.`,
        );
      }
    }
    const parsed = await parseDto(UpdateProductDto, req.fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toProductResultDto(await this.products.update(user, req.id, parsed.dto)));
  }
}
