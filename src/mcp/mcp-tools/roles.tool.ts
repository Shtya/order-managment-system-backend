import { UseGuards } from "@nestjs/common";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { RolesService } from "src/roles/roles.service";
import { toolJson } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

const rolesListInput = z.object({});

@McpController()
@UseGuards(McpScopeGuard)
export class McpRolesTools {
  constructor(private roles: RolesService) {}

  @McpReadTool({
    name: TOOL.roles.list,
    description:
      "List workspace roles. Use the returned id as assignedRoleId on issues_save. Read-only.",
    parameters: rolesListInput,
  })
  async listRoles(@McpUser() user: User) {
    const rows = await this.roles.list(user as any);
    const records = Array.isArray(rows) ? rows : [];
    return toolJson({
      roles: records.map((r: any) => ({
        id: r.id ?? null,
        name: r.name ?? null,
        description: r.description ?? null,
      })),
    });
  }
}
