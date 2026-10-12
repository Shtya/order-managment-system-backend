import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { SupplierCategoriesService } from "src/supplier/categories/categories.service";
import { CreateSupplierCategoryDto, UpdateSupplierCategoryDto } from "dto/supplier.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput, toolInputFor } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";

const searchSupplierCategoriesInput = searchInput("supplier category", {
  ...listPaging({
    items: "supplier categories",
    sortBy: ["created_at"],
    search: "Matches category name or description",
  }),
}, TOOL.supplierCategories.search);

const saveSupplierCategoryFields = toolInputFor<UpdateSupplierCategoryDto>()(
  z.object({
    name: z.string().optional().describe("Category name. Required for create"),
    description: z.string().optional().describe("What this category groups"),
  }),
);

const saveSupplierCategoryInput = z.object({
  mode: z.enum(["create", "update"]).describe('Required. "create" or "update". Never infer from id.'),
  id: z.string().min(1).optional().describe(idDescription("Category ID.", TOOL.supplierCategories.search, "Required for mode=update. Forbidden for mode=create.")),
  ...saveSupplierCategoryFields.shape,
});

function toSummary(row: any) {
  return { id: row.id, name: row.name ?? null, description: row.description ?? null };
}

@McpController()
@UseGuards(McpScopeGuard)
export class McpSupplierCategoriesTools {
  constructor(private categories: SupplierCategoriesService) {}

  @McpReadTool({
    name: TOOL.supplierCategories.search,
    description:
      "Search supplier categories or fetch one. Without `id`: paged summaries by search text. With `id`: returns that category. Use the id as categoryIds on suppliers_save. Read-only.",
    parameters: searchSupplierCategoriesInput,
  })
  async search(
    @Payload() input: z.infer<typeof searchSupplierCategoriesInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "supplier category");
    if (req.mode === "get") {
      return toolJson(toSummary(await this.categories.get(user, req.id)));
    }
    const result = await this.categories.list(user, req.query);
    return toolPage("supplier_categories", result, toSummary, req.query.limit);
  }

  @McpSaveTool({
    name: TOOL.supplierCategories.save,
    description:
      'Create or update a supplier category. Required: mode ("create" or "update"). Required for create: name. For update: `id` plus name and/or description. No delete tool.',
    parameters: saveSupplierCategoryInput,
  })
  async save(
    @Payload() input: z.infer<typeof saveSupplierCategoryInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "supplier category", TOOL.supplierCategories.search);
    if (req.mode === "create") {
      const parsed = await parseDto(CreateSupplierCategoryDto, req.fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toSummary(await this.categories.create(user, parsed.dto)));
    }
    const parsed = await parseDto(UpdateSupplierCategoryDto, req.fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toSummary(await this.categories.update(user, req.id, parsed.dto)));
  }
}
