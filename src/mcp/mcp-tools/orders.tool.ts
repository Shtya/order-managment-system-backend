import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { OrdersService } from "src/orders/services/orders.service";
import { OrderInternalNotesService } from "src/orders/services/order-internal-notes.service";
import { OrderReplacementService } from "src/orders/services/order-replacements.service";
import { OrderReturnService } from "src/orders/services/order-return.service";
import { TagsAssignmentService } from "src/tags/tags-assignment.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { assertDateOrder, listPaging, parseDto, parseSaveInput, parseSearchInput, resolveToolDates, searchInput, toolInputFor } from "../utils/mcp-dto.util";
import { CreateOrderDto, CreateOrderInternalNoteDto, CreateReplacementDto, CreateReturnDto, ChangeOrderStatusDto, UpdateOrderDto } from "dto/order.dto";
import {
  DamageResponsibility,
  OrderConfirmationSource,
  OrderEntity,
  OrderItemEntity,
  OrderReplacementEntity,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from "entities/order.entity";
import { ShipmentStatus } from "entities/shipping.entity";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, ref, shippingCompanyIdDescription, TOOL } from "../utils/mcp-tool-names";
import { uuidField, isoDateField, TREND_RANGES, businessDayRange } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const saveOrderFields = toolInputFor<UpdateOrderDto>()(
  z.object({
    // ── Customer ───────────────────────────────────────────────
    customerName: z.string().optional().describe("Customer full name"),
    phoneNumber: z.string().optional().describe("Customer phone number"),
    secondPhoneNumber: z.string().optional().describe("Customer second phone number"),
    email: z.string().optional().describe("Customer email"),
    clientId: uuidField(idDescription(
          "Id of an existing client record. Omit if the customer is not registered.",
          TOOL.clients.search,
        )).optional(),

    // ── Address ────────────────────────────────────────────────
    address: z.string().optional().describe("Delivery address"),
    landmark: z.string().optional().describe("Nearby landmark"),
    cityId: uuidField(idDescription("City id.", TOOL.cities.list)).optional(),
    area: z
      .string()
      .optional()
      .describe(
        "Area/district name as stored on the order (e.g. حى المناخ). Prefer areaId from list_areas when you have cityId.",
      ),
    areaId: uuidField(idDescription("Area id.", TOOL.cities.areas, "Resolved to the area name on save.")).optional(),
    latitude: z
      .number()
      .optional()
      .describe("Delivery latitude (top-level number, not nested under address)"),
    longitude: z
      .number()
      .optional()
      .describe("Delivery longitude (top-level number, not nested under address)"),

    // ── Payment ────────────────────────────────────────────────
    paymentMethod: z.enum(PaymentMethod).optional().describe("How the customer pays"),
    paymentStatus: z
      .enum(PaymentStatus)
      .optional()
      .describe(
        `Payment status. One of: ${Object.values(PaymentStatus).join(", ")}. Use "partial" not a display label.`,
      ),
    deposit: z.number().optional().describe("Deposit already paid"),
    discount: z.number().optional().describe("Discount amount (whole number)"),
    additionalFees: z.number().optional().describe("Additional fees"),

    // ── Shipping ───────────────────────────────────────────────
    shippingCompanyId: uuidField(shippingCompanyIdDescription()).optional(),
    storeId: uuidField(idDescription("Store id.", TOOL.stores.list)).optional(),
    shippingCost: z.number().optional().describe("Shipping cost (whole number)"),
    allowOpenPackage: z
      .boolean()
      .optional()
      .describe("Whether the customer may open the package before paying"),
    trackingNumber: z
      .string()
      .optional()
      .describe("Shipping tracking number. Update only."),

    // ── Notes ──────────────────────────────────────────────────
    notes: z.string().optional().describe("Internal notes"),
    customerNotes: z.string().optional().describe("Notes from the customer"),

    // ── Items ──────────────────────────────────────────────────
    // Not offered on purpose:
    //   unitCost     -> internal cost/margin data, never give it to an agent
    //   isAdditional -> meaning unclear; add it if you need it
    //   statusId     -> status changes are not done through save
    items: z
      .array(
        z.object({
          variantId: uuidField(idDescription("Variant id of the product.", TOOL.products.search)),
          bundleId: uuidField(idDescription(
                "Bundle id, only when the line is a bundle.",
                TOOL.bundles.search,
              )).optional(),
          quantity: z.number().describe("Quantity: a whole number, at least 1"),
          unitPrice: z
            .number()
            .describe(
              `Unit price, up to 2 decimals. Use the price returned by ${ref(TOOL.products.search)} unless the user explicitly gives a different one.`,
            ),
          addQuantity: z
            .boolean()
            .optional()
            .describe("Update only. When true, add the quantity to the existing line instead of replacing it"),
        }),
      )
      .optional()
      .describe("Order lines. Required for create. On update, replaces the lines unless addQuantity is set."),
    removedItems: z
      .array(
        z.object({
          variantId: uuidField(idDescription("Variant id of the line to remove.", TOOL.products.search)),
          bundleId: uuidField(idDescription("Bundle id, only when the removed line is a bundle.", TOOL.bundles.search)).optional(),
        }),
      )
      .optional()
      .describe("Update only. Lines to remove from the order"),
  }),
);

const saveOrderInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe(
      'Required. "create" to add a new order. "update" to change an existing one. Never infer from id.',
    ),
  id: uuidField(idDescription("Order ID.", TOOL.orders.search, "Required for mode=update. Forbidden for mode=create.")).optional(),
  ...saveOrderFields.shape,
});

const orderStatusCodes = Object.values(OrderStatus).join(", ");
const orderStatusSet = new Set<string>(Object.values(OrderStatus));
const csvOrderStatus = (description: string) =>
  z
    .string()
    .refine(
      (v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .every((code) => orderStatusSet.has(code)),
      { message: `Unknown order status. Use one of: ${orderStatusCodes}.` },
    )
    .optional()
    .describe(description);

const searchOrdersInput = searchInput("order", {
  ...listPaging({
    items: "orders",
    sortBy: ["createdAt", "orderNumber", "finalTotal", "city", "shippedAt", "deliveredAt"],
    defaultSortBy: "createdAt",
    search: "Matches order number, customer name, or phone number",
  }),
  status: csvOrderStatus(`Order status code. One of: ${orderStatusCodes}. Comma-separate several codes.`),
  statusId: uuidField(idDescription(
        "Order status id.",
        TOOL.orderStatuses.list,
        "Omit when `status` is set.",
      )).optional(),
  excludeStatus: csvOrderStatus(`Status codes to leave out. Same values as status: ${orderStatusCodes}. Comma-separate several codes.`),
  paymentStatus: z
    .union([z.enum(PaymentStatus), z.literal(PaymentMethod.CASH_ON_DELIVERY)])
    .optional()
    .describe('Payment status. Pass "cod" to keep only cash-on-delivery orders.'),

  clientId: uuidField(idDescription(
        "Client id.",
        TOOL.clients.search,
        'Pass "all" to skip this filter.',
      ), ["all"]).optional(),
  productId: uuidField(idDescription(
        "Product id.",
        TOOL.products.search,
        'Pass "all" to skip this filter.',
      ), ["all"]).optional(),
  tagId: uuidField(idDescription("Single tag id.", TOOL.tags.list)).optional(),
  tagIds: z.array(uuidField(idDescription("Orders that have any of these tag ids.", TOOL.tags.list))).optional(),
  userId: uuidField(idDescription("Employee id of the latest assignee.", TOOL.employees.list)).optional(),
  storeId: uuidField(idDescription(
        "Store id.",
        TOOL.stores.list,
        'Pass "none" for orders with no store, "all" to skip.',
      ), ["all", "none"]).optional(),
  shippingCompanyId: uuidField(shippingCompanyIdDescription(
        "Shipping company id.",
        'Pass "none" for orders with no company, "all" to skip.',
      ), ["all", "none"]).optional(),
  lastCancelCauseId: uuidField(idDescription(
        "Cancel-cause id.",
        TOOL.cancelCauses.list,
        'Pass "none" for orders with no cause, "all" to skip.',
      ), ["all", "none"]).optional(),

  shippingStatus: z
    .enum(ShipmentStatus)
    .optional()
    .describe("Latest shipment status"),
  shipmentStatus: z
    .enum(ShipmentStatus)
    .optional()
    .describe("Latest shipment status. Same field as shippingStatus."),
  isDistributionStatus: z
    .boolean()
    .optional()
    .describe("When true and shipmentStatus is omitted, keep shipments that are pending action, preparing, or ready to ship"),
  onlyReturned: z
    .boolean()
    .optional()
    .describe("Only orders being prepared for return, with a pending return request"),
  hasReplacement: z
    .boolean()
    .optional()
    .describe("True: orders that have a replacement request. False: orders that do not."),
  hasActiveAssignment: z
    .boolean()
    .optional()
    .describe("True: latest assignment is active. False: no active assignment."),
  labelPrinted: z
    .boolean()
    .optional()
    .describe("True: shipping label already printed. False: not printed."),
  lateShipping: z
    .boolean()
    .optional()
    .describe("True: shipped longer than the city's max shipping days"),
  minShippingDays: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Keep shipped orders whose days since shipment are at least this number"),
  unreadInternalNotes: z
    .boolean()
    .optional()
    .describe("True: orders with internal notes the signed-in user has not read"),

  startDate: isoDateField("Created-at range start, ISO date (YYYY-MM-DD)").optional(),
  endDate: isoDateField("Created-at range end, ISO date (YYYY-MM-DD)").optional(),
  groupDate: isoDateField("Exact created-at calendar day, YYYY-MM-DD. When set, startDate and endDate are ignored.").optional(),
  postponedStartDate: isoDateField("Postponed-date range start, ISO date (YYYY-MM-DD)").optional(),
  postponedEndDate: isoDateField("Postponed-date range end, ISO date (YYYY-MM-DD)").optional(),
  shippedStartDate: isoDateField("Shipped-at range start, ISO date (YYYY-MM-DD)").optional(),
  shippedEndDate: isoDateField("Shipped-at range end, ISO date (YYYY-MM-DD)").optional(),
}, TOOL.orders.search);

const ordersActInput = z.object({
  id: uuidField(idDescription("Order ID.", TOOL.orders.search)),
  action: z.enum(["set_status", "reject"]).describe('Required. "set_status" to move the order. "reject" to reject it. Status is never changed through save.'),
  statusId: uuidField(idDescription("Order status id.", TOOL.orderStatuses.list, "Required for action=set_status.")).optional(),
  notes: z.string().optional().describe("Status or reject notes"),
  postponedDate: isoDateField("Postponed date, ISO date (YYYY-MM-DD). Only with set_status.").optional(),
  reminderDaysBefore: z.number().int().min(0).optional().describe("Reminder days before. Only with set_status."),
  cancelCauseId: uuidField(idDescription("Cancel-cause id.", TOOL.cancelCauses.list)).optional(),
  customCauseName: z.string().optional().describe("Custom cause name (min 3). Alternative to cancelCauseId."),
});

const ordersStatsInput = z.strictObject({
  report: z
    .enum(["summary", "shipped"])
    .optional()
    .describe("Which report to return. summary (default): counts per status, optional dates. shipped: counts/totals by shipping company, optional lateShipping. Not a dashboard_orders_stats report."),
  startDate: isoDateField("Range start, ISO date (YYYY-MM-DD). Only valid with report=summary.").optional(),
  endDate: isoDateField("Range end, ISO date (YYYY-MM-DD). Only valid with report=summary.").optional(),
  range: z.enum(TREND_RANGES).optional().describe(`Quick range. Only valid with report=summary. One of: ${TREND_RANGES.join(", ")}.`),
  lateShipping: z.boolean().optional().describe("Only valid with report=shipped."),
});

const searchNotesInput = z.strictObject({
  orderId: uuidField(idDescription("Order ID.", TOOL.orders.search)),
  limit: z.number().int().min(1).max(50).default(50).describe("Notes per page"),
  cursor: z
    .string()
    .refine(
      (v) => {
        try {
          const parsed = JSON.parse(v);
          return Boolean(parsed?.value && parsed?.id);
        } catch {
          return false;
        }
      },
      { message: "Must be a nextCursor from a previous order_internal_notes_search response. Omit for the first page." },
    )
    .optional()
    .describe("Pagination cursor from a previous response. Omit for the first page."),
  sortDir: z.enum(["ASC", "DESC"]).default("DESC").describe("Sort direction"),
  startDate: isoDateField("Range start, ISO date (YYYY-MM-DD)").optional(),
  endDate: isoDateField("Range end, ISO date (YYYY-MM-DD)").optional(),
});

const saveNotesInput = z.object({
  orderId: uuidField(idDescription("Order ID.", TOOL.orders.search)),
  body: z.string().max(2000).optional().describe("Note text (max 2000). Set to add a note."),
  markRead: z.boolean().optional().describe("True to mark notes as read. No body with it."),
});

const searchReplacementsInput = z.strictObject({
  page: z.number().int().min(1).default(1).describe("Page number, starting at 1"),
  limit: z.number().int().min(1).max(50).default(10).describe("The number of replacements to return"),
  search: z.string().optional().describe("Matches order number, customer name, or phone"),
  startDate: isoDateField("Range start, ISO date (YYYY-MM-DD)").optional(),
  endDate: isoDateField("Range end, ISO date (YYYY-MM-DD)").optional(),
  status: z.enum(OrderStatus).optional().describe("Status code of the new replacement order"),
  sortBy: z.enum(["createdAt", "originalOrderNumber", "replacementOrderNumber"]).default("createdAt").describe("Field to sort by"),
  sortOrder: z.enum(["ASC", "DESC"]).default("DESC").describe("Sort direction"),
});

const saveReplacementInput = z.object({
  originalOrderId: uuidField(idDescription("Original order ID.", TOOL.orders.search)),
  reason: z.string().describe("Why the order is replaced"),
  paymentMethod: z.enum(PaymentMethod).describe("How the replacement is paid"),
  items: z
    .array(
      z.object({
        originalOrderItemId: uuidField(idDescription("Order line id from that order's items.", TOOL.orders.search, "Use the item id from the original order dto.")),
        quantityToReplace: z.number().int().min(1).describe("Quantity to replace"),
        newVariantId: uuidField(idDescription("New variant id.", TOOL.products.search)),
        newUnitPrice: z.number().min(0).describe("New unit price, up to 2 decimals"),
        returnQuantity: z.number().int().min(0).optional().describe("Quantity to take back"),
      }),
    )
    .describe("Replacement lines"),
  anotherReason: z.string().optional().describe("Extra reason detail"),
  internalNotes: z.string().optional().describe("Internal notes"),
  customerNotes: z.string().optional().describe("Notes for the customer"),
  shippingCompanyId: uuidField(shippingCompanyIdDescription()).optional(),
  discount: z.number().int().min(0).optional().describe("Discount amount"),
  additionalFees: z.number().optional().describe("Additional fees"),
  deposit: z.number().optional().describe("Deposit already paid"),
  shippingCost: z.number().int().min(0).optional().describe("Shipping cost"),
  cancelCauseId: uuidField(idDescription("Cancel-cause id.", TOOL.cancelCauses.list)).optional(),
  customCauseName: z.string().optional().describe("Custom cause name (min 3). Alternative to cancelCauseId."),
  // returnImages never offered: no files
});

const saveReturnInput = z.object({
  orderId: uuidField(idDescription("Order ID. Must be shipped, delivered, or failed delivery.", TOOL.orders.search)),
  reason: z.string().optional().describe("Why the goods are returned"),
  items: z
    .array(
      z.object({
        originalItemId: uuidField(idDescription("Order line id from that order's items.", TOOL.orders.search, "Use the item id from that order's dto.")),
        quantity: z.number().min(1).describe("Quantity to return"),
        restockQuantity: z.number().min(0).optional().describe("Quantity to restock"),
        condition: z.string().optional().describe("Item condition"),
        damageResponsibility: z.enum(DamageResponsibility).optional().describe("Who pays for damage, when part of the return is damaged"),
      }),
    )
    .describe("Return lines"),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

type ListedOrder = Partial<OrderEntity> & {
  automationRunCount?: number;
  upsellHistoryCount?: number;
  cancelCauseCount?: number;
  myUnreadCount?: number;
};


function toOrderItem(item: OrderItemEntity) {
  const variant = item.variant;
  const product = variant?.product;
  return {
    id: item.id,
    variantId: item.variantId,
    productId: product?.id ?? variant?.productId ?? null,
    productName: product?.name ?? null,
    sku: variant?.sku ?? null,
    variantKey: variant?.key ?? null,
    bundleId: item.bundleId ?? null,
    bundleName: item.bundle?.name ?? null,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    lineTotal: item.lineTotal,
  };
}

function toReplacement(rep?: OrderReplacementEntity | null) {
  if (!rep) return null;
  return {
    id: rep.id,
    reason: rep.reason ?? null,
    anotherReason: rep.anotherReason ?? null,
    originalOrderId: rep.originalOrderId ?? rep.originalOrder?.id ?? null,
    originalOrderNumber: rep.originalOrder?.orderNumber ?? null,
    replacementOrderId: rep.replacementOrderId ?? rep.replacementOrder?.id ?? null,
    replacementOrderNumber: rep.replacementOrder?.orderNumber ?? null,
    shippingCompanyId: rep.shippingCompanyId ?? null,
    createdAt: rep.createdAt ?? null,
    items: (rep.items ?? []).map((item) => ({
      id: item.id,
      originalOrderItemId: item.originalOrderItemId ?? null,
      quantityToReplace: item.quantityToReplace,
      returnQuantity: item.returnQuantity,
      newVariantId: item.newVariantId ?? null,
      originalSku: item.originalOrderItem?.variant?.sku ?? null,
      newSku: item.newVariant?.sku ?? null,
      ...replacementItemProducts(item),
    })),
  };
}

function toOrderResultDto(row: ListedOrder) {
  const assignment = row.assignments?.[0];
  const shipment = row.shipments?.[0];
  const note = row.lastInternalNote;

  return {
    id: row.id,
    orderNumber: row.orderNumber,
    externalId: row.externalId ?? null,
    isReplacement: row.isReplacement ?? false,
    isConfirmed: row.isConfirmed ?? false,
    confirmationSource: row.confirmationSource ?? null,
    status: row.status
      ? { id: row.status.id, code: row.status.code, name: row.status.name }
      : row.statusId
        ? { id: row.statusId, code: null, name: null }
        : null,
    customer: {
      name: row.customerName ?? row.client?.name ?? null,
      phoneNumber: row.phoneNumber ?? null,
      secondPhoneNumber: row.secondPhoneNumber ?? null,
      email: row.email ?? null,
      clientId: row.clientId ?? row.client?.id ?? null,
    },
    address: {
      address: row.address ?? null,
      landmark: row.landmark ?? null,
      city: row.city ?? null,
      cityId: row.cityId ?? null,
      area: row.area ?? null,
      latitude: row.latitude ?? null,
      longitude: row.longitude ?? null,
    },
    payment: {
      method: row.paymentMethod ?? null,
      status: row.paymentStatus ?? null,
      deposit: row.deposit ?? null,
      productsTotal: row.productsTotal ?? null,
      shippingCost: row.shippingCost ?? null,
      discount: row.discount ?? null,
      additionalFees: row.additionalFees ?? null,
      finalTotal: row.finalTotal ?? null,
      collectedAmount: row.collectedAmount ?? null,
    },
    shipping: {
      shippingCompanyId: row.shippingCompanyId ?? null,
      shippingCompanyName: row.shippingCompany?.name ?? null,
      storeId: row.storeId ?? null,
      storeName: row.store?.name ?? null,
      trackingNumber: row.trackingNumber ?? shipment?.trackingNumber ?? null,
      allowOpenPackage: row.allowOpenPackage ?? false,
      shipment: shipment
        ? {
            id: shipment.id,
            status: shipment.status ?? null,
            unifiedStatus: shipment.unifiedStatus ?? null,
            trackingNumber: shipment.trackingNumber ?? null,
            failureReason: shipment.failureReason ?? null,
          }
        : null,
      metadata: row.shippingMetadata ?? null,
    },
    assignment: assignment
      ? {
          id: assignment.id,
          employeeId: assignment.employeeId ?? assignment.employee?.id ?? null,
          employeeName: assignment.employee?.name ?? null,
          assignedAt: assignment.assignedAt ?? null,
        }
      : null,
    tags: (row.orderTags ?? []).map((orderTag) => ({
      id: orderTag.tagId ?? orderTag.tag?.id ?? null,
      name: orderTag.tag?.name ?? null,
      color: orderTag.tag?.color ?? null,
    })),
    items: (row.items ?? []).map(toOrderItem),
    replacementRequest: toReplacement(row.replacementRequest),
    replacementResult: row.replacementResult
      ? { ...toReplacement(row.replacementResult), replacementOrderNumber: row.replacementResult.replacementOrder?.orderNumber ?? row.orderNumber ?? null }
      : null,
    returnRequests: ((row as any).returnRequests ?? []).map((r: any) => ({
      id: r.id ?? null,
      status: r.status ?? null,
      reason: r.reason ?? null,
      createdAt: r.createdAt ?? r.created_at ?? null,
    })),
    notes: row.notes ?? null,
    customerNotes: row.customerNotes ?? null,
    lastInternalNote: note
      ? {
          id: note.id,
          body: note.body,
          authorName: note.authorName ?? note.author?.name ?? null,
          createdAt: note.created_at ?? null,
        }
      : null,
    rejectReason: row.rejectReason ?? null,
    lastCancelCause: row.lastCancelCauseText ?? null,
    postponedDate: row.postponedDate ?? null,
    counts: {
      automationRuns: row.automationRunCount ?? 0,
      upsellHistory: row.upsellHistoryCount ?? 0,
      cancelCauses: row.cancelCauseCount ?? 0,
      unreadInternalNotes: row.myUnreadCount ?? 0,
    },
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    shippedAt: row.shippedAt ?? null,
    deliveredAt: row.deliveredAt ?? null,
  };
}

function toOrderSummary(row: ListedOrder) {
  const shipment = row.shipments?.[0];

  return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status?.name ?? row.status?.code ?? null,
    customerName: row.customerName ?? row.client?.name ?? null,
    phoneNumber: row.phoneNumber ?? null,
    city: row.city ?? null,
    paymentMethod: row.paymentMethod ?? null,
    paymentStatus: row.paymentStatus ?? null,
    finalTotal: row.finalTotal ?? null,
    shippingCompany: row.shippingCompany?.name ?? null,
    trackingNumber: row.trackingNumber ?? shipment?.trackingNumber ?? null,
    itemsCount: row.items?.length ?? 0,
    createdAt: row.created_at ?? null,
  };
}

function toInternalNoteDto(row: any) {
  return {
    id: row.id,
    body: row.body ?? null,
    authorName: row.authorName ?? row.author?.name ?? null,
    authorRole: row.authorRoleName ?? null,
    isUnreadForMe: row.isUnreadForMe ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
  };
}

function replacementItemProducts(item: any) {
  const originalProduct = item?.originalOrderItem?.variant?.product;
  const newProduct = item?.newVariant?.product;
  return {
    originalProductId: originalProduct?.id ?? item?.originalOrderItem?.variant?.productId ?? null,
    originalProductName: originalProduct?.name ?? null,
    originalImage: originalProduct?.mainImage ?? null,
    newProductId: newProduct?.id ?? item?.newVariant?.productId ?? null,
    newProductName: newProduct?.name ?? null,
    newImage: newProduct?.mainImage ?? null,
  };
}

function toReplacementSummary(row: any) {
  const items = Array.isArray(row?.items) ? row.items : [];
  return {
    id: row.id,
    originalOrderId: row.originalOrderId ?? row.originalOrder?.id ?? null,
    originalOrderNumber: row.originalOrder?.orderNumber ?? null,
    replacementOrderId: row.replacementOrderId ?? row.replacementOrder?.id ?? null,
    replacementOrderNumber: row.replacementOrder?.orderNumber ?? null,
    reason: row.reason ?? null,
    shippingCompany: row.shippingCompany?.name ?? null,
    items: items.map((i: any) => ({
      originalOrderItemId: i.originalOrderItemId ?? null,
      originalSku: i.originalOrderItem?.variant?.sku ?? null,
      newVariantId: i.newVariantId ?? null,
      newSku: i.newVariant?.sku ?? null,
      quantityToReplace: i.quantityToReplace ?? null,
      ...replacementItemProducts(i),
    })),
    createdAt: row.createdAt ?? row.created_at ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

const saveOrderTagsInput = z.object({
  orderId: uuidField(idDescription("Order id.", TOOL.orders.search)),
  addTagIds: z.array(uuidField(idDescription("Tag id to add.", TOOL.tags.list))).optional().describe("Tag ids to add to the order"),
  removeTagIds: z.array(uuidField(idDescription("Tag id to remove.", TOOL.tags.list))).optional().describe("Tag ids to remove from the order"),
});

@McpController()
@UseGuards(McpScopeGuard)
export class McpOrdersTools {
  constructor(
    private orders: OrdersService,
    private notes: OrderInternalNotesService,
    private replacements: OrderReplacementService,
    private returns: OrderReturnService,
    private tagsAssignment: TagsAssignmentService,
  ) { }

  @McpReadTool({
    name: TOOL.orders.search,
    description:
      "Search orders or fetch one. Without `id`: lists orders with paging and the given filters. With `id`: returns that single order with full details. Do not pass `id` together with filters. Read-only.",
    parameters: searchOrdersInput,
  })
  async searchOrders(
    @Payload() input: z.infer<typeof searchOrdersInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "order");
    if (req.mode === "get") {
      return toolJson(toOrderResultDto(await this.orders.get(user, req.id)));
    }
    const q = req.query as typeof req.query & { groupDate?: string };
    const dates = q.groupDate
      ? businessDayRange(q.groupDate, q.groupDate)
      : (() => {
          const d = resolveToolDates(q);
          return { start: d.startDate, end: d.endDate };
        })();
    const postponed = businessDayRange(q.postponedStartDate, q.postponedEndDate);
    const shipped = businessDayRange(q.shippedStartDate, q.shippedEndDate);
    const result = await this.orders.list(user, {
      ...q,
      startDate: dates.start,
      endDate: dates.end,
      postponedStartDate: postponed.start,
      postponedEndDate: postponed.end,
      shippedStartDate: shipped.start,
      shippedEndDate: shipped.end,
      groupDate: undefined,
      sortDir: q.sortOrder,
    });
    return toolPage("orders", result, toOrderSummary, q.limit);
  }

  @McpSaveTool({
    name: TOOL.orders.save,
    description:
      `Create or update an order. Required: mode ("create" or "update"). Required for create: customerName, phoneNumber, address, paymentMethod, items. For update: \`id\` plus any fields to change. Do not use this to change order status.`,
    parameters: saveOrderInput,
  })
  async saveOrder(
    @Payload() input: z.infer<typeof saveOrderInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "order", TOOL.orders.search, {
      updateOnlyKeys: ["trackingNumber", "removedItems"],
    });
    if (req.mode === "create") {
      const parsed = await parseDto(CreateOrderDto, req.fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      const created: any = await this.orders.create(user, parsed.dto);
      return toolJson(toOrderResultDto(await this.orders.get(user, created.id)));
    }
    const parsed = await parseDto(UpdateOrderDto, req.fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toOrderResultDto(await this.orders.update(user, req.id, parsed.dto)));
  }

  @McpSaveTool({
    name: TOOL.orders.act,
    description:
      "Move or reject an order. Required: id, action. action=set_status needs statusId (plus optional notes, postponedDate, reminderDaysBefore, cancelCauseId or customCauseName). action=reject takes optional notes. Status is never changed through save.",
    parameters: ordersActInput,
  })
  async actOnOrder(
    @Payload() input: z.infer<typeof ordersActInput>,
    @McpUser() user: User,
  ) {
    if (input.action === "reject") {
      await this.orders.rejectOrder(user, input.id, { notes: (input as any).notes });
      return toolJson(toOrderResultDto(await this.orders.get(user, input.id)));
    }
    if (!isSet((input as any).statusId)) {
      throw new RpcException("action=set_status requires `statusId`. Use list_order_statuses to find it.");
    }
    const parsed = await parseDto(ChangeOrderStatusDto, {
      statusId: (input as any).statusId,
      notes: (input as any).notes,
      postponedDate: (input as any).postponedDate,
      reminderDaysBefore: (input as any).reminderDaysBefore,
      cancelCauseId: (input as any).cancelCauseId,
      customCauseName: (input as any).customCauseName,
    });
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(
      toOrderResultDto(
        await this.orders.changeStatus(user, input.id, parsed.dto, undefined, {
          defaultConfirmationSource: OrderConfirmationSource.MANUAL,
        }),
      ),
    );
  }

  @McpReadTool({
    name: TOOL.orders.stats,
    description:
      "Order counts. Pass `report`: summary (default — counts per status, optional dates) or shipped (counts/totals by shipping company, optional lateShipping). Not a dashboard_orders_stats report. Read-only.",
    parameters: ordersStatsInput,
  })
  async getOrdersStats(
    @Payload() input: z.infer<typeof ordersStatsInput>,
    @McpUser() user: User,
  ) {
    const report = (input as any)?.report ?? "summary";
    if (report === "shipped") {
      if (isSet((input as any).startDate) || isSet((input as any).endDate) || isSet((input as any).range)) {
        throw new RpcException("report=shipped takes no dates. Remove startDate/endDate/range or set report=summary.");
      }
      return toolJson({
        report,
        ...(await this.orders.getShippedStatsByCompany(user, { lateShipping: (input as any).lateShipping })),
      });
    }
    if (isSet((input as any).lateShipping)) {
      throw new RpcException("`lateShipping` is only valid with report=shipped. Remove it or set report=shipped.");
    }
    const dates = resolveToolDates(input);
    const statuses = await this.orders.getStats(user, {
      startDate: dates.startDate,
      endDate: dates.endDate,
    });
    return toolJson({
      report,
      statuses: Array.isArray(statuses) ? statuses : [],
    });
  }

  @McpReadTool({
    name: TOOL.orders.internalNotesSearch,
    description:
      "List internal notes of one order. Required orderId. Cursor-paged with limit/sortDir/dates. No get-by-id. Read-only.",
    parameters: searchNotesInput,
  })
  async searchInternalNotes(
    @Payload() input: z.infer<typeof searchNotesInput>,
    @McpUser() user: User,
  ) {
    const { orderId, ...q } = input;
    const dates = resolveToolDates(q);
    const result = await this.notes.list(user, orderId, { ...q, ...dates });
    const records = Array.isArray((result as any)?.records) ? (result as any).records : [];
    return toolJson({
      notes: records.map(toInternalNoteDto),
      myUnreadCount: Number((result as any)?.myUnreadCount ?? 0),
      hasMore: Boolean((result as any)?.hasMore ?? false),
      nextCursor: (result as any)?.nextCursor ?? null,
    });
  }

  @McpSaveTool({
    name: TOOL.orders.internalNotesSave,
    description:
      "Add an internal note or mark notes as read. Required orderId. Either body (max 2000, to add) or markRead:true (no body), not both. No update or delete of a note.",
    parameters: saveNotesInput,
  })
  async saveInternalNote(
    @Payload() input: z.infer<typeof saveNotesInput>,
    @McpUser() user: User,
  ) {
    const hasBody = isSet((input as any).body);
    const markRead = (input as any).markRead === true;
    if (hasBody === markRead) {
      throw new RpcException("Pass either `body` to add a note or `markRead: true`, not both and not neither.");
    }
    if (markRead) return toolJson(await this.notes.markRead(user, (input as any).orderId));
    const parsed = await parseDto(CreateOrderInternalNoteDto, { body: (input as any).body });
    if (parsed.ok === false) throw new RpcException(parsed.message);
    const saved = await this.notes.add(user, (input as any).orderId, parsed.dto);
    return toolJson(toInternalNoteDto((saved as any)?.data ?? saved));
  }

  @McpSaveTool({
    name: TOOL.orders.tagsSave,
    description:
      "Add and/or remove tags on one order (same as PATCH /orders/:orderId/tags). Required orderId and at least one of addTagIds / removeTagIds. Returns the order's tags after the change.",
    parameters: saveOrderTagsInput,
  })
  async saveOrderTags(
    @Payload() input: z.infer<typeof saveOrderTagsInput>,
    @McpUser() user: User,
  ) {
    const addTagIds = input.addTagIds ?? [];
    const removeTagIds = input.removeTagIds ?? [];
    if (!addTagIds.length && !removeTagIds.length) {
      throw new RpcException("Pass at least one of `addTagIds` or `removeTagIds`.");
    }
    await this.tagsAssignment.syncOrderManual(user, input.orderId, addTagIds, removeTagIds);
    const rows = await this.tagsAssignment.listOrderTags(user, input.orderId);
    return toolJson({
      orderId: input.orderId,
      tags: (rows ?? []).map((r: any) => ({ id: r.tag?.id ?? r.tagId, name: r.tag?.name ?? null, color: r.tag?.color ?? null })),
    });
  }

  @McpReadTool({
    name: TOOL.orders.replacementsSearch,
    description:
      "List order replacements. Paged with search text, dates, new-order status, and sorting. No get-by-id. Read-only.",
    parameters: searchReplacementsInput,
  })
  async searchReplacements(
    @Payload() input: z.infer<typeof searchReplacementsInput>,
    @McpUser() user: User,
  ) {
    const dates = resolveToolDates(input);
    const result = await this.replacements.listReplacements(user, {
      ...input,
      startDate: dates.startDate,
      endDate: dates.endDate,
      sortDir: (input as any).sortOrder,
    });
    return toolPage("replacements", result, toReplacementSummary, (input as any).limit);
  }

  @McpSaveTool({
    name: TOOL.orders.replacementsSave,
    description:
      "Replace an order (create only). Required: originalOrderId, reason, paymentMethod, items (originalOrderItemId, quantityToReplace, newVariantId, newUnitPrice). No images. Returns the replacement document.",
    parameters: saveReplacementInput,
  })
  async saveReplacement(
    @Payload() input: z.infer<typeof saveReplacementInput>,
    @McpUser() user: User,
  ) {
    const parsed = await parseDto(CreateReplacementDto, input);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    const created: any = await this.replacements.replaceOrder(user, parsed.dto);
    const newOrder: any = await this.orders.get(user, created.newOrder.id);
    const rep: any = newOrder?.replacementResult ?? created.replacement;
    return toolJson(toReplacementSummary({
      ...rep,
      replacementOrder: newOrder ?? created.newOrder,
      shippingCompany: rep?.shippingCompany ?? newOrder?.shippingCompany ?? null,
    }));
  }

  @McpSaveTool({
    name: TOOL.orders.returnsSave,
    description:
      "Step 1 of the RETURN flow: request a return (create only). Required: orderId (status must be Shipped, Delivered, or Failed Delivery) plus items[] (originalItemId = order line id from orders_search, quantity = units coming back for that line). Partial return: send only some lines or a quantity lower than the line quantity; full return: every line with its full quantity. Per item, restockQuantity (default = quantity) is how many units go back to sellable stock; quantity - restockQuantity counts as damaged, and then damageResponsibility (company = carrier pays, internal = we pay) applies. On success the order moves to Return Preparing and lastReturnId points at this request. Next: warehouse_ops_act action=create_return_manifest with the orderId (+ shippingCompanyId, driverName), which receives the parcel and sets the order to Returned (everything returned) or Partially Returned (some returned); then mark_printed with the return manifest id. No return search tool; rows come back on orders_search get. Re-fetch the order after each step. Returns the return request.",
    parameters: saveReturnInput,
  })
  async saveReturn(
    @Payload() input: z.infer<typeof saveReturnInput>,
    @McpUser() user: User,
  ) {
    const parsed = await parseDto(CreateReturnDto, input);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    const saved = await this.returns.createReturnRequest(parsed.dto, user);
    return toolJson({
      id: (saved as any)?.id ?? null,
      orderId: (saved as any)?.orderId ?? (input as any).orderId,
      reason: (saved as any)?.reason ?? null,
    });
  }
}

function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}
