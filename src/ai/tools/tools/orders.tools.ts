import { Injectable } from "@nestjs/common";
import { OrdersService } from "../../../orders/services/orders.service";
import { AiTool, AiToolExecutor } from "../ai-tool.abstract";
import { AiToolContext } from "../ai-tool-context";
import {
  AddOrderMessageToolArgsDto,
  BulkUpdateOrdersShippingToolArgsDto,
  GetOrderHistoryToolArgsDto,
  GetOrderItemsToolArgsDto,
  GetOrderShippingToolArgsDto,
  GetOrderStatsToolArgsDto,
  GetOrderStatusToolArgsDto,
  GetOrderToolArgsDto,
  GetLatestOrderToolArgsDto,
  GetLatestOrderByPhoneToolArgsDto,
  SearchOrdersByPhoneToolArgsDto,
  SearchOrdersToolArgsDto,
  SummarizeOrderToolArgsDto,
} from "../dto/orders.tool.dto";
import { dtoToJsonSchema } from "../dto-to-json-schema";
import {
  AI_PERMISSION_TOOLS_ORDERS_READ,
  AI_PERMISSION_TOOLS_ORDERS_WRITE,
} from "../../ai.constants";
import { AiExecutionResult } from "../../interfaces/ai-types";
import { OrderEntity } from "entities/order.entity";

const ORDER_UUID_EXAMPLE = "37691350-8adc-4af9-9275-58dce66e5475";
const ORDER_NUMBER_EXAMPLE = "ORD8VVTGTH";
const TRACKING_NUMBER_EXAMPLE = "38098658";

const ORDER_NUMBER_HELP = `An order number is a short code starting with "ORD" + 8 letters/digits (e.g. ${ORDER_NUMBER_EXAMPLE}). It is NOT the UUID id (e.g. ${ORDER_UUID_EXAMPLE}) and NOT a tracking number (e.g. ${TRACKING_NUMBER_EXAMPLE}).`;

@Injectable()
export class OrdersAiTools {
  constructor(private readonly ordersService: OrdersService) {}

