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
    // providerId = shipping company id (shippingCompanyId on other tools).
    // integrationId = this workspace's connection. Never pass it as shippingCompanyId.
    providerId: row.providerId ?? null,
    integrationId: row.id ?? null,
    provider: row.provider ?? null,
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
      "List shipping companies connected to this workspace. Each row is an integration: `providerId` is the shipping company id — pass it as `shippingCompanyId` on other tools. `integrationId` is the workspace connection, not the company. `provider` is the provider code — pass it as `provider` on warehouse_ops_act assign. Never use `integrationId` as shippingCompanyId. Read-only.",
    parameters: listShippingCompaniesInput,
  })
  async listShippingCompanies(@McpUser() user: User) {
    const result = await this.shipping.activeIntegrations(user);
    const rows = Array.isArray(result?.integrations) ? result.integrations : [];
    return toolJson({ shipping_companies: rows.map(toShippingCompanySummary) });
  }
}
