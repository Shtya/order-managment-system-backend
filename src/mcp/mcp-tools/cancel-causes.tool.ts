import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { CancelCausesService } from "src/cancel-causes/cancel-causes.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { listPaging } from "../utils/mcp-dto.util";
import { toolPage } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const listCancelCausesInput = z.object({
  ...listPaging({
    items: "cancel causes",
    sortBy: ["sortOrder", "name", "created_at", "updated_at"],
    defaultSortBy: "sortOrder",
    search: "Matches cancel-cause name or code",
  }),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toCancelCauseSummary(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    code: row.code ?? null,
    sortOrder: row.sortOrder ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpCancelCausesTools {
  constructor(private cancelCauses: CancelCausesService) {}

  @McpReadTool({
    name: TOOL.cancelCauses.list,
    description:
      "List the approved, active cancel causes of the signed-in Madar user's workspace. Read-only.",
    parameters: listCancelCausesInput,
  })
  async listCancelCauses(
    @Payload() query: z.infer<typeof listCancelCausesInput>,
    @McpUser() user: User,
  ) {
    const result = await this.cancelCauses.listSelectable(user, query);
    return toolPage("cancel_causes", result, toCancelCauseSummary, query.limit);
  }
}
