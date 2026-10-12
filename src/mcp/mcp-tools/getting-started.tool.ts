import { UseGuards } from "@nestjs/common";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { GettingStartedService } from "src/getting-started/getting-started.service";
import { toolJson } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS: no paging, no id. One call.
// ═══════════════════════════════════════════════════════════════

const gettingStartedStatsInput = z.object({});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: slim rows, steps without actionConfig.
// ═══════════════════════════════════════════════════════════════

function toItemDto(item: any) {
  const steps = Array.isArray(item?.steps) ? item.steps : [];
  return {
    key: item.key ?? null,
    title: item.title ?? null,
    description: item.description ?? null,
    groupNumber: item.groupNumber ?? null,
    completed: item.completed ?? false,
    available: item.available ?? false,
    dependsOn: item.dependsOn ?? [],
    steps: steps.map((s: any) => ({ key: s.key ?? null, title: s.title ?? null })),
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpGettingStartedTools {
  constructor(private gettingStarted: GettingStartedService) {}

  @McpReadTool({
    name: TOOL.gettingStarted.stats,
    description:
      "Tenant onboarding checklist: progress plus slim items with steps. Read-only.",
    parameters: gettingStartedStatsInput,
  })
  async getStats(@McpUser() user: User) {
    const [progress, items] = await Promise.all([
      this.gettingStarted.getProgress(user),
      this.gettingStarted.getItems(user),
    ]);
    const rows = Array.isArray(items) ? items : [];
    return toolJson({ progress: progress ?? null, items: rows.map(toItemDto) });
  }
}
