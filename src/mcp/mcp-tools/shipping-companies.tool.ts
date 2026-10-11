import { UseGuards } from "@nestjs/common";
import { McpController } from "@rekog/mcp-nest";
import { ShippingService } from "src/shipping/shipping.service";
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

const listShippingCompaniesInput = z.object({});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toShippingCompanySummary(row: any) {
  return {
    id: row.id ?? null,
    provider: row.provider ?? null,
    providerId: row.providerId ?? null,
    name: row.name ?? null,
    logo: row.logo ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpShippingCompaniesTools {
  constructor(private shipping: ShippingService) {}

  @McpReadTool({
    name: TOOL.shippingCompanies.list,
    description:
      "List the shipping companies connected to the signed-in Madar user's workspace. Read-only.",
    parameters: listShippingCompaniesInput,
  })
  async listShippingCompanies(@McpUser() user: User) {
    const result = await this.shipping.activeIntegrations(user);
    const rows = Array.isArray(result?.integrations) ? result.integrations : [];
    return toolJson({ shipping_companies: rows.map(toShippingCompanySummary) });
  }
}
