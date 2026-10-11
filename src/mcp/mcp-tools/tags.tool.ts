import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { TagsService } from "src/tags/tags.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { TagEntity, TagTarget } from "entities/tag.entity";
import { listPaging } from "../utils/mcp-dto.util";
import { toolPage } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const listTagsInput = z.object({
  ...listPaging({
    items: "tags",
    sortBy: ["priority", "name", "created_at", "isActive", "target"],
    defaultSortBy: "priority",
    search: "Matches tag name or description",
  }),
  target: z.enum(TagTarget).default(TagTarget.ORDER).describe("Only tags for this target"),
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
      "List the tags of the signed-in Madar user's workspace. Read-only.",
    parameters: listTagsInput,
  })
  async listTags(
    @Payload() query: z.infer<typeof listTagsInput>,
    @McpUser() user: User,
  ) {
    const result = await this.tags.list(user, query);
    return toolPage("tags", result, toTagSummary, query.limit);
  }
}
