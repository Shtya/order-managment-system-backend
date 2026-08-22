import { BadRequestException, Injectable } from "@nestjs/common";
import { ShippingService } from "../../../shipping/shipping.service";
import { CitiesService } from "../../../cities/cities.service";
import { OrdersService } from "../../../orders/services/orders.service";
import { AiTool } from "../ai-tool.abstract";
import { AiToolContext } from "../ai-tool-context";
import {
  GetShippingProviderDistrictsToolArgsDto,
  GetShippingProviderZonesToolArgsDto,
  ListShippingProviderCitiesToolArgsDto,
  ResolveShippingLocationIdToolArgsDto,
  UpdateOrderShippingLocationToolArgsDto,
} from "../dto/shipping.tool.dto";
import { dtoToJsonSchema } from "../dto-to-json-schema";
import {
  AI_PERMISSION_TOOLS_SHIPPING_READ,
  AI_PERMISSION_TOOLS_SHIPPING_WRITE,
} from "../../ai.constants";
import { AiExecutionResult } from "../../interfaces/ai-types";

@Injectable()
export class ShippingAiTools {
  constructor(
    private readonly shippingService: ShippingService,
    private readonly citiesService: CitiesService,
    private readonly ordersService: OrdersService,
  ) {}

  getTools(): AiTool[] {
    return [
      new AiTool({
        name: "list_shipping_provider_cities",
        description:
          "List the cities supported by a shipping provider (bosta, jt, turbo, aramex, dhl, SMSA) for the current tenant. Use this before resolving or updating an order shipping location.",
        inputSchema: dtoToJsonSchema(ListShippingProviderCitiesToolArgsDto),
        argsDto: ListShippingProviderCitiesToolArgsDto,
        permission: AI_PERMISSION_TOOLS_SHIPPING_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.listProviderCities(ctx, args),
      }),
      new AiTool({
        name: "get_shipping_provider_districts",
        description:
          "List the districts of a provider city. Returns unified district records (id, nameEn, nameAr).",
        inputSchema: dtoToJsonSchema(GetShippingProviderDistrictsToolArgsDto),
        argsDto: GetShippingProviderDistrictsToolArgsDto,
        permission: AI_PERMISSION_TOOLS_SHIPPING_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.listProviderDistricts(ctx, args),
      }),
      new AiTool({
        name: "get_shipping_provider_zones",
        description:
          "List the zones of a provider district. Returns unified zone records (id, nameEn, nameAr).",
        inputSchema: dtoToJsonSchema(GetShippingProviderZonesToolArgsDto),
        argsDto: GetShippingProviderZonesToolArgsDto,
        permission: AI_PERMISSION_TOOLS_SHIPPING_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.listProviderZones(ctx, args),
      }),
      new AiTool({
        name: "resolve_shipping_location_id",
        description:
          "Resolve a provider city name (and optional area name) into the unified location ids needed to update an order shipping location. Returns providerCityId, unifiedCityId, and areaId when matched.",
        inputSchema: dtoToJsonSchema(ResolveShippingLocationIdToolArgsDto),
        argsDto: ResolveShippingLocationIdToolArgsDto,
        permission: AI_PERMISSION_TOOLS_SHIPPING_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.resolveLocation(ctx, args),
      }),
      new AiTool({
        name: "update_order_shipping_location",
        description:
          "Set the shipping location of an order (unified city / district / zone / location ids + order size). The providerCityId must come from resolve_shipping_location_id. Idempotent: re-running with identical inputs produces the same result.",
        inputSchema: dtoToJsonSchema(UpdateOrderShippingLocationToolArgsDto),
        argsDto: UpdateOrderShippingLocationToolArgsDto,
        permission: AI_PERMISSION_TOOLS_SHIPPING_WRITE,
        isWrite: true,
        staleRecovery: "auto_recover",
        run: (ctx, args) => this.updateOrderShippingLocation(ctx, args),
      }),
    ];
  }

  private buildMe(ctx: AiToolContext): any {
    return {
      id: ctx.session.userId,
      adminId: ctx.session.tenantId ?? ctx.session.userId,
      role: { name: ctx.session.userRoleName },
    };
  }

  private getTenantId(ctx: AiToolContext): string {
    const tenantId = ctx.session.tenantId;
    if (!tenantId) throw new BadRequestException("Tenant id is required for shipping tools");
    return tenantId;
  }

