import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { ShippingService } from "src/shipping/shipping.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { tenantId } from "src/category/category.service";
import { toolJson } from "../utils/mcp-result.util";
import { ref, TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const listShippingCompaniesInput = z.object({});

const shippingGeoInput = z.object({
  kind: z
    .enum(["cities", "zones", "districts"])
    .describe(
      "cities: carrier city list (optional; prefer list_cities with provider). zones: Turbo areas for a provider city. districts: Bosta districts for a provider city.",
    ),
  provider: z
    .string()
    .describe(
      `Carrier code from ${ref(TOOL.shippingCompanies.list)} row.provider (bosta, turbo). Not providerId.`,
    ),
  cityId: z
    .string()
    .optional()
    .describe(
      `Provider city id (providerCityId from ${ref(TOOL.cities.list)} with provider=bosta|turbo). Required for zones and districts. Never a Madar city UUID, never shippingCompanyId.`,
    ),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toGeoRecord(row: any) {
  return {
    id: row?.id ?? row?._id ?? null,
    nameEn: row?.nameEn ?? row?.name ?? null,
    nameAr: row?.nameAr ?? row?.name ?? null,
    parentId: row?.parentId ?? row?.zoneId ?? null,
    dropOff: row?.dropOff ?? null,
    pickup: row?.pickup ?? null,
  };
}

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

  @McpReadTool({
    name: TOOL.shippingCompanies.geo,
    description:
      `Carrier geography for assign. kind=cities: raw carrier cities (prefer ${ref(TOOL.cities.list)} with provider= for Madar city id + providerCityId). kind=zones: Turbo zones — pass cityId = providerCityId, then use the returned id as zoneId on warehouse_ops_act update_shipping/assign. kind=districts: Bosta districts — same cityId, use returned id as districtId. Bosta needs districts; Turbo needs zones. none needs neither. Read-only.`,
    parameters: shippingGeoInput,
  })
  async getShippingGeo(
    @Payload() input: z.infer<typeof shippingGeoInput>,
    @McpUser() user: User,
  ) {
    const adminId = tenantId(user);
    if (!adminId) {
      throw new RpcException("Missing admin id.");
    }
    const provider = String(input.provider ?? "").trim().toLowerCase();
    if (!provider || provider === "none") {
      throw new RpcException("`provider` must be a carrier code (bosta, turbo), not none.");
    }
    if (input.kind !== "cities" && !input.cityId) {
      throw new RpcException(
        `kind=${input.kind} requires ` +
          "`cityId` = providerCityId from list_cities (not the Madar city UUID).",
      );
    }
    const result =
      input.kind === "cities"
        ? await this.shipping.getCities(adminId, provider)
        : input.kind === "zones"
          ? await this.shipping.getZones(adminId, provider, input.cityId as string)
          : await this.shipping.getDistricts(adminId, provider, input.cityId as string);
    const records = Array.isArray((result as any)?.records) ? (result as any).records : [];
    return toolJson({
      kind: input.kind,
      provider: (result as any)?.provider ?? provider,
      cityId: input.kind === "cities" ? null : input.cityId,
      records: records.map(toGeoRecord),
    });
  }
}
