import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { CitiesService } from "src/cities/cities.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { AreaEntity, CityEntity } from "entities/cities.entity";
import { listPaging } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";
import { uuidField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const listCitiesInput = z.object({
  ...listPaging({
    items: "cities",
    sortBy: ["nameEn", "nameAr", "minShippingDays", "maxShippingDays"],
    defaultSortBy: "nameEn",
    search: "Matches city name (English or Arabic)",
  }),
  isConfigured: z
    .enum(["true", "false"])
    .optional()
    .describe("Only cities with (true) or without (false) tenant shipping-day config"),
  minDays: z.number().int().min(0).optional().describe("Keep cities whose min shipping days are at least this number"),
  maxDays: z.number().int().min(0).optional().describe("Keep cities whose max shipping days are at most this number"),
});

const listAreasInput = z.object({
  cityId: uuidField(idDescription("City id to list areas for.", TOOL.cities.list)),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toAreaSummary(row: Partial<AreaEntity>) {
  return {
    id: row.id,
    nameEn: (row as any).nameEn ?? null,
    nameAr: (row as any).nameAr ?? null,
    cityId: (row as any).cityId ?? null,
  };
}

function toCitySummary(row: Partial<CityEntity>) {
  const config = (row as any).tenantConfigs?.[0] ?? null;
  return {
    id: row.id,
    nameEn: (row as any).nameEn ?? null,
    nameAr: (row as any).nameAr ?? null,
    isConfigured: Boolean(config),
    minShippingDays: config?.minShippingDays ?? null,
    maxShippingDays: config?.maxShippingDays ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpCitiesTools {
  constructor(private cities: CitiesService) {}

  @McpReadTool({
    name: TOOL.cities.list,
    description:
      "List the delivery cities with the tenant shipping-day config. Read-only.",
    parameters: listCitiesInput,
  })
  async listCities(
    @Payload() query: z.infer<typeof listCitiesInput>,
    @McpUser() user: User,
  ) {
    const result = await this.cities.findAllWithTenantConfig(user, query);
    return toolPage("cities", result, toCitySummary, query.limit);
  }

  @McpReadTool({
    name: TOOL.cities.areas,
    description:
      "List the areas (districts) of one city. Read-only.",
    parameters: listAreasInput,
  })
  async listAreas(
    @Payload() input: z.infer<typeof listAreasInput>,
  ) {
    const rows = await this.cities.findAreas(input.cityId);
    const records = Array.isArray(rows) ? rows : [];
    return toolJson({ areas: records.map(toAreaSummary) });
  }
}