  getTools(): AiTool[] {
    return [
      // new AiTool({
      // 	name: 'get_order',
      // 	description:
      // 		`Retrieve a single order by its order number (e.g. ${ORDER_NUMBER_EXAMPLE}). Returns the full order details (customer, totals, payment, shipping, items when includeItems=true). ${ORDER_NUMBER_HELP} A courier tracking number (e.g. ${TRACKING_NUMBER_EXAMPLE}) also works here.`,
      // 	inputSchema: dtoToJsonSchema(GetOrderToolArgsDto),
      // 	argsDto: GetOrderToolArgsDto,
      // 	permission: AI_PERMISSION_TOOLS_ORDERS_READ,
      // 	isWrite: false,
      // 	staleRecovery: 'manual_review',
      // 	run: (ctx, args) => this.getOrder(ctx, args),
      // }),
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
      // new AiTool({
      // 	name: 'get_latest_order_by_phone',
      // 	description:
      // 		`Find the most recent order placed by a specific customer using their phone number. Provide the customer's full phone number, digits only, starting with the country code (e.g. 201000000000 for Egypt). Returns the newest order matching that phone number, or an error if the customer has no orders. Use this when the user refers to "the latest order" of a specific customer.`,
      // 	inputSchema: dtoToJsonSchema(GetLatestOrderByPhoneToolArgsDto),
      // 	argsDto: GetLatestOrderByPhoneToolArgsDto,
      // 	permission: AI_PERMISSION_TOOLS_ORDERS_READ,
      // 	isWrite: false,
      // 	staleRecovery: 'manual_review',
      // 	run: (ctx, args) => this.getLatestOrderByPhone(ctx, args),
      // }),
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
      // new AiTool({
      // 	name: 'search_orders_by_phone',
      // 	description: 'Search orders for a specific customer phone number. Returns a compact list of matching orders.',
      // 	inputSchema: dtoToJsonSchema(SearchOrdersByPhoneToolArgsDto),
      // 	argsDto: SearchOrdersByPhoneToolArgsDto,
      // 	permission: AI_PERMISSION_TOOLS_ORDERS_READ,
      // 	isWrite: false,
      // 	staleRecovery: 'manual_review',
      // 	run: (ctx, args) => this.searchOrdersByPhone(ctx, args),
      // }),
      // new AiTool({
      // 	name: 'get_order_status',
      // 	description:
      // 		`Get the current status of an order (status name, payment status, confirmation, shipping/tracking info) using the order number. ${ORDER_NUMBER_HELP}`,
      // 	inputSchema: dtoToJsonSchema(GetOrderStatusToolArgsDto),
      // 	argsDto: GetOrderStatusToolArgsDto,
      // 	permission: AI_PERMISSION_TOOLS_ORDERS_READ,
      // 	isWrite: false,
      // 	staleRecovery: 'manual_review',
      // 	run: (ctx, args) => this.getOrderStatus(ctx, args),
      // }),
      // new AiTool({
      // 	name: 'summarize_order',
      // 	description:
      // 		`Produce a compact, message-friendly summary of an order (order number, status, totals, items count, shipping location, payment method) using the order number. Ideal before drafting a customer message. ${ORDER_NUMBER_HELP}`,
      // 	inputSchema: dtoToJsonSchema(SummarizeOrderToolArgsDto),
      // 	argsDto: SummarizeOrderToolArgsDto,
      // 	permission: AI_PERMISSION_TOOLS_ORDERS_READ,
      // 	isWrite: false,
      // 	staleRecovery: 'manual_review',
      // 	run: (ctx, args) => this.summarizeOrder(ctx, args),
      // }),
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
      // new AiTool({
      // 	name: 'get_order_items',
      // 	description:
      // 		`Retrieve the items of an order (quantities, prices, product names) using the order number. ${ORDER_NUMBER_HELP}`,
      // 	inputSchema: dtoToJsonSchema(GetOrderItemsToolArgsDto),
      // 	argsDto: GetOrderItemsToolArgsDto,
      // 	permission: AI_PERMISSION_TOOLS_ORDERS_READ,
      // 	isWrite: false,
      // 	staleRecovery: 'manual_review',
      // 	run: (ctx, args) => this.getOrderItems(ctx, args),
      // }),
      // new AiTool({
      // 	name: 'get_order_shipping',
      // 	description:
      // 		`Retrieve the shipping details of an order (shipping company, tracking number, city/area, shipping metadata) using the order number. ${ORDER_NUMBER_HELP}`,
      // 	inputSchema: dtoToJsonSchema(GetOrderShippingToolArgsDto),
      // 	argsDto: GetOrderShippingToolArgsDto,
      // 	permission: AI_PERMISSION_TOOLS_ORDERS_READ,
      // 	isWrite: false,
      // 	staleRecovery: 'manual_review',
      // 	run: (ctx, args) => this.getOrderShipping(ctx, args),
      // }),
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
      // new AiTool({
      // 	name: 'add_order_message',
      // 	description:
      // 		`Append an internal note/message to an order. Use when an admin needs to log context or a follow-up on a specific order. ${ORDER_NUMBER_HELP}`,
      // 	inputSchema: dtoToJsonSchema(AddOrderMessageToolArgsDto),
      // 	argsDto: AddOrderMessageToolArgsDto,
      // 	permission: AI_PERMISSION_TOOLS_ORDERS_WRITE,
      // 	isWrite: true,
      // 	staleRecovery: 'auto_recover',
      // 	run: (ctx, args) => this.addOrderMessage(ctx, args),
      // }),
      // new AiTool({
      // 	name: 'bulk_update_orders_shipping',
      // 	description:
      // 		`Update shipping fields (city / area / provider location) for one or more orders in a single transaction. Idempotent when re-run with the same input. Each item's ${ORDER_NUMBER_HELP}`,
      // 	inputSchema: dtoToJsonSchema(BulkUpdateOrdersShippingToolArgsDto),
      // 	argsDto: BulkUpdateOrdersShippingToolArgsDto,
      // 	permission: AI_PERMISSION_TOOLS_ORDERS_WRITE,
      // 	isWrite: true,
      // 	staleRecovery: 'auto_recover',
      // 	run: (ctx, args) => this.bulkUpdateOrdersShipping(ctx, args),
      // }),
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

  private async getOrder(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDER_FOUND", async () => {
      const order: any = await this.ordersService.get(
        this.buildMe(ctx),
        String(args.orderNumber),
      );
      return mapOrderCompact(order, {
        includeItems: Boolean(args.includeItems),
      });
    });
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

  private async getLatestOrderByPhone(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDER_FOUND", async () => {
      const records = await this.ordersService.list(this.buildMe(ctx), {
        search: String(args.phoneNumber),
        limit: 1,
        page: 1,
      });
      const order = (records as any)?.records?.[0];
      if (!order) throw new Error("No order found for this phone number");
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

  private async searchOrdersByPhone(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDERS_FOUND", async () => {
      const result = await this.ordersService.list(this.buildMe(ctx), {
        search: String(args.phoneNumber),
        limit: 20,
        page: 1,
      });
      const records = (result as any)?.records ?? [];
      return records.map((o: any) =>
        mapOrderCompact(o, { includeItems: false }),
      );
    });
  }

