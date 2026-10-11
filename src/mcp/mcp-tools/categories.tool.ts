import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { CategoriesService } from "src/category/category.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { CreateCategoryDto, UpdateCategoryDto } from "dto/category.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput, toolInputFor } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { ref, TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const listCategoriesInput = searchInput("category", {
  ...listPaging({
    items: "categories",
    sortBy: ["created_at", "name", "slug"],
    search: "Matches category name or slug",
  }),
  slug: z
    .string()
    .optional()
    .describe(
      "Exact slug to look up. 0 rows means the slug is free, 1 row means taken. Do not pass with `id`.",
    ),
});

const saveCategoryFields = toolInputFor<UpdateCategoryDto>()(
  z.object({
    name: z.string().optional().describe("Category name"),
    slug: z
      .string()
      .optional()
      .describe("URL slug, lowercase letters, numbers and dashes only"),
    // image / removeImage never offered: user ignores picture
  }),
);

const saveCategoryInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe(
      'Required. "create" to add a new category. "update" to change an existing one. Never infer from id.',
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Category ID. Required for mode=update. Forbidden for mode=create. Find it with ${ref(TOOL.categories.list)}.`,
    ),
  ...saveCategoryFields.shape,
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toCategorySummary(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    slug: row.slug ?? null,
  };
}

function toCategoryResultDto(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    slug: row.slug ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpCategoriesTools {
  constructor(private cats: CategoriesService) {}

  @McpReadTool({
    name: TOOL.categories.list,
    description:
      `List product categories or fetch one. Without \`id\`: lists categories with paging. Pass \`slug\` for an exact slug lookup (0 rows = free). With \`id\`: returns that single category. Use the returned id as categoryId on ${ref(TOOL.products.search)} and ${ref(TOOL.bundles.search)}. Read-only.`,
    parameters: listCategoriesInput,
  })
  async listCategories(
    @Payload() input: z.infer<typeof listCategoriesInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "category");
    if (req.mode === "get") {
      return toolJson(toCategoryResultDto(await this.cats.get(user, req.id)));
    }
    const { slug, ...rest } = req.query as typeof req.query & { slug?: string };
    const result = await this.cats.list(user, {
      ...rest,
      ...(slug ? { slug } : {}),
    });
    return toolPage("categories", result, toCategorySummary, rest.limit);
  }

  @McpSaveTool({
    name: TOOL.categories.save,
    description:
      "Create or update a product category. Required: mode (\"create\" or \"update\"). Required for create: name, slug. For update: `id` plus name and/or slug. Before create, check the slug with `list_categories` `{ \"slug\": \"…\" }`. No picture fields.",
    parameters: saveCategoryInput,
  })
  async saveCategory(
    @Payload() input: z.infer<typeof saveCategoryInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "category", TOOL.categories.list);
    if (req.mode === "create") {
      const parsed = await parseDto(CreateCategoryDto, req.fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toCategoryResultDto(await this.cats.create(user, parsed.dto)));
    }
    const parsed = await parseDto(UpdateCategoryDto, req.fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toCategoryResultDto(await this.cats.update(user, req.id, parsed.dto)));
  }
}
