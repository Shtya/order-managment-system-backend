import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { AiService } from "src/ai/ai.service";
import { toolJson } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

const listAiProvidersInput = z.strictObject({
  search: z.string().optional().describe("Matches provider name or code"),
  code: z.string().optional().describe("Exact provider code, e.g. openai"),
});

function toProviderSummary(row: any) {
  return {
    id: row?.id ?? null,
    name: row?.name ?? null,
    code: row?.code ?? null,
    isActive: row?.isActive ?? null,
  };
}

@McpController()
@UseGuards(McpScopeGuard)
export class McpAiTools {
  constructor(private ai: AiService) {}

  @McpReadTool({
    name: TOOL.ai.providersList,
    description:
      "List AI providers connected to the workspace (active with tenant credentials). Use `id` as providerId on the AI address correction step. Read-only.",
    parameters: listAiProvidersInput,
  })
  async listProviders(
    @Payload() input: z.infer<typeof listAiProvidersInput>,
    @McpUser() user: User,
  ) {
    const result = await this.ai.listProviders(user, {
      scope: "all",
      isActive: true,
      search: input.search,
      code: input.code,
    } as any);
    const rows = Array.isArray(result?.records) ? result.records : [];
    return toolJson({
      ai_providers: rows
        .filter((row: any) => row?.isActive !== false && row?.integration?.credentials)
        .map(toProviderSummary),
    });
  }
}
