import { Injectable } from "@nestjs/common";
import { OrdersService } from "../../../orders/services/orders.service";
import { CitiesService } from "../../../cities/cities.service";
import { ShippingService } from "../../../shipping/shipping.service";
import { AiTool, AiToolExecutor } from "../ai-tool.abstract";
import { AiToolContext } from "../ai-tool-context";
import {
  GetCitiesToolArgsDto,
  GetCityToolArgsDto,
  GetAreasByCityToolArgsDto,
  GetShippingZonesToolArgsDto,
  GetShippingDistrictsToolArgsDto,
  GetLocationByCoordinatesToolArgsDto,
  GetOrderHistoryToolArgsDto,
  GetOrderStatsToolArgsDto,
  GetOrderToolArgsDto,
  GetLatestOrderToolArgsDto,
  SearchOrdersToolArgsDto,
  BulkUpdateOrdersShippingToolArgsDto,
} from "../dto/orders.tool.dto";
import { dtoToJsonSchema } from "../dto-to-json-schema";
import {
  AI_PERMISSION_TOOLS_ORDERS_READ,
  AI_PERMISSION_TOOLS_ORDERS_WRITE,
  AI_PERMISSION_TOOLS_SHIPPING_READ,
} from "../../ai.constants";
import { AiExecutionResult } from "../../interfaces/ai-types";
import { OrderEntity } from "entities/order.entity";

const ORDER_UUID_EXAMPLE = "37691350-8adc-4af9-9275-58dce66e5475";
const ORDER_NUMBER_EXAMPLE = "ORD8VVTGTH";
const TRACKING_NUMBER_EXAMPLE = "38098658";

const ORDER_NUMBER_HELP = `An order number is a short code starting with "ORD" + 8 letters/digits (e.g. ${ORDER_NUMBER_EXAMPLE}). It is NOT the UUID id (e.g. ${ORDER_UUID_EXAMPLE}) and NOT a tracking number (e.g. ${TRACKING_NUMBER_EXAMPLE}).`;

