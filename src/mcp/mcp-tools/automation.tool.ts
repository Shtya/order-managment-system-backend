import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { AutomationService } from "src/automation/automation.service";
import { toolJson } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

const automationStatsInput = z.object({
  report: z
    .enum(["flows", "runs"])
    .optional()
    .describe("Which stats to return. flows (default): flow list header { total, published, draft, paused, archived }. runs: logs header { total, pending, running, completed, failed, paused }."),
});

const runsRetryInput = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Failed run UUID. There is no run-list tool; the user must supply it (automation logs URL or a pasted id). Never guess.",
    ),
  useLatestVersion: z
    .boolean()
    .optional()
    .describe("Retry on the flow's latest version and reset node progress. Omit to retry the same version."),
});

@McpController()
@UseGuards(McpScopeGuard)
export class McpAutomationTools {
  constructor(private automation: AutomationService) {}

  @McpReadTool({
    name: TOOL.automation.stats,
    description:
      "Automation headers. Pass `report`: flows (default) or runs. No date filters, no flow/run lists. Read-only.",
    parameters: automationStatsInput,
  })
  async getStats(
    @Payload() input: z.infer<typeof automationStatsInput>,
    @McpUser() user: User,
  ) {
    const report = (input as any)?.report ?? "flows";
    if (report === "runs") {
      return toolJson({ report, ...(await this.automation.getRunsStats(user)) });
    }
    return toolJson({ report, ...(await this.automation.getFlowsStats(user)) });
  }

  @McpSaveTool({
    name: TOOL.automation.runsRetry,
    description:
      "Retry a failed automation run (dedicated action, not save). Required: id of a FAILED run. Optional useLatestVersion. Only failed runs are retriable; the service errors otherwise. Returns the run id, status, flow and version ids with the queue message. No execution state dump.",
    parameters: runsRetryInput,
  })
  async retryRun(
    @Payload() input: z.infer<typeof runsRetryInput>,
    @McpUser() user: User,
  ) {
    const result = await this.automation.retryRun(user, input.id, (input as any).useLatestVersion);
    const run = (result as any)?.run ?? {};
    return toolJson({
      id: run.id ?? input.id,
      status: run.status ?? null,
      automationFlowId: run.automationFlowId ?? null,
      versionId: run.versionId ?? null,
      errorMessage: run.errorMessage ?? null,
      message: (result as any)?.message ?? null,
    });
  }
}
