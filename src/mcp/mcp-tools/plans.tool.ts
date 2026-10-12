import { UseGuards } from "@nestjs/common";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { PlansService } from "src/plans/plans.service";
import { toolJson } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

const plansListInput = z.strictObject({});

@McpController()
@UseGuards(McpScopeGuard)
export class McpPlansTools {
  constructor(private plans: PlansService) {}

  @McpReadTool({
    name: TOOL.plans.list,
    description: "List subscription plans with prices and limits. Read-only.",
    parameters: plansListInput,
  })
  async listPlans(@McpUser() user: User) {
    const rows = await this.plans.list(user as any, {});
    const records = Array.isArray(rows) ? rows : [];
    return toolJson({
      plans: records.map((p: any) => ({
        id: p.id ?? null,
        name: p.name ?? null,
        price: Number(p.price ?? 0),
        includedOrders: p.includedOrders ?? null,
        usersLimit: p.usersLimit ?? null,
        storesLimit: p.storesLimit ?? null,
        features: p.features ?? [],
      })),
    });
  }
}
