import { UseGuards } from "@nestjs/common";
import { McpController } from "@rekog/mcp-nest";
import { OrdersService } from "src/orders/services/orders.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { toolJson } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const listOrderStatusesInput = z.object({});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toOrderStatusSummary(row: any) {
  return {
    id: row.id ?? null,
    code: row.code ?? null,
    name: row.name ?? null,
    color: row.color ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpOrderStatusesTools {
  constructor(private orders: OrdersService) {}

  @McpReadTool({
    name: TOOL.orderStatuses.list,
    description:
      "List the order statuses of the signed-in Madar user's workspace. Read-only.",
    parameters: listOrderStatusesInput,
  })
  async listOrderStatuses(@McpUser() user: User) {
    const result = await this.orders.getStatuses(user, {});
    const rows = Array.isArray(result) ? result : [];
    return toolJson({ order_statuses: rows.map(toOrderStatusSummary) });
  }
}
