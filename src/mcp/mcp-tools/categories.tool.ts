import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { CategoriesService } from "src/category/category.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { CategoryEntity } from "entities/categories.entity";
import { listPaging } from "../utils/mcp-dto.util";
import { toolPage } from "../utils/mcp-result.util";
import { ref, TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const listCategoriesInput = z.object({
  ...listPaging({
    items: "categories",
    sortBy: ["created_at", "name", "slug"],
    search: "Matches category name or slug",
  }),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toCategorySummary(row: Partial<CategoryEntity>) {
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
      `List product categories. Use the returned id as categoryId on ${ref(TOOL.products.search)} and ${ref(TOOL.bundles.search)}. Read-only.`,
    parameters: listCategoriesInput,
  })
  async listCategories(
    @Payload() query: z.infer<typeof listCategoriesInput>,
    @McpUser() user: User,
  ) {
    const result = await this.cats.list(user, query);
    return toolPage("categories", result, toCategorySummary, query.limit);
  }
}
