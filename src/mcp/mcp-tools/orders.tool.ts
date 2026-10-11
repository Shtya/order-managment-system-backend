import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { OrdersService } from "src/orders/services/orders.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput, toolInputFor } from "../utils/mcp-dto.util";
import { CreateOrderDto, UpdateOrderDto } from "dto/order.dto";
import {
  OrderEntity,
  OrderItemEntity,
  OrderReplacementEntity,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from "entities/order.entity";
import { ShipmentStatus } from "entities/shipping.entity";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, ref, TOOL } from "../utils/mcp-tool-names";

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
    clientId: z
      .string()
      .optional()
      .describe(
        idDescription(
          "Id of an existing client record. Omit if the customer is not registered.",
          TOOL.clients.search,
        ),
      ),

    // ── Address ────────────────────────────────────────────────
    address: z.string().optional().describe("Delivery address"),
    landmark: z.string().optional().describe("Nearby landmark"),
    cityId: z
      .string()
      .optional()
      .describe(idDescription("City id.", TOOL.cities.list)),
    areaId: z.string().optional().describe(idDescription("Area id.", TOOL.cities.areas)),
    latitude: z.number().optional().describe("Delivery latitude"),
    longitude: z.number().optional().describe("Delivery longitude"),

    // ── Payment ────────────────────────────────────────────────
    paymentMethod: z.enum(PaymentMethod).optional().describe("How the customer pays"),
    paymentStatus: z.enum(PaymentStatus).optional().describe("Current payment status"),
    deposit: z.number().optional().describe("Deposit already paid"),
    discount: z.number().optional().describe("Discount amount (whole number)"),
    additionalFees: z.number().optional().describe("Additional fees"),

    // ── Shipping ───────────────────────────────────────────────
    shippingCompanyId: z
      .string()
      .optional()
      .describe(idDescription("Shipping company id.", TOOL.shippingCompanies.list)),
    storeId: z
      .string()
      .optional()
      .describe(idDescription("Store id.", TOOL.stores.list)),
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
          variantId: z
            .string()
            .describe(idDescription("Variant id of the product.", TOOL.products.search)),
          bundleId: z
            .string()
            .optional()
            .describe(
              idDescription(
                "Bundle id, only when the line is a bundle.",
                TOOL.bundles.search,
              ),
            ),
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
          variantId: z.string().describe("Variant id of the line to remove."),
          bundleId: z.string().optional().describe("Bundle id, only when the removed line is a bundle."),
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
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Order ID. Required for mode=update. Forbidden for mode=create. Find it with ${ref(TOOL.orders.search)}.`,
    ),
  ...saveOrderFields.shape,
});

const orderStatusCodes = Object.values(OrderStatus).join(", ");

const searchOrdersInput = searchInput("order", {
  ...listPaging({
    items: "orders",
    sortBy: ["createdAt", "orderNumber", "finalTotal", "city", "shippedAt", "deliveredAt"],
    defaultSortBy: "createdAt",
    search: "Matches order number, customer name, or phone number",
  }),
  status: z
    .string()
    .optional()
    .describe(`Order status code. One of: ${orderStatusCodes}. Comma-separate several codes.`),
  statusId: z
    .string()
    .optional()
    .describe(
      idDescription(
        "Order status id.",
        TOOL.orderStatuses.list,
        "Omit when `status` is set.",
      ),
    ),
  excludeStatus: z
    .string()
    .optional()
    .describe(`Status codes to leave out. Same values as status: ${orderStatusCodes}. Comma-separate several codes.`),
  paymentStatus: z
    .union([z.enum(PaymentStatus), z.literal(PaymentMethod.CASH_ON_DELIVERY)])
    .optional()
    .describe('Payment status. Pass "cod" to keep only cash-on-delivery orders.'),

  clientId: z
    .string()
    .optional()
    .describe(
      idDescription(
        "Client id.",
        TOOL.clients.search,
        'Pass "all" to skip this filter.',
      ),
    ),
  productId: z
    .string()
    .optional()
    .describe(
      idDescription(
        "Product id.",
        TOOL.products.search,
        'Pass "all" to skip this filter.',
      ),
    ),
  tagId: z
    .string()
    .optional()
    .describe(idDescription("Single tag id.", TOOL.tags.list)),
  tagIds: z
    .array(z.string())
    .optional()
    .describe(
      idDescription("Orders that have any of these tag ids.", TOOL.tags.list),
    ),
  userId: z
    .string()
    .optional()
    .describe(
      idDescription("Employee id of the latest assignee.", TOOL.employees.list),
    ),
  storeId: z
    .string()
    .optional()
    .describe(
      idDescription(
        "Store id.",
        TOOL.stores.list,
        'Pass "none" for orders with no store, "all" to skip.',
      ),
    ),
  shippingCompanyId: z
    .string()
    .optional()
    .describe(
      idDescription(
        "Shipping company id.",
        TOOL.shippingCompanies.list,
        'Pass "none" for orders with no company, "all" to skip.',
      ),
    ),
  lastCancelCauseId: z
    .string()
    .optional()
    .describe(
      idDescription(
        "Cancel-cause id.",
        TOOL.cancelCauses.list,
        'Pass "none" for orders with no cause, "all" to skip.',
      ),
    ),

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

  startDate: z.string().optional().describe("Created-at range start, ISO date (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("Created-at range end, ISO date (YYYY-MM-DD)"),
  groupDate: z
    .string()
    .optional()
    .describe("Exact created-at calendar day, YYYY-MM-DD. When set, startDate and endDate are ignored."),
  postponedStartDate: z.string().optional().describe("Postponed-date range start, ISO date (YYYY-MM-DD)"),
  postponedEndDate: z.string().optional().describe("Postponed-date range end, ISO date (YYYY-MM-DD)"),
  shippedStartDate: z.string().optional().describe("Shipped-at range start, ISO date (YYYY-MM-DD)"),
  shippedEndDate: z.string().optional().describe("Shipped-at range end, ISO date (YYYY-MM-DD)"),
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
      originalProductName: item.originalOrderItem?.variant?.product?.name ?? null,
      originalSku: item.originalOrderItem?.variant?.sku ?? null,
      newProductName: item.newVariant?.product?.name ?? null,
      newSku: item.newVariant?.sku ?? null,
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
    replacementResult: toReplacement(row.replacementResult),
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

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpOrdersTools {
  constructor(private orders: OrdersService) { }

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
    const result = await this.orders.list(user, {
      ...req.query,
      sortDir: req.query.sortOrder,
    });
    return toolPage("orders", result, toOrderSummary, req.query.limit);
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
      return toolJson(toOrderResultDto(await this.orders.create(user, parsed.dto)));
    }
    const parsed = await parseDto(UpdateOrderDto, req.fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toOrderResultDto(await this.orders.update(user, req.id, parsed.dto)));
  }
}
