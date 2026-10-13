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
import { isSet, listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput, toolInputFor } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, ref, TOOL } from "../utils/mcp-tool-names";
import { businessDayRange, isoDateField, uuidField } from "../utils/mcp-date.util";

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
  type: z
    .enum(["PRODUCT", "PRODUCT_IDLE"])
    .optional()
    .describe("Catalog tab. PRODUCT (default): active (or inactive) products. PRODUCT_IDLE: products created on or before idleBefore with no orders after that date. Requires idleBefore."),
  idleBefore: isoDateField("Idle cutoff, ISO date (YYYY-MM-DD). Required with type=PRODUCT_IDLE. Same as the Idle tab created_at.lte.").optional(),
  isActive: z
    .boolean()
    .optional()
    .describe("True (default): active products. False: deactivated / deleted_products tab."),
  categoryId: uuidField(idDescription("Keep only products of this category.", TOOL.categories.list)).optional(),
  storeId: uuidField(idDescription("Keep only products of this store.", TOOL.stores.list)).optional(),
  warehouseId: uuidField(idDescription("Keep only products of this warehouse.", TOOL.warehouses.search)).optional(),
  storageLocationId: uuidField(idDescription("Keep only products of this storage location.", TOOL.warehouses.locationsSearch)).optional(),
  productType: z.enum(ProductType).optional().describe("single or variable. Omit for both."),
  variantId: uuidField(
    idDescription(
      "Keep only the product that owns this variant.",
      TOOL.products.search,
      `Use a variantId from a previous ${ref(TOOL.products.search)} row, or from an order line on ${ref(TOOL.orders.search)}.`,
    ),
  ).optional(),
  salePriceMin: z.number().optional().describe("Minimum sale price (salePrice.gte)."),
  salePriceMax: z.number().optional().describe("Maximum sale price (salePrice.lte)."),
  wholesalePriceMin: z.number().optional().describe("Minimum purchase/wholesale price filter. Not returned on rows."),
  wholesalePriceMax: z.number().optional().describe("Maximum purchase/wholesale price filter. Not returned on rows."),
}, TOOL.products.search);