  private async getOrderStatus(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDER_STATUS", async () => {
      const order: any = await this.ordersService.get(
        this.buildMe(ctx),
        String(args.orderNumber),
      );
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status?.name ?? order.status?.code ?? null,
        statusId: order.statusId,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        isConfirmed: order.isConfirmed,
        confirmedAt: order.confirmedAt,
        trackingNumber: order.trackingNumber,
        shippingCompany: order.shippingCompany?.name ?? null,
        shippedAt: order.shippedAt,
      };
    });
  }

  private async summarizeOrder(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDER_SUMMARY", async () => {
      const order: any = await this.ordersService.get(
        this.buildMe(ctx),
        String(args.orderNumber),
      );
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        phoneNumber: order.normalizedPhoneNumber ?? order.phoneNumber,
        city: order.city,
        area: order.area,
        status: order.status?.name ?? null,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        deposit: order.deposit,
        productsTotal: order.productsTotal,
        finalTotal: order.finalTotal,
        profit: order.profit,
        itemsCount: order.items?.length ?? 0,
        createdAt: order.created_at ?? order.createdAt,
        shippingCompany: order.shippingCompany?.name ?? null,
        trackingNumber: order.trackingNumber,
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

  private async getOrderItems(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDER_ITEMS", async () => {
      const order: any = await this.ordersService.get(
        this.buildMe(ctx),
        String(args.orderNumber),
      );
      const items = order.items ?? [];
      return items.map((item: any) => ({
        id: item.id,
        sku: item.sku,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        subtotal: item.subtotal,
        productName: item.variant?.product?.name ?? item.productName ?? null,
        variantName: item.variant?.name ?? null,
      }));
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

  private async addOrderMessage(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDER_MESSAGE_ADDED", async () => {
      const order: any = await this.ordersService.get(
        this.buildMe(ctx),
        String(args.orderNumber),
      );
      const message = await this.ordersService.addMessage(
        this.buildMe(ctx),
        order.id,
        {
          message: String(args.message),
          senderType: "admin",
        },
      );
      return { id: (message as any)?.id, message: (message as any)?.message };
    });
  }

  private async bulkUpdateOrdersShipping(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("ORDERS_SHIPPING_UPDATED", async () => {
      const rawItems = Array.isArray(args.items) ? args.items : [];
      const me = this.buildMe(ctx);
      const items: any[] = [];
      for (const item of rawItems) {
        const order: any = await this.ordersService.get(
          me,
          String((item as any).orderNumber),
        );
        items.push({ ...(item as any), id: order.id });
      }
      const result = await this.ordersService.bulkUpdateShippingFields(me, {
        items,
      } as any);
      return result;
    });
  }
}

function mapOrderCompact(order: OrderEntity, opts: { includeItems: boolean }) {
  return {
    // =========================
    // Order
    // =========================
    id: order.id,
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    phoneNumber: order.normalizedPhoneNumber ?? order.phoneNumber,
    address: order.address,
    city: order.city,
    area: order.area,

    // =========================
    // Status
    // =========================
    status: order.status?.name ?? null,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,

    // =========================
    // Financial
    // =========================
    deposit: order.deposit,
    additionalFees: order.additionalFees,
    productsTotal: order.productsTotal,
    finalTotal: order.finalTotal,
    profit: order.profit,

    // =========================
    // Store
    // =========================
    store: order.store
      ? {
          id: order.store.id,
          name: order.store.name ?? null,
        }
      : null,

    // =========================
    // Shipping company
    // =========================
    shippingCompany: order.shippingCompany
      ? {
          id: order.shippingCompany.id,
          name: order.shippingCompany.name ?? null,
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
    items: (order.items ?? []).map((item: any) => ({
      id: item.id,
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,

      productName: item.variant?.product?.name ?? item.productName ?? null,

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

          originalOrderId: order.replacementResult.originalOrder?.id ?? null,

          items: (order.replacementResult.items ?? []).map((item: any) => ({
            id: item.id,
            originalOrderItemId: item.originalOrderItem?.id ?? null,
            productName: item.originalOrderItem?.variant?.product?.name ?? null,
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
