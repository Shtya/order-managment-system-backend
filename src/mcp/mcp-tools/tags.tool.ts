import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { TagsService } from "src/tags/tags.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { TagEntity, TagTarget } from "entities/tag.entity";
import { CreateTagDto, UpdateTagDto } from "dto/tag.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput, toolInputFor } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { ref, TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const listTagsInput = searchInput("tag", {
  ...listPaging({
    items: "tags",
    sortBy: ["priority", "name", "created_at", "isActive", "target"],
    defaultSortBy: "priority",
    search: "Matches tag name or description",
  }),
  target: z.enum(TagTarget).optional().describe("Only tags for this target. Omit for order tags."),
});

const saveTagFields = toolInputFor<UpdateTagDto>()(
  z.object({
    name: z.string().optional().describe("Tag name"),
    color: z.string().optional().describe("Hex color, e.g. #6C5CE7"),
    description: z.string().optional().describe("What this tag is for"),
    target: z.enum(TagTarget).optional().describe("Which entity this tag applies to"),
    isActive: z.boolean().optional().describe("False to deactivate. Replaces toggle-active"),
    allowManualAssignment: z.boolean().optional().describe("False hides it from employees. Replaces toggle-employee-use"),
    employeeIds: z.array(z.string()).optional().describe("Employees allowed to use it when allowManualAssignment is true"),
    priority: z.number().int().min(0).optional().describe("Higher shows first"),
    // conditions / automations are separate admin tools, not offered here
  }),
);

const saveTagInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe(
      'Required. "create" to add a new tag. "update" to change an existing one. Never infer from id.',
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Tag ID. Required for mode=update. Forbidden for mode=create. Find it with ${ref(TOOL.tags.list)}.`,
    ),
  ...saveTagFields.shape,
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toTagSummary(row: Partial<TagEntity>) {
  return {
    id: row.id,
    name: row.name ?? null,
    color: (row as any).color ?? null,
    target: (row as any).target ?? null,
  };
}

function toTagResultDto(row: Partial<TagEntity>) {
  return {
    id: row.id,
    name: row.name ?? null,
    color: (row as any).color ?? null,
    description: (row as any).description ?? null,
    target: (row as any).target ?? null,
    isActive: (row as any).isActive ?? null,
    allowManualAssignment: (row as any).allowManualAssignment ?? null,
    priority: (row as any).priority ?? null,
    ordersCount: (row as any).ordersCount ?? null,
    clientsCount: (row as any).clientsCount ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpTagsTools {
  constructor(private tags: TagsService) {}

  @McpReadTool({
    name: TOOL.tags.list,
    description:
      "List tags or fetch one. Without `id`: lists the tags of the signed-in Madar user's workspace with paging. With `id`: returns that single tag with counts. Read-only.",
    parameters: listTagsInput,
  })
  async listTags(
    @Payload() input: z.infer<typeof listTagsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "tag");
    if (req.mode === "get") {
      return toolJson(toTagResultDto(await this.tags.get(user, req.id)));
    }
    const result = await this.tags.list(user, req.query);
    return toolPage("tags", result, toTagSummary, req.query.limit);
  }

  @McpSaveTool({
    name: TOOL.tags.save,
    description:
      'Create or update a tag. Required: mode ("create" or "update"). Required for create: name. Optional: color, target, description, isActive, allowManualAssignment, employeeIds, priority. For update: `id` plus any fields to change. `isActive` covers toggle-active.',
    parameters: saveTagInput,
  })
  async saveTag(
    @Payload() input: z.infer<typeof saveTagInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "tag", TOOL.tags.list);
    if (req.mode === "create") {
      const parsed = await parseDto(CreateTagDto, req.fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toTagResultDto(await this.tags.create(user, parsed.dto)));
    }
    const parsed = await parseDto(UpdateTagDto, req.fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toTagResultDto(await this.tags.update(user, req.id, parsed.dto)));
  }
}