const saveProductFields = toolInputFor<UpdateProductDto>()(
  z.object({
    name: z.string().optional().describe("Product name"),
    slug: z.string().optional().describe("URL slug, lowercase letters, numbers and dashes"),
    type: z.enum(ProductType).optional().describe("Product type. Create only, do not send on update"),
    salePrice: z.number().optional().describe("Sale price"),
    lowestPrice: z.number().optional().describe("Lowest allowed price"),
    wholesalePrice: z.number().optional().describe("Purchase cost per unit (invoice lines only, never exposed on search)"),
    categoryId: uuidField(idDescription("Category id.", TOOL.categories.list)).optional(),
    storeId: uuidField(idDescription("Store id.", TOOL.stores.list)).optional(),
    warehouseId: uuidField(idDescription("Warehouse id.", TOOL.warehouses.search)).optional(),
    storageLocationId: uuidField(idDescription("Storage location id.", TOOL.warehouses.locationsSearch)).optional(),
    description: z.string().optional().describe("Product description"),
    callCenterProductDescription: z.string().optional().describe("Call-center description"),
    aiEnabled: z.boolean().optional().describe("Whether AI description is enabled"),
    aiDescription: z.string().optional().describe("AI-generated description"),
    aiKeywords: z.array(z.string()).optional().describe("AI keywords, up to 20"),
    upsellingEnabled: z.boolean().optional().describe("Whether upselling is enabled"),
    upsellingProducts: z
      .array(
        z.object({
          productId: uuidField(idDescription("Upsell product id.", TOOL.products.search)),
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
    mainImage: z
      .string()
      .optional()
      .describe("Main product image URL. Recommended on create; on update replaces the current main image."),
    removeImgs: z
      .array(z.string())
      .optional()
      .describe("Update only. Gallery image URLs to remove. Get them from products_search with id."),
  }),
);

const saveProductInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe(
      'Required. "create" to add a new product. "update" to change an existing one. Never infer from id.',
    ),
  id: uuidField(idDescription("Product ID.", TOOL.products.search, "Required for mode=update. Forbidden for mode=create.")).optional(),
  sku: z
    .string()
    .optional()
    .describe("Product SKU. Required for create. Do not send on update."),
  ...saveProductFields.shape,
  images: z
    .array(z.string())
    .optional()
    .describe(
      "Gallery image URLs (http/https or stored path). Create: sets the gallery. Update: appends (max 20 total). Not orphan ids.",
    ),
  purchaseReceiptAssetUrl: z
    .string()
    .optional()
    .describe(
      "Create only. Receipt file URL for the nested product purchase. Maps to purchase.receiptAsset. Send with purchase.receiptNumber, purchase.safeId, and quantity.",
    ),
  purchase: z
    .object({
      receiptNumber: z.string().optional().describe("Purchase receipt number"),
      safeId: uuidField(idDescription("Safe id for the purchase payment.", TOOL.safes.list)).optional(),
      supplierId: uuidField(idDescription("Supplier id.", TOOL.suppliers.search)).optional(),
      quantity: z.number().optional().describe("Purchased quantity for a single product"),
      wholesalePrice: z.number().optional().describe("Purchase cost per unit"),
      paidAmount: z.number().optional().describe("Amount already paid"),
      notes: z.string().optional().describe("Purchase notes"),
      saveAsDraft: z.boolean().optional().describe("True to save the nested purchase as draft"),
      receiptAsset: z.string().optional().describe("Receipt file URL. Prefer purchaseReceiptAssetUrl at the top level."),
    })
    .optional()
    .describe("Optional nested purchase on create. Needs receiptNumber, safeId, and quantity (or variant stock) to actually create an invoice."),
});

const productsStatsInput = z.strictObject({
  report: z
    .enum(["stock"])
    .optional()
    .describe("Which report to return. stock (default): workspace inventory totals, not a product list."),
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
    type: row.type ?? null,
    isActive: row.isActive ?? null,
    mainImage: row.mainImage ?? null,
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
    mainImage: row.mainImage ?? null,
    images: (Array.isArray(row.images) ? row.images : [])
      .map((img: any) => (typeof img === "string" ? img : img?.url))
      .filter(Boolean),
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

function toProductSavePayload(
  fields: Record<string, unknown>,
  mode: "create" | "update",
) {
  const { images, purchaseReceiptAssetUrl, purchase, ...rest } = fields as {
    images?: string[];
    purchaseReceiptAssetUrl?: string;
    purchase?: Record<string, unknown>;
    [k: string]: unknown;
  };
  const payload: Record<string, unknown> = { ...rest };
  if (images !== undefined) {
    payload.images = images
      .map((url) => ({ url: String(url).trim() }))
      .filter((img) => img.url);
  }
  if (mode === "update") {
    if (isSet(purchaseReceiptAssetUrl) || purchase !== undefined) {
      throw new RpcException(
        "purchase and purchaseReceiptAssetUrl are create-only. Do not send them on update.",
      );
    }
    return payload;
  }
  if (isSet(purchaseReceiptAssetUrl)) {
    payload.purchase = {
      ...(purchase ?? {}),
      receiptAsset: purchaseReceiptAssetUrl,
    };
  } else if (purchase !== undefined) {
    payload.purchase = purchase;
  }
  return payload;
}

function toProductStockStats(summary: any, report: string) {
  return {
    report,
    productCount: Number(summary?.productCount ?? 0),
    inventory: {
      reserved: Number(summary?.inventory?.reserved ?? 0),
      available: Number(summary?.inventory?.available ?? 0),
      totalOnHand: Number(summary?.inventory?.totalOnHand ?? 0),
    },
    damaged: {
      customer: Number(summary?.damaged?.customer ?? 0),
      company: Number(summary?.damaged?.company ?? 0),
    },
    orders: {
      soldQuantity: Number(summary?.orders?.soldQuantity ?? 0),
      inTransitQuantity: Number(summary?.orders?.inTransitQuantity ?? 0),
    },
    purchases: {
      acceptedQuantity: Number(summary?.purchases?.acceptedQuantity ?? 0),
    },
    purchaseReturns: {
      acceptedReturnedQuantity: Number(summary?.purchaseReturns?.acceptedReturnedQuantity ?? 0),
    },
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
      "Search products or fetch one. Without `id`: lists products like the catalog tabs (active, deactivated, or idle). Filters: search, category, store, warehouse, storage location, productType (single/variable), variantId, sale/wholesale price range, isActive, type PRODUCT or PRODUCT_IDLE (needs idleBefore). Use the returned variantId and price when creating an order. With `id`: that product's details (product id, not variant id). Read-only.",
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
    const q = req.query as typeof req.query & {
      type?: "PRODUCT" | "PRODUCT_IDLE";
      idleBefore?: string;
      isActive?: boolean;
      warehouseId?: string;
      storageLocationId?: string;
      productType?: ProductType;
      salePriceMin?: number;
      salePriceMax?: number;
      wholesalePriceMin?: number;
      wholesalePriceMax?: number;
    };
    const listType = q.type ?? "PRODUCT";
    if (listType === "PRODUCT_IDLE" && !isSet(q.idleBefore)) {
      throw new RpcException("type=PRODUCT_IDLE requires `idleBefore` (YYYY-MM-DD), the Idle tab cutoff date.");
    }
    if (isSet(q.idleBefore) && listType !== "PRODUCT_IDLE") {
      throw new RpcException("`idleBefore` is only valid with type=PRODUCT_IDLE. Set type to PRODUCT_IDLE or remove idleBefore.");
    }
    if (isSet(q.salePriceMin) && isSet(q.salePriceMax) && Number(q.salePriceMin) > Number(q.salePriceMax)) {
      throw new RpcException("`salePriceMin` is greater than `salePriceMax`. Swap them.");
    }
    if (isSet(q.wholesalePriceMin) && isSet(q.wholesalePriceMax) && Number(q.wholesalePriceMin) > Number(q.wholesalePriceMax)) {
      throw new RpcException("`wholesalePriceMin` is greater than `wholesalePriceMax`. Swap them.");
    }
    const idleEnd = listType === "PRODUCT_IDLE" ? businessDayRange(q.idleBefore, q.idleBefore).end : undefined;
    const result = await this.products.list(user, {
      page: q.page,
      limit: q.limit,
      sortBy: q.sortBy,
      sortOrder: q.sortOrder,
      search: q.search,
      categoryId: q.categoryId,
      storeId: q.storeId,
      warehouseId: q.warehouseId,
      storageLocationId: q.storageLocationId,
      productType: q.productType,
      variantId: q.variantId,
      type: listType,
      ...(q.isActive === false ? { isActive: "false" } : {}),
      ...(isSet(q.salePriceMin) ? { "salePrice.gte": q.salePriceMin } : {}),
      ...(isSet(q.salePriceMax) ? { "salePrice.lte": q.salePriceMax } : {}),
      ...(isSet(q.wholesalePriceMin) ? { "wholesalePrice.gte": q.wholesalePriceMin } : {}),
      ...(isSet(q.wholesalePriceMax) ? { "wholesalePrice.lte": q.wholesalePriceMax } : {}),
      ...(idleEnd ? { "created_at.lte": idleEnd } : {}),
    });
    return toolPage("products", result, toProductSummary, q.limit);
  }

  @McpSaveTool({
    name: TOOL.products.save,
    description:
      'Create or update a product. Required: mode ("create" or "update"). Required for create: name, slug, sku. Optional: mainImage (URL), images (gallery URL list), type, prices, category, store, warehouse, descriptions, AI, upselling, combinations, nested purchase. Create receipt: purchaseReceiptAssetUrl (needs purchase.receiptNumber, purchase.safeId, quantity). For update: `id` plus fields to change, including mainImage URL, images URLs to append, and removeImgs. Do not send sku, type, or purchaseReceiptAssetUrl on update.',
    parameters: saveProductInput,
  })
  async saveProduct(
    @Payload() input: z.infer<typeof saveProductInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "product", TOOL.products.search, {
      updateOnlyKeys: ["removeImgs"],
    });
    const payload = toProductSavePayload(req.fields, req.mode);
    if (req.mode === "create") {
      const parsed = await parseDto(CreateProductDto, {
        ...payload,
        sku: (input as any).sku,
        skipRemoteCheck: !isSet(payload.mainImage),
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
    const parsed = await parseDto(UpdateProductDto, payload);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toProductResultDto(await this.products.update(user, req.id, parsed.dto)));
  }

  @McpReadTool({
    name: TOOL.products.stats,
    description:
      `Workspace stock totals. Pass \`report\`: stock (default) — product count, on-hand / reserved / available, damaged, sold and in-transit quantities, accepted purchase and purchase-return quantities. Not a product list; use ${ref(TOOL.products.search)} for individual SKUs. Read-only.`,
    parameters: productsStatsInput,
  })
  async getProductsStats(
    @Payload() input: z.infer<typeof productsStatsInput>,
    @McpUser() user: User,
  ) {
    const report = (input as any)?.report ?? "stock";
    return toolJson(toProductStockStats(await this.products.getAdminSummary(user), report));
  }
}