@Injectable()
export class OrdersAiTools {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly citiesService: CitiesService,
    private readonly shippingService: ShippingService,
  ) { }

  getTools(): AiTool[] {
    return [
      new AiTool({
        name: "get_cities",
        description:
          "List all unified cities in the current tenant. Returns city id, nameEn, nameAr, isActive, and all providerLocations (provider, providerCityId, providerCityNameEn, providerCityNameAr, dropOff, pickup).",
        inputSchema: dtoToJsonSchema(GetCitiesToolArgsDto),
        argsDto: GetCitiesToolArgsDto,
        permission: AI_PERMISSION_TOOLS_ORDERS_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.getCities(ctx, args),
      }),
      new AiTool({
        name: "get_city",
        description:
          "Get a single unified city by id. Returns full city details including all providerLocations (provider, providerCityId, providerCityNameEn, providerCityNameAr, dropOff, pickup).",
        inputSchema: dtoToJsonSchema(GetCityToolArgsDto),
        argsDto: GetCityToolArgsDto,
        permission: AI_PERMISSION_TOOLS_ORDERS_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.getCity(ctx, args),
      }),
      new AiTool({
        name: "get_areas_by_city",
        description:
          "List the areas for a unified city. Returns area id, nameEn, nameAr, isActive.",
        inputSchema: dtoToJsonSchema(GetAreasByCityToolArgsDto),
        argsDto: GetAreasByCityToolArgsDto,
        permission: AI_PERMISSION_TOOLS_ORDERS_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.getAreasByCity(ctx, args),
      }),
      new AiTool({
        name: "get_shipping_zones",
        description:
          "List the zones for a shipping provider city. Returns zone id, nameEn, nameAr, pickup, dropOff.",
        inputSchema: dtoToJsonSchema(GetShippingZonesToolArgsDto),
        argsDto: GetShippingZonesToolArgsDto,
        permission: AI_PERMISSION_TOOLS_SHIPPING_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.getShippingZones(ctx, args),
      }),
      new AiTool({
        name: "get_shipping_districts",
        description:
          "List the districts for a shipping provider city. Returns district id, nameEn, nameAr, pickup, dropOff, zoneId.",
        inputSchema: dtoToJsonSchema(GetShippingDistrictsToolArgsDto),
        argsDto: GetShippingDistrictsToolArgsDto,
        permission: AI_PERMISSION_TOOLS_SHIPPING_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.getShippingDistricts(ctx, args),
      }),
      new AiTool({
        name: "get_location_by_coordinates",
        description:
          "Get location details (address, city, district, country) from latitude and longitude coordinates using reverse geocoding.",
        inputSchema: dtoToJsonSchema(GetLocationByCoordinatesToolArgsDto),
        argsDto: GetLocationByCoordinatesToolArgsDto,
        permission: AI_PERMISSION_TOOLS_ORDERS_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.getLocationByCoordinates(ctx, args),
      }),
      new AiTool({
        name: 'bulk_update_orders_shipping',
        description:
          `Update shipping fields (city / district / zone / order size) for one or more orders in a single transaction. Each item requires the order UUID id.`,
        inputSchema: dtoToJsonSchema(BulkUpdateOrdersShippingToolArgsDto),
        argsDto: BulkUpdateOrdersShippingToolArgsDto,
        permission: AI_PERMISSION_TOOLS_ORDERS_WRITE,
        isWrite: true,
        staleRecovery: 'auto_recover',
        run: (ctx, args) => this.bulkUpdateOrdersShipping(ctx, args),
      }),
      new AiTool({
        name: "get_latest_order",
        description: `Get the most recent order in the current store (the tenant's own latest order). No arguments are required. Use this when the user asks for "the latest order" or "my most recent order" without naming a specific customer or order number. To find the latest order of a specific customer, use get_latest_order_by_phone instead.`,
        inputSchema: dtoToJsonSchema(GetLatestOrderToolArgsDto),
        argsDto: GetLatestOrderToolArgsDto,
        permission: AI_PERMISSION_TOOLS_ORDERS_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.getLatestOrder(ctx, args),
      }),
      new AiTool({
        name: "search_orders",
        description: `Search orders using free-text search (order number, customer name, phone) or an explicit orderNumber, plus optional filters: status, paymentStatus, city. Returns a paginated, compact list. ${ORDER_NUMBER_HELP} Search by the order number (e.g. ${ORDER_NUMBER_EXAMPLE}) when the user gives an "ORD..." code; otherwise prefer free-text search.`,
        inputSchema: dtoToJsonSchema(SearchOrdersToolArgsDto),
        argsDto: SearchOrdersToolArgsDto,
        permission: AI_PERMISSION_TOOLS_ORDERS_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.searchOrders(ctx, args),
      }),
      new AiTool({
        name: "get_order_history",
        description: `Retrieve the status-change history / action log for an order using the order number. ${ORDER_NUMBER_HELP}`,
        inputSchema: dtoToJsonSchema(GetOrderHistoryToolArgsDto),
        argsDto: GetOrderHistoryToolArgsDto,
        permission: AI_PERMISSION_TOOLS_ORDERS_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.getOrderHistory(ctx, args),
      }),
      new AiTool({
        name: "get_order_stats",
        description:
          "Get aggregate order statistics for the tenant (totals, counts by status, revenue metrics).",
        inputSchema: dtoToJsonSchema(GetOrderStatsToolArgsDto),
        argsDto: GetOrderStatsToolArgsDto,
        permission: AI_PERMISSION_TOOLS_ORDERS_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.getOrderStats(ctx, args),
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
  private async getLatestOrder(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDER_FOUND", async () => {
      const records = await this.ordersService.list(this.buildMe(ctx), {
        limit: 1,
        page: 1,
      });
      const order = (records as any)?.records?.[0];
      if (!order) throw new Error("No orders found for this store");
      return mapOrderCompact(order, { includeItems: false });
    });
  }
  private async searchOrders(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDERS_FOUND", async () => {
      const result = await this.ordersService.list(this.buildMe(ctx), {
        search: args.orderNumber ?? args.search,
        status: args.status,
        paymentStatus: args.paymentStatus,
        city: args.city,
        page: args.page,
        limit: args.limit,
      });
      const records = (result as any)?.records ?? [];
      return {
        total_records: (result as any)?.total_records,
        current_page: (result as any)?.current_page,
        per_page: (result as any)?.per_page,
        records: records
          .slice(0, 20)
          .map((o: any) => mapOrderCompact(o, { includeItems: false })),
      };
    });
  }


  private async getOrderHistory(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDER_HISTORY", async () => {
      const order: any = await this.ordersService.get(
        this.buildMe(ctx),
        String(args.orderNumber),
      );
      const history = await this.ordersService.getOrderHistory(
        order.id,
        this.buildMe(ctx),
      );
      return history;
    });
  }

  private async getOrderShipping(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDER_SHIPPING", async () => {
      const order: any = await this.ordersService.get(
        this.buildMe(ctx),
        String(args.orderNumber),
      );
      return {
        orderNumber: order.orderNumber,
        city: order.city,
        area: order.area,
        address: order.address,
        landmark: order.landmark,
        shippingCompany: order.shippingCompany?.name ?? null,
        shippingCompanyId: order.shippingCompanyId,
        trackingNumber: order.trackingNumber,
        shippedAt: order.shippedAt,
        shippingMetadata: order.shippingMetadata ?? null,
        shippingCost: order.shippingCost ?? null,
      };
    });
  }

  private async getOrderStats(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDER_STATS", async () => {
      const stats = await this.ordersService.getStats(this.buildMe(ctx), {
        startDate: args.startDate,
        endDate: args.endDate,
        statusId: args.statusId,
      });
      return stats;
    });
  }

  private async bulkUpdateOrdersShipping(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDERS_SHIPPING_UPDATED", async () => {
      const me = this.buildMe(ctx);
      const items = Array.isArray(args.items) ? args.items : [];
      const result = await this.ordersService.bulkUpdateShippingFields(me, {
        code: args.code ? String(args.code) : undefined,
        items,
      });
      return result;
    });
  }

  private async getCities(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("CITIES_FOUND", async () => {
      const cities = await this.citiesService.findAllWithProviders();
      return cities.map((c: any) => ({
        id: c.id,
        nameEn: c.nameEn,
        nameAr: c.nameAr,
        isActive: c.isActive,
        providerLocations: (c.providerLocations ?? []).map((pl: any) => ({
          id: pl.id,
          provider: pl.provider,
          providerCityId: pl.providerCityId,
          providerCityNameEn: pl.providerCityNameEn,
          providerCityNameAr: pl.providerCityNameAr,
          dropOff: pl.dropOff,
          pickup: pl.pickup,
        })),
      }));
    });
  }

  private async getCity(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("CITY_FOUND", async () => {
      const cityId = String(args.cityId);
      const city = await this.citiesService.findOneWithProviders(cityId);
      if (!city) throw new Error(`City '${cityId}' not found`);
      return {
        id: city.id,
        nameEn: city.nameEn,
        nameAr: city.nameAr,
        isActive: city.isActive,
        providerLocations: (city.providerLocations ?? []).map((pl: any) => ({
          id: pl.id,
          provider: pl.provider,
          providerCityId: pl.providerCityId,
          providerCityNameEn: pl.providerCityNameEn,
          providerCityNameAr: pl.providerCityNameAr,
          dropOff: pl.dropOff,
          pickup: pl.pickup,
        })),
      };
    });
  }

  private async getAreasByCity(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("AREAS_FOUND", async () => {
      const cityId = String(args.cityId);
      const areas = await this.citiesService.findAreas(cityId);
      return areas.map((a: any) => ({
        id: a.id,
        nameEn: a.nameEn,
        nameAr: a.nameAr,
        isActive: a.isActive,
      }));
    });
  }

  private async getShippingZones(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ZONES_FOUND", async () => {
      const provider = String(args.provider);
      const cityId = String(args.cityId);
      const result: any = await this.shippingService.getZones(
        this.getTenantId(ctx),
        provider,
        cityId,
      );
      return {
        provider: result.provider,
        records: (result.records ?? []).map((z: any) => ({
          id: z.id,
          nameEn: z.nameEn,
          nameAr: z.nameAr,
          pickup: z.pickup,
          dropOff: z.dropOff,
        })),
      };
    });
  }

  private async getShippingDistricts(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("DISTRICTS_FOUND", async () => {
      const provider = String(args.provider);
      const cityId = String(args.cityId);
      const result: any = await this.shippingService.getDistricts(
        this.getTenantId(ctx),
        provider,
        cityId,
      );
      return {
        provider: result.provider,
        records: (result.records ?? []).map((d: any) => ({
          id: d.id,
          nameEn: d.nameEn,
          nameAr: d.nameAr,
          pickup: d.pickup,
          dropOff: d.dropOff,
          zoneId: d.parentId
        })),
      };
    });
  }

  private async getLocationByCoordinates(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("LOCATION_DETAILS", async () => {
      const lat = Number(args.latitude);
      const lon = Number(args.longitude);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error(
          `Invalid latitude or longitude: latitude=${args.latitude}, longitude=${args.longitude}`,
        );
      }

      const lang = "en";

      const url =
        `https://nominatim.openstreetmap.org/reverse` +
        `?format=json` +
        `&lat=${lat}` +
        `&lon=${lon}` +
        `&accept-language=${encodeURIComponent(lang)}` +
        `&addressdetails=1`;

      let res: Response | null = null;
      let lastError: unknown = null;

      for (let attempt = 0; attempt <= 3; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, attempt * 1000),
          );
        }

        try {
          res = await fetch(url, {
            headers: {
              Accept: "application/json",
              "Accept-Language": lang,
              "User-Agent": "Madar/1.0 (https://getmadar.net)",
            },
          });

          if (res.ok) {
            break;
          }

          // Read the body so we know exactly why Nominatim rejected it.
          const errorBody = await res.text();

          lastError = new Error(
            `Nominatim HTTP error: status=${res.status}, ` +
            `statusText="${res.statusText}", ` +
            `body="${errorBody}"`,
          );

          // Don't waste retries on client errors such as 400/403.
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            throw lastError;
          }

          if (attempt === 3) {
            throw lastError;
          }
        } catch (error) {
          lastError = error;

          if (attempt === 3) {
            throw new Error(
              `Reverse geocoding failed after ${attempt + 1} attempts: ${error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }

      if (!res?.ok) {
        throw new Error(
          `Reverse geocoding failed: ${lastError instanceof Error
            ? lastError.message
            : String(lastError)
          }`,
        );
      }

      let data: any;

      try {
        data = await res.json();
      } catch (error) {
        throw new Error(
          `Nominatim returned an invalid JSON response: ${error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const addr = data.address || {};

      return {
        displayName: data.display_name || null,
        latitude: lat,
        longitude: lon,
        country: addr.country || null,
        countryCode: addr.country_code || null,
        state: addr.state || null,
        city:
          addr.city ||
          addr.town ||
          addr.village ||
          addr.municipality ||
          null,
        district: addr.suburb || addr.neighbourhood || null,
        postcode: addr.postcode || null,
        road: addr.road || null,
        houseNumber: addr.house_number || null,
      };
    });
  }

  private getTenantId(ctx: AiToolContext): string {
    const tenantId = ctx.session.tenantId;
    if (!tenantId) throw new Error("Tenant id is required for shipping tools");
    return tenantId;
  }
}