  private wrap<T>(
    code: string,
    fn: () => Promise<T>,
  ): Promise<AiExecutionResult> {
    return fn().then(
      (data) => ({ ok: true, code, data }),
      (error) => ({
        ok: false,
        code: `${code}_ERROR`,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  private async listProviderCities(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("SHIPPING_CITIES", async () => {
      const result: any = await this.shippingService.getCities(
        this.getTenantId(ctx),
        String(args.provider),
      );
      return {
        provider: result.provider,
        records: (result.records ?? []).map((c: any) => ({
          id: c.id,
          nameEn: c.nameEn,
          nameAr: c.nameAr,
          dropOff: c.dropOff,
          pickup: c.pickup,
        })),
      };
    });
  }

  private async listProviderDistricts(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("SHIPPING_DISTRICTS", async () => {
      const result: any = await this.shippingService.getDistricts(
        this.getTenantId(ctx),
        String(args.provider),
        String(args.cityId),
      );
      return {
        provider: result.provider,
        records: (result.records ?? []).map((d: any) => ({
          id: d.id,
          nameEn: d.nameEn,
          nameAr: d.nameAr,
        })),
      };
    });
  }

  private async listProviderZones(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("SHIPPING_ZONES", async () => {
      const result: any = await this.shippingService.getZones(
        this.getTenantId(ctx),
        String(args.provider),
        String(args.districtId),
      );
      return {
        provider: result.provider,
        records: (result.records ?? []).map((z: any) => ({
          id: z.id,
          nameEn: z.nameEn,
          nameAr: z.nameAr,
        })),
      };
    });
  }

  private async resolveLocation(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("LOCATION_RESOLVED", async () => {
      const provider = String(args.provider);
      const cityName = String(args.cityName).trim();
      const areaName = args.areaName ? String(args.areaName).trim() : undefined;

      const citiesResult: any = await this.shippingService.getCities(
        this.getTenantId(ctx),
        provider,
      );
      const city = (citiesResult.records ?? []).find((c: any) =>
        matchName(c, cityName),
      );

      if (!city) {
        return {
          ok: false,
          code: "PROVIDER_CITY_NOT_FOUND",
          error: `No city matching '${cityName}' was found for provider '${provider}'`,
        };
      }

      const providerLocation =
        await this.citiesService.findProviderLocationByProviderCityId(
          provider,
          city.id,
        );
      const unifiedCityId = providerLocation?.cityId ?? null;
      const unifiedCityName = providerLocation?.city?.nameEn
        ? `${providerLocation.city.nameEn} / ${providerLocation.city.nameAr}`
        : null;

      let areaId: string | null = null;
      let areaNameMatched: string | null = null;
      if (areaName && unifiedCityId) {
        const areas: any[] = await this.citiesService.findAreas(unifiedCityId);
        const area = areas.find((a) => matchName(a, areaName));
        if (area) {
          areaId = area.id;
          areaNameMatched = `${area.nameEn} / ${area.nameAr}`;
        }
      }

      return {
        provider,
        providerCityId: city.id,
        providerCityNameEn: city.nameEn,
        providerCityNameAr: city.nameAr,
        unifiedCityId,
        unifiedCityName,
        areaId,
        areaNameMatched,
        mappedToUnified: Boolean(unifiedCityId),
        dropOff: city.dropOff,
        pickup: city.pickup,
      };
    });
  }

  private async updateOrderShippingLocation(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDER_SHIPPING_LOCATION_UPDATED", async () => {
      const provider = String(args.provider);
      const providerCityId = String(args.providerCityId);

      const providerLocation =
        await this.citiesService.findProviderLocationByProviderCityId(
          provider,
          providerCityId,
        );
      const unifiedCityId = providerLocation?.cityId ?? null;

      if (!unifiedCityId) {
        return {
          ok: false,
          code: "PROVIDER_CITY_NOT_MAPPED",
          error: `Provider city '${providerCityId}' is not mapped to a unified city yet. Use resolve_shipping_location_id first.`,
        };
      }

      const result = await this.ordersService.updateOrderShippingLocation(
        this.buildMe(ctx),
        String(args.orderId),
        {
          cityId: unifiedCityId,
          districtId: args.unifiedDistrictId
            ? String(args.unifiedDistrictId)
            : undefined,
          zoneId: args.unifiedZoneId ? String(args.unifiedZoneId) : undefined,
          locationId: args.locationId ? String(args.locationId) : undefined,
          orderSize: args.orderSize ? String(args.orderSize) : undefined,
        },
      );

      return result;
    });
  }
}

function matchName(
  record: { nameEn?: string; nameAr?: string },
  search: string,
): boolean {
  const q = search.toLowerCase();
  return (
    record.nameEn?.toLowerCase() === q ||
    record.nameAr?.toLowerCase() === q ||
    record.nameEn?.toLowerCase().includes(q) ||
    record.nameAr?.toLowerCase().includes(q)
  );
}
