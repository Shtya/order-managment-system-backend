import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { AgentsService } from "src/agents/agents.service";
import { toolPage } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

const listAgentsInput = z.strictObject({
  search: z.string().optional().describe("Matches agent name"),
  isActive: z.boolean().optional().describe("Filter by active flag. Omit for all agents."),
  page: z.number().int().min(1).optional().describe("Page number, starting at 1. Default 1."),
  limit: z.number().int().min(1).max(100).optional().describe("Rows per page. Default 100."),
});

function toAgentSummary(row: any) {
  return {
    id: row?.id ?? null,
    name: row?.name ?? null,
    language: row?.language ?? null,
    isActive: row?.isActive ?? null,
  };
}

@McpController()
@UseGuards(McpScopeGuard)
export class McpAgentsTools {
  constructor(private agents: AgentsService) {}

  @McpReadTool({
    name: TOOL.agents.list,
    description:
      "List workspace AI agents. Use `id` as agentId on the AI address correction step. Read-only.",
    parameters: listAgentsInput,
  })
  async listAgents(
    @Payload() input: z.infer<typeof listAgentsInput>,
    @McpUser() user: User,
  ) {
    const limit = input.limit ?? 100;
    const result = await this.agents.list(user as any, { ...input, limit });
    return toolPage("agents", result, toAgentSummary, limit);
  }
}
