import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { BundlesService } from "src/bundles/bundles.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { CreateBundleDto, UpdateBundleDto } from "dto/bundle.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput, toolInputFor } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";
import { uuidField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

export const searchBundlesInput = searchInput("bundle", {
  ...listPaging({
    items: "bundles",
    sortBy: ["created_at", "name", "sku", "price", "isActive"],
    search: "Matches bundle name, SKU, or slug",
  }),
  sku: z
    .string()
    .optional()
    .describe("Exact bundle SKU. Do not pass with `id`."),
  slug: z
    .string()
    .optional()
    .describe("Exact bundle slug (case-insensitive). Do not pass with `id`."),
  categoryId: uuidField(idDescription("Keep only bundles of this category.", TOOL.categories.list)).optional(),
  storeId: uuidField(idDescription("Keep only bundles of this store.", TOOL.stores.list)).optional(),
}, TOOL.bundles.search);

const saveBundleFields = toolInputFor<UpdateBundleDto>()(
  z.object({
    name: z.string().optional().describe("Bundle name"),
    description: z.string().optional().describe("Bundle description"),
    price: z.number().optional().describe("Bundle price"),
    storeId: uuidField(idDescription("Store id.", TOOL.stores.list)).optional(),
    categoryId: uuidField(idDescription("Category id.", TOOL.categories.list)).optional(),
    slug: z.string().optional().describe("URL slug, lowercase letters, numbers and dashes"),
    aiEnabled: z.boolean().optional().describe("Whether AI description is enabled"),
    aiDescription: z.string().optional().describe("AI-generated description"),
    aiKeywords: z.array(z.string()).optional().describe("AI keywords, up to 20"),
    items: z
      .array(
        z.object({
          variantId: uuidField(idDescription("Variant id of the product.", TOOL.products.search)),
          qty: z.number().int().min(1).describe("Quantity: a whole number, at least 1"),
        }),
      )
      .optional()
      .describe("Bundle lines. Required for create. DTO uses `qty`, not `quantity`."),
    // sku is create-only (UpdateBundleDto omits it): added on save input, not here
    // mainImage / images / orphan ids / removeImgs never offered: file upload
  }),
);

const saveBundleInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe(
      'Required. "create" to add a new bundle. "update" to change an existing one. Never infer from id.',
    ),
  id: uuidField(
    idDescription("Bundle ID.", TOOL.bundles.search, "Required for mode=update. Forbidden for mode=create."),
  ).optional(),
  sku: z
    .string()
    .optional()
    .describe("Bundle SKU. Required for create. Do not send on update."),
  ...saveBundleFields.shape,
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
      `Search bundles or fetch one. Without \`id\`: lists ACTIVE bundles with paging, filtered by search text, exact sku or slug, category, or store. With \`id\`: returns that single bundle with full details.`,
    parameters: searchBundlesInput,
  })
  async searchBundles(@Payload() input: z.infer<typeof searchBundlesInput>, @McpUser() user: User) {
    const req = parseSearchInput(input, "bundle");

    if (req.mode === "get") {
      return toolJson(toBundleResultDto(await this.bundles.get(user, req.id)));
    }
    const { sku, slug, isActive, ...rest } = req.query as typeof req.query & {
      sku?: string;
      slug?: string;
      isActive?: boolean;
    };
    const result = await this.bundles.list(user, {
      ...rest,
      ...(sku ? { sku } : {}),
      ...(slug ? { slug } : {}),
      ...(isActive === false ? { isActive: "false" } : {}),
    });
    return toolPage("bundles", result, toBundleSummary, (rest as any).limit);
  }

  @McpSaveTool({
    name: TOOL.bundles.save,
    description:
      'Create or update a bundle. Required: mode ("create" or "update"). Required for create: name, sku, price, items (variantId + qty). Optional: description, slug, storeId, categoryId, aiEnabled, aiDescription, aiKeywords. For update: `id` plus any fields to change. Do not send `sku` on update. Before create, check sku/slug with `bundles_search`. No picture fields.',
    parameters: saveBundleInput,
  })
  async saveBundle(
    @Payload() input: z.infer<typeof saveBundleInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "bundle", TOOL.bundles.search);
    if (req.mode === "create") {
      const parsed = await parseDto(CreateBundleDto, { ...req.fields, sku: (input as any).sku });
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toBundleResultDto(await this.bundles.create(user, parsed.dto)));
    }
    if ((input as any).sku !== undefined && (input as any).sku !== "") {
      throw new RpcException(
        `sku is create-only. Do not send it on update. Find the bundle with ${TOOL.bundles.search}.`,
      );
    }
    const parsed = await parseDto(UpdateBundleDto, req.fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toBundleResultDto(await this.bundles.update(user, req.id, parsed.dto)));
  }
}