function mapOrderCompact(
  order: OrderEntity,
  opts: { includeItems: boolean },
) {
  return {
    // All direct OrderEntity properties
    ...order,

    // =========================
    // Status
    // =========================
    status: order.status?.name ?? null,

    // =========================
    // Store
    // =========================
    store: order.store
      ? {
        id: order.store.id,
        name: order.store.name ?? null,
        provider: order.store.provider ?? null,
        isActive: order.store.isActive ?? null,
        isIntegrated: order.store.isIntegrated ?? null,
        normalizedStoreUrl: order.store.normalizedStoreUrl ?? null,
        storeUrl: order.store.storeUrl ?? null,
      }
      : null,

    // =========================
    // Shipping company
    // =========================
    shippingCompany: order.shippingCompany
      ? {
        id: order.shippingCompany.id,
        name: order.shippingCompany.name ?? null,
        isActive: order.shippingCompany.isActive ?? null,
        code: order.shippingCompany.code ?? null,
      }
      : null,

    // =========================
    // Assignment
    // =========================
    assignment: order.assignments?.[0]
      ? {
        id: order.assignments[0].id,
        assignedAt: order.assignments[0].assignedAt ?? null,
        employee: order.assignments[0].employee
          ? {
            id: order.assignments[0].employee.id,
            name: order.assignments[0].employee.name ?? null,
          }
          : null,
      }
      : null,

    // =========================
    // Shipment
    // =========================
    shipment: order.shipments?.[0]
      ? {
        id: order.shipments[0].id,
        trackingNumber: order.shipments[0].trackingNumber ?? null,
        status: order.shipments[0].status ?? null,
        createdAt: order.shipments[0].created_at ?? null,
      }
      : null,

    // =========================
    // Tracking
    // =========================
    trackingNumber: order.trackingNumber,
    shippingCompanyName: order.shippingCompany?.name ?? null,

    // =========================
    // Items
    // =========================
    ...(opts.includeItems && {
      items: (order.items ?? []).map((item: any) => ({
        id: item.id,
        sku: item.sku,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        subtotal: item.subtotal,
        productName:
          item.variant?.product?.name ?? item.productName ?? null,

        variant: item.variant
          ? {
            id: item.variant.id,
            name: item.variant.name ?? null,
            sku: item.variant.sku ?? null,
          }
          : null,

        bundle: item.bundle
          ? {
            id: item.bundle.id,
            name: item.bundle.name ?? null,
          }
          : null,
      })),
    }),

    // =========================
    // Replacement
    // =========================
    replacementRequest: order.replacementRequest
      ? {
        id: order.replacementRequest.id,
        replacementOrderId:
          order.replacementRequest.replacementOrder?.id ?? null,
        replacementOrderNumber:
          order.replacementRequest.replacementOrder?.orderNumber ?? null,
      }
      : null,

    replacementResult: order.replacementResult
      ? {
        id: order.replacementResult.id,
        originalOrderId:
          order.replacementResult.originalOrder?.id ?? null,

        items: (order.replacementResult.items ?? []).map((item: any) => ({
          id: item.id,
          originalOrderItemId: item.originalOrderItem?.id ?? null,
          productName:
            item.originalOrderItem?.variant?.product?.name ?? null,
        })),
      }
      : null,

    // =========================
    // Location
    // =========================
    cityDetails: order.cityDetails
      ? {
        id: order.cityDetails.id,
        name: order.cityDetails.nameAr ?? null,
        nameEn: order.cityDetails.nameEn ?? null,
      }
      : null,

    // =========================
    // Dates
    // =========================
    createdAt: order.created_at,
  };
}

export function ordersToolExecutors(): AiToolExecutor[] {
  return [];
}
