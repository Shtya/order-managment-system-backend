import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { ScanLogType, ScanReason, ShipmentManifestType } from "entities/order.entity";
import { OrdersService } from "src/orders/services/orders.service";
import { ShippingService } from "src/shipping/shipping.service";
import { BulkUpdateShippingFieldsDto, CreateManifestDto } from "dto/order.dto";
import { listPaging, parseDto, parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, ref, shippingCompanyIdDescription, TOOL } from "../utils/mcp-tool-names";
import { uuidField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS
//    Queue of orders reuses orders_search; reject reuses orders_act.
//    scan/log/assign/print/manifests only.
// ═══════════════════════════════════════════════════════════════

const warehouseStatsInput = z.strictObject({
  report: z
    .enum(["distribution", "print", "preparation", "outgoing", "returns", "logs"])
    .optional()
    .describe("Which tab KPIs to return. distribution (default): lifecycle + company workload. print, preparation, outgoing, returns: tab summaries. logs: operational stats plus paged log rows."),
  page: z.number().int().min(1).optional().describe("Log page. Only valid with report=logs."),
  limit: z.number().int().min(1).max(50).optional().describe("Log rows per page. Only valid with report=logs."),
  search: z.string().optional().describe("Log search text. Only valid with report=logs."),
});

const warehouseActInput = z.object({
  action: z
    .enum(["assign", "bulk_print", "scan", "log_failed_scan", "create_manifest", "create_return_manifest", "mark_printed"])
    .describe("Required. assign: provider + orderIds (+ optional shippingItems). bulk_print: orderNumbers. scan: id + sku (+itemId). log_failed_scan: id + sku + reasonCode. create_manifest / create_return_manifest: orderIds (+ shippingCompanyId, driverName). mark_printed: manifest id."),
  provider: z
    .string()
    .optional()
    .describe(
      `Shipping provider code from ${ref(TOOL.shippingCompanies.list)} row.provider (not providerId, not integrationId). Required for action=assign.`,
    ),
  orderIds: z.array(uuidField(idDescription("Order ids. Required for assign, create_manifest, create_return_manifest.", TOOL.orders.search))).optional(),
  orderNumbers: z.array(z.string()).optional().describe("Order numbers. Required for bulk_print."),
  id: uuidField(idDescription(
        "Order id for scan/log_failed_scan.",
        TOOL.orders.search,
        `For action=mark_printed, this is the manifest id from ${ref(TOOL.warehouseOps.manifestsSearch)}.`,
      )).optional(),
  sku: z.string().optional().describe("SKU for scan/log_failed_scan."),
  itemId: uuidField(idDescription("Order item id for scan.", TOOL.orders.search, "Use the line id from that order's items.")).optional(),
  reasonCode: z.enum(ScanReason).optional().describe("Reason for log_failed_scan."),
  shippingCompanyId: uuidField(shippingCompanyIdDescription("Shipping company id for create_manifest / create_return_manifest.")).optional(),
  driverName: z.string().optional().describe("Driver name for manifests."),
  shippingItems: z
    .array(
      z.object({
        id: uuidField(idDescription("Order id. Must be one of `orderIds`.", TOOL.orders.search)),
        customerName: z.string().optional().describe("Recipient name."),
        phoneNumber: z.string().optional().describe("Egyptian mobile (01[0125]XXXXXXXX)."),
        address: z.string().optional().describe("Street / first line."),
        landmark: z.string().optional().describe("Landmark."),
        cityId: uuidField(idDescription("City id.", TOOL.cities.list)).optional(),
        area: z.string().optional().describe("Area name."),
        areaId: uuidField(idDescription("Area id.", TOOL.cities.areas)).optional(),
        zoneId: z.string().optional().describe("Carrier zone id from the shipping company, not from list_shipping_companies. Omit if unknown."),
        districtId: z.string().optional().describe("Carrier district id from the shipping company, not from list_shipping_companies. Omit if unknown."),
        orderSize: z.string().optional().describe("Carrier parcel size."),
      }),
    )
    .optional()
    .describe("Only for action=assign. Per-order shipping fields to PATCH before assign. Omit if addresses are already valid."),
});

const searchManifestsInput = searchInput("manifest", {
  ...listPaging({
    items: "manifests",
    sortBy: ["createdAt"],
    search: "Matches manifest number or order number",
  }),
  shippingCompanyId: uuidField(shippingCompanyIdDescription()).optional(),
  type: z.enum(ShipmentManifestType).optional().describe("Manifest type: SHIPPING (outbound) or RETURN. Omit for all."),
}, TOOL.warehouseOps.manifestsSearch);

const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: files, not rows. No PDF atoms, no Excel.
// ═══════════════════════════════════════════════════════════════

function toManifestSummary(row: any) {
  const orders = Array.isArray(row?.orders) ? row.orders : [];
  return {
    id: row.id,
    type: row.type ?? null,
    manifestNumber: row.manifestNumber ?? row.number ?? null,
    shippingCompany: row.shippingCompany?.name ?? null,
    ordersCount: orders.length,
    isPrinted: Boolean(row.lastPrintedAt ?? row.isPrinted ?? row.printed),
    lastPrintedAt: row.lastPrintedAt ?? null,
    createdAt: row.createdAt ?? row.created_at ?? null,
  };
}

function toManifestDto(row: any) {
  const orders = Array.isArray(row?.orders) ? row.orders : [];
  return {
    id: row.id,
    type: row.type ?? null,
    manifestNumber: row.manifestNumber ?? row.number ?? null,
    shippingCompany: row.shippingCompany?.name ?? null,
    isPrinted: Boolean(row.lastPrintedAt ?? row.isPrinted ?? row.printed),
    lastPrintedAt: row.lastPrintedAt ?? null,
    orders: orders.map((o: any) => ({ id: o.id ?? null, orderNumber: o.orderNumber ?? null })),
    createdAt: row.createdAt ?? row.created_at ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpWarehouseOpsTools {
  constructor(
    private orders: OrdersService,
    private shipping: ShippingService,
  ) {}

  @McpReadTool({
    name: TOOL.warehouseOps.stats,
    description:
      "Warehouse tab KPIs. Pass `report`: distribution (default), print, preparation, outgoing, returns, logs (adds paged rows). Order queues stay on orders_search; rejects on orders_act. Read-only.",
    parameters: warehouseStatsInput,
  })
  async getStats(
    @Payload() input: z.infer<typeof warehouseStatsInput>,
    @McpUser() user: User,
  ) {
    const report = (input as any)?.report ?? "distribution";
    if (report !== "logs" && (isSet((input as any).page) || isSet((input as any).limit) || isSet((input as any).search))) {
      throw new RpcException("`page`/`limit`/`search` are only valid with report=logs. Remove them.");
    }
    if (report === "print") return toolJson({ report, ...(await this.orders.getPrintLifecycleStats(user)) });
    if (report === "preparation") return toolJson({ report, ...(await this.orders.getPreparationStats(user)) });
    if (report === "outgoing") return toolJson({ report, ...(await this.orders.getShippingSummary(user)) });
    if (report === "returns") {
      const [summary, preparing] = await Promise.all([
        this.orders.getReturnsSummaryStats(user),
        this.orders.getReturnPreparingStatsByCompany(user, {}).catch(() => null),
      ]);
      return toolJson({ report, summary: summary ?? null, returnPreparing: preparing ?? null });
    }
    if (report === "logs") {
      const [stats, rows] = await Promise.all([
        this.orders.getLogOperationalStats(user).catch(() => null),
        this.orders.listLogs(user, {
          page: (input as any).page ?? 1,
          limit: (input as any).limit ?? 10,
          search: (input as any).search,
        }).catch(() => null),
      ]);
      const records = Array.isArray((rows as any)?.records) ? (rows as any).records : Array.isArray(rows) ? rows : [];
      return toolJson({
        report,
        stats: stats ?? null,
        total_records: (rows as any)?.total_records ?? records.length,
        logs: records.map((l: any) => ({
          id: l.id ?? null,
          action: l.action ?? l.actionType ?? l.type ?? null,
          orderNumber: l.orderNumber ?? l.order?.orderNumber ?? null,
          createdAt: l.createdAt ?? l.created_at ?? null,
        })),
      });
    }
    const [lifecycle, workload] = await Promise.all([
      this.shipping.getShipmentLifecycleStats(user),
      this.shipping.getCompanyDistribution(user),
    ]);
    return toolJson({ report, lifecycle: lifecycle ?? null, workload: workload ?? null });
  }

  @McpSaveTool({
    name: TOOL.warehouseOps.act,
    description:
      "Warehouse actions. Required: action. assign needs provider + orderIds; optional shippingItems[] PATCHes addresses before assign. bulk_print needs orderNumbers. scan needs id + sku. log_failed_scan needs id + sku + reasonCode. create_manifest / create_return_manifest need orderIds. mark_printed needs a manifest id. No reject or return_request here.",
    parameters: warehouseActInput,
  })
  async act(
    @Payload() input: z.infer<typeof warehouseActInput>,
    @McpUser() user: User,
  ) {
    if (input.action !== "assign" && Array.isArray(input.shippingItems) && input.shippingItems.length > 0) {
      throw new RpcException("`shippingItems` is only valid with action=assign. Remove it, or set action to assign.");
    }
    switch (input.action) {
      case "assign": {
        if (!isSet(input.provider)) throw new RpcException("action=assign requires `provider`.");
        const ids = Array.isArray(input.orderIds) ? input.orderIds.filter(Boolean) : [];
        if (ids.length === 0) throw new RpcException("action=assign requires `orderIds[]`.");
        const assigned = new Set(ids);
        const shippingRows = Array.isArray(input.shippingItems) ? input.shippingItems : [];
        let shipping: unknown = null;
        if (shippingRows.length > 0) {
          const unknownId = shippingRows.find((row) => !assigned.has(row.id));
          if (unknownId) {
            throw new RpcException(
              `shippingItems id ${unknownId.id} is not in orderIds. Every shipping item must be one of the assigned orders.`,
            );
          }
          const parsed = await parseDto(BulkUpdateShippingFieldsDto, {
            code: input.provider,
            items: shippingRows.map((row) => {
              const metadata: Record<string, string> = {};
              if (isSet(row.zoneId)) metadata.zoneId = row.zoneId as string;
              if (isSet(row.districtId)) metadata.districtId = row.districtId as string;
              if (isSet(row.orderSize)) metadata.orderSize = row.orderSize as string;
              return {
                id: row.id,
                ...(isSet(row.customerName) ? { customerName: row.customerName } : {}),
                ...(isSet(row.phoneNumber) ? { phoneNumber: row.phoneNumber } : {}),
                ...(isSet(row.address) ? { address: row.address } : {}),
                ...(isSet(row.landmark) ? { landmark: row.landmark } : {}),
                ...(isSet(row.cityId) ? { cityId: row.cityId } : {}),
                ...(isSet(row.area) ? { area: row.area } : {}),
                ...(isSet(row.areaId) ? { areaId: row.areaId } : {}),
                ...(Object.keys(metadata).length > 0 ? { shippingMetadata: metadata } : {}),
              };
            }),
          });
          if (parsed.ok === false) throw new RpcException(parsed.message);
          shipping = await this.orders.bulkUpdateShippingFields(user, parsed.dto);
        }
        const assign =
          ids.length === 1
            ? await this.shipping.assignOrder(user, ids[0], {} as any, (input.provider as any) ?? "none")
            : await this.shipping.bulkAssignOrders(user, input.provider as any, {
                items: ids.map((orderId) => ({ orderId })),
              } as any);
        return toolJson(shipping ? { shipping, assign } : assign);
      }
      case "bulk_print": {
        const numbers = Array.isArray(input.orderNumbers) ? input.orderNumbers.filter(Boolean) : [];
        if (numbers.length === 0) throw new RpcException("action=bulk_print requires `orderNumbers[]`.");
        return toolJson(await this.orders.bulkPrint(user, numbers));
      }
      case "scan": {
        if (!isSet(input.id) || !isSet(input.sku)) throw new RpcException("action=scan requires `id` and `sku`.");
        return toolJson(await this.orders.scanItem(input.id as string, input.sku as string, user, input.itemId as any));
      }
      case "log_failed_scan": {
        if (!isSet(input.id) || !isSet(input.sku) || !isSet(input.reasonCode)) {
          throw new RpcException("action=log_failed_scan requires `id`, `sku`, and `reasonCode`.");
        }
        return toolJson(await this.orders.logError(input.id as string, input.sku as string, user, input.reasonCode as any, ScanLogType.PREPARATION, ""));
      }
      case "create_manifest":
      case "create_return_manifest": {
        const ids = Array.isArray(input.orderIds) ? input.orderIds.filter(Boolean) : [];
        if (ids.length === 0) throw new RpcException(`action=${input.action} requires \`orderIds[]\`.`);
        const parsed = await parseDto(CreateManifestDto, {
          orderIds: ids,
          ...(isSet(input.shippingCompanyId) ? { shippingCompanyId: input.shippingCompanyId } : {}),
          ...(isSet(input.driverName) ? { driverName: input.driverName } : {}),
        });
        if (parsed.ok === false) throw new RpcException(parsed.message);
        if (input.action === "create_return_manifest") {
          return toolJson(await this.orders.createReturnManifest(parsed.dto, user));
        }
        return toolJson(await this.orders.createManifest(parsed.dto, user));
      }
      case "mark_printed": {
        if (!isSet(input.id)) throw new RpcException("action=mark_printed requires a manifest `id`.");
        return toolJson(await this.orders.markAsPrinted(input.id as string, user));
      }
    }
  }

  @McpReadTool({
    name: TOOL.warehouseOps.manifestsSearch,
    description:
      "Search outbound/return manifest files or fetch one. Without `id`: paged summaries. With `id`: returns that file with its orders. Read-only.",
    parameters: searchManifestsInput,
  })
  async searchManifests(
    @Payload() input: z.infer<typeof searchManifestsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "manifest");
    if (req.mode === "get") {
      return toolJson(toManifestDto(await this.orders.getManifestDetail(req.id, user)));
    }
    const result = await this.orders.listManifests(user, req.query);
    return toolPage("manifests", result, toManifestSummary, req.query.limit);
  }
}
