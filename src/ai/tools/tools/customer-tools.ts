import { forwardRef, Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, Repository, SelectQueryBuilder } from "typeorm";
import { AiTool } from "src/ai/tools/ai-tool.abstract";
import { AiToolContext } from "src/ai/tools/ai-tool-context";
import {
  AiToolNamespace,
  AiToolRegistryService,
} from "src/ai/tools/ai-tool-registry.service";
import { AGENT_END_TURN_TOOL } from "src/ai/orchestrator/ai-loop-policy";
import { AiToolExecutionResult } from "src/ai/interfaces/ai-types";
import {
  OrderEntity,
  OrderItemEntity,
  OrderReplacementEntity,
  OrderStatus,
  OrderStatusEntity,
} from "entities/order.entity";
import { AreaEntity, CityEntity } from "entities/cities.entity";
import { CustomerEntity } from "entities/customers.entity";
import { ClientService } from "src/clients/clients.service";
import { ShippingService } from "src/shipping/shipping.service";
import { AgentPendingActionType, AgentTaskStatus } from "entities/agent-conversation.entity";
import { AgentTaskService } from "src/agents/runtime/agent-task.service";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";
import { DateFilterUtil } from "common/date-filter.util";
import {
  AGENT_CANCEL_BUTTON_PREFIX,
  AGENT_CONFIRM_BUTTON_PREFIX,
  AGENT_EDIT_BUTTON_PREFIX,
  AgentToolScope,
} from "src/agents/runtime/agent-runtime.constants";
import { AgentCustomerWindowClosedError, AgentSendBlockedError, AgentSenderService } from "src/agents/runtime/agent-sender.service";
import { AgentCampaignOffersService } from "src/agents/runtime/agent-campaign-offers.service";
import { AgentPendingActionsService } from "src/agents/runtime/agent-pending-actions.service";
import { AgentCustomerEditsService } from "src/agents/runtime/agent-customer-edits.service";
import {
  AgentCatalogError,
  AgentCatalogKind,
  AgentCatalogService,
  AgentOrderDraft,
  AgentOrderLineInput,
} from "src/agents/runtime/agent-catalog.service";
import { ConversationService } from "src/conversation/conversation.service";
import { IssueService } from "src/issue/issue.service";
import { IssuePriority } from "entities/issue.entity";

export const LIMITS = {
  text: 4096,
  body: 1024,
  header: 60,
  footer: 60,
  buttonTitle: 20,
  buttons: 3,
  listButton: 20,
  rowTitle: 24,
  rowDescription: 72,
  rows: 10,
  optionId: 200,
  caption: 1024,
};

export const RESERVED_ID_PREFIXES = [
  AGENT_CONFIRM_BUTTON_PREFIX,
  AGENT_EDIT_BUTTON_PREFIX,
  AGENT_CANCEL_BUTTON_PREFIX,
];

export type Args = Record<string, any>;

export function fail(code: string, error: string): AiToolExecutionResult {
  return { ok: false, code, error };
}

export function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function agentScopeOf(ctx: AiToolContext): AgentToolScope {
  const scope = ctx.session.metadata?.agentScope as AgentToolScope | undefined;
  if (!scope?.adminId || !scope.customerId || !scope.conversationId || !scope.turnId) {
    throw new Error("Customer tools can only run inside an agent turn");
  }
  return scope;
}

@Injectable()
export class CustomerTools implements AiToolNamespace, OnModuleInit {
  constructor(
    @Inject(forwardRef(() => AiToolRegistryService))
    private readonly registry: AiToolRegistryService,
    private readonly sender: AgentSenderService,
    private readonly offers: AgentCampaignOffersService,
    private readonly actions: AgentPendingActionsService,
    private readonly tasks: AgentTaskService,
    private readonly catalog: AgentCatalogService,
    private readonly edits: AgentCustomerEditsService,
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(CityEntity)
    private readonly cityRepo: Repository<CityEntity>,
    @InjectRepository(AreaEntity)
    private readonly areaRepo: Repository<AreaEntity>,
    @InjectRepository(CustomerEntity)
    private readonly customerRepo: Repository<CustomerEntity>,
    @Inject(forwardRef(() => ClientService))
    private readonly clients: ClientService,
    @Inject(forwardRef(() => ShippingService))
    private readonly shipping: ShippingService,
    @Inject(forwardRef(() => ConversationService))
    private readonly conversations: ConversationService,
    @Inject(forwardRef(() => IssueService))
    private readonly issues: IssueService,
  ) { }

  onModuleInit() {
    this.registry.registerNamespace(this);
  }

  getTools(): AiTool[] {
    return [
      // Messaging
      this.endTurn(),
  
      // Customer & Orders
      this.getMyOrders(),
      this.getOrderDetails(),
      this.getMyAddresses(),
  
      // Products & Offers
      this.listCategories(),
      this.searchProducts(),
      this.searchBundles(),
      this.getProductDetails(),
      this.getBundleDetails(),
      this.getMyCampaignOffers(),
  
      // Order Creation
      this.requestOrder(),
      this.requestCampaignOrder(),
      this.requestAddOrderItems(),
      this.requestReplaceOrderItems(),
      this.requestUpdateOrderItems(),
      this.requestUpdateOrderInfo(),
      this.requestCancelOrder(),
      this.requestPostponeOrder(),
      this.requestConfirmOrder(),
      this.requestAddCustomerAddress(),
      this.requestRemoveCustomerAddress(),
      this.requestUpdateCustomerAddress(),
      this.requestSetDefaultAddress(),
      this.requestUpdateCustomer(),
      this.humanHandoff(),
      this.listIssueCauses(),
  
      // Address & Shipping
      this.requestAddressUpdate(),
      this.checkShippingCoverage(),
      this.closeAddressTask(),
  
      // Pending Actions
      this.confirmPendingAction(),
      this.cancelPendingAction(),
    ];
  }

  private listIssueCauses() {
    return new AiTool({
      name: "list_issue_causes",
      audience: "customer",
      description:
        "List issue types (causes) for human_handoff. Pick the closest id. If none fit, use Other / أخرى.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      isWrite: false,
      staleRecovery: "auto_recover",
      run: async (ctx) => {
        const scope = agentScopeOf(ctx);
        const records = await this.issues.listHandoffCauses(scope.adminId);
        return { ok: true, code: "OK", records };
      },
    });
  }

  private humanHandoff() {
    return new AiTool({
      name: "human_handoff",
      audience: "customer",
      description:
        "Create an issue for the store team after you already told the customer that staff will take over. Write title and description in Arabic for the team: a short case title and a briefing they can act on (what the customer wants, what you already checked, order number if any). Do not dump the chat. Call list_issue_causes first and pass causeId (or Other). If the customer named a specific order, call get_my_orders or get_order_details first and pass that orderId; otherwise omit orderId. Do not send another WhatsApp message from this tool.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Arabic one-line case title for the store team.",
          },
          description: {
            type: "string",
            description:
              "Arabic briefing: problem, customer request, what you checked, IDs/numbers.",
          },
          causeId: {
            type: "string",
            description: "UUID from list_issue_causes. Use Other if unsure.",
          },
          orderId: {
            type: "string",
            description: "Order UUID from get_my_orders / get_order_details, only if the customer named that order.",
          },
          priority: {
            type: "string",
            enum: Object.values(IssuePriority),
            description: "Only if store instructions say to override the default.",
          },
        },
        required: ["title", "description"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "manual_review",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const title = str(args.title);
        const description = str(args.description);
        if (!title || !description) {
          return fail("MISSING_FIELDS", "title and description are required in Arabic.");
        }
        const priorityRaw = str(args.priority).toLowerCase();
        const priority = (Object.values(IssuePriority) as string[]).includes(priorityRaw)
          ? (priorityRaw as IssuePriority)
          : undefined;
        const outcome = await this.conversations.startHumanHandoff({
          adminId: scope.adminId,
          conversationId: scope.conversationId,
          agentId: scope.agentId,
          title,
          description,
          causeId: str(args.causeId) || undefined,
          orderId: str(args.orderId) || undefined,
          priority,
        });
        return {
          ok: true,
          code: outcome.code,
          issueId: outcome.issueId,
          humanHandoff: outcome.humanHandoff,
        };
      },
    });
  }

  private endTurn() {
    return new AiTool({
      name: AGENT_END_TURN_TOOL,
      audience: "customer",
      description:
        "End this turn: after your last send, or alone when the input needs no reply.",
      inputSchema: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Short note, e.g. 'replied', 'waiting_for_choice'." },
        },
        additionalProperties: false,
      },
      isWrite: false,
      staleRecovery: "auto_recover",
      run: async () => ({ ok: true, code: "TURN_ENDED" }),
    });
  }

  // ---------------------------------------------------------------- read tools

  private getMyOrders() {
    return new AiTool({
      name: "get_my_orders",
      audience: "customer",
      description:
        "Get the customer's orders, newest first. Optional combined filters: statuses, order number, product, date range.",
      inputSchema: {
        type: "object",
        properties: {
          statuses: {
            type: "array",
            items: { type: "string", enum: Object.values(OrderStatus) },
            description: "Status codes to include.",
          },
          orderNumber: { type: "string", description: "Full or partial order number." },
          productName: { type: "string", description: "Product name contained in the order." },
          createdFrom: { type: "string", description: "On or after (YYYY-MM-DD)." },
          createdTo: { type: "string", description: "On or before (YYYY-MM-DD)." },
          limit: { type: "integer", minimum: 1, maximum: 10 },
          page: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      isWrite: false,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
        const page = Math.max(1, Number(args.page) || 1);

        const qb = this.orderRepo
          .createQueryBuilder("o")
          .leftJoinAndSelect("o.status", "status")
          .leftJoinAndSelect("o.items", "item")
          .leftJoinAndSelect("item.variant", "variant")
          .leftJoinAndSelect("variant.product", "product")
          .leftJoinAndSelect("o.shippingCompany", "shippingCompany");
        await this.scopeToCustomer(qb, scope);

        const validStatuses = new Set<string>(Object.values(OrderStatus));
        const statuses = (Array.isArray(args.statuses) ? args.statuses : [])
          .map(str)
          .filter((s) => validStatuses.has(s));
        if (statuses.length) qb.andWhere("status.code IN (:...statuses)", { statuses });

        const orderNumber = str(args.orderNumber);
        if (orderNumber) qb.andWhere("o.orderNumber ILIKE :orderNumber", { orderNumber: `%${orderNumber}%` });

        const productName = str(args.productName);
        if (productName) {
          qb.andWhere((sub) => {
            const exists = sub
              .subQuery()
              .select("1")
              .from(OrderItemEntity, "fi")
              .innerJoin("fi.variant", "fv")
              .innerJoin("fv.product", "fp")
              .where("fi.orderId = o.id")
              .andWhere("fp.name ILIKE :productName")
              .getQuery();
            return `EXISTS ${exists}`;
          }, { productName: `%${productName}%` });
        }

        DateFilterUtil.applyToQueryBuilder(
          qb,
          "o.created_at",
          str(args.createdFrom) || undefined,
          str(args.createdTo) || undefined,
        );

        const [orders, total] = await qb
          .orderBy("o.created_at", "DESC")
          .skip((page - 1) * limit)
          .take(limit)
          .getManyAndCount();
        return {
          ok: true,
          code: "ORDERS",
          data: {
            total,
            page,
            hasMore: page * limit < total,
            orders: orders.map((o) => ({
              orderNumber: o.orderNumber,
              status: customerStatusLabel(o.status),
              createdAt: o.created_at,
              total: Number(o.finalTotal ?? 0),
              productsTotal: Number(o.productsTotal ?? 0),
              shippingCost: Number(o.shippingCost ?? 0),
              discount: Number(o.discount ?? 0),
              deposit: Number(o.deposit ?? 0),
              items: (o.items ?? []).map((i) => ({
                product: i.variant?.product?.name ?? null,
                quantity: i.quantity,
              })),
              isReplacement: o.isReplacement || undefined,
              shippingCompany: o.shippingCompany?.name ?? null,
              shippedAt: o.shippedAt ?? null,
              deliveredAt: o.deliveredAt ?? null,
            })),
          },
        };
      },
    });
  }

  private getOrderDetails() {
    return new AiTool({
      name: "get_order_details",
      audience: "customer",
      description:
        "Details of one customer order by order number: items, totals, address, shipping, tracking, replacements. Tags are internal; never mention them.",
      inputSchema: {
        type: "object",
        properties: { orderNumber: { type: "string" } },
        required: ["orderNumber"],
        additionalProperties: false,
      },
      isWrite: false,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const orderNumber = str(args.orderNumber);
        if (!orderNumber) return fail("INVALID_ARGS", "orderNumber is required");
        const qb = this.orderRepo
          .createQueryBuilder("o")
          .leftJoinAndSelect("o.status", "status")
          .leftJoinAndSelect("o.items", "item")
          .leftJoinAndSelect("item.variant", "variant")
          .leftJoinAndSelect("variant.product", "product")
          .leftJoinAndSelect("o.shippingCompany", "shippingCompany")
          .leftJoinAndSelect("o.orderTags", "orderTag")
          .leftJoinAndSelect("orderTag.tag", "tag")
          // This order was replaced by another order
          .leftJoinAndSelect("o.replacementRequest", "replacementRequest")
          .leftJoinAndSelect("replacementRequest.replacementOrder", "repNewOrder")
          .leftJoinAndSelect("repNewOrder.status", "repNewOrderStatus")
          .leftJoinAndSelect("replacementRequest.items", "reqItems")
          .leftJoinAndSelect("reqItems.originalOrderItem", "reqOrigItem")
          .leftJoinAndSelect("reqOrigItem.variant", "reqOrigVar")
          .leftJoinAndSelect("reqOrigVar.product", "reqOrigProd")
          .leftJoinAndSelect("reqItems.newVariant", "reqNewVar")
          .leftJoinAndSelect("reqNewVar.product", "reqNewProd")
          // This order is the replacement of another order
          .leftJoinAndSelect("o.replacementResult", "replacementResult")
          .leftJoinAndSelect("replacementResult.originalOrder", "repOrigOrder")
          .leftJoinAndSelect("replacementResult.items", "resItems")
          .leftJoinAndSelect("resItems.originalOrderItem", "resOrigItem")
          .leftJoinAndSelect("resOrigItem.variant", "resOrigVar")
          .leftJoinAndSelect("resOrigVar.product", "resOrigProd")
          .leftJoinAndSelect("resItems.newVariant", "resNewVar")
          .leftJoinAndSelect("resNewVar.product", "resNewProd");
        await this.scopeToCustomer(qb, scope);
        const order = await qb.andWhere("o.orderNumber = :orderNumber", { orderNumber }).getOne();
        if (!order) return fail("NOT_FOUND", "No order with this number for this customer");

        const describeReplacement = (r: OrderReplacementEntity) => ({
          reason: r.anotherReason || r.reason || null,
          items: (r.items ?? []).map((i) => ({
            from: i.originalOrderItem?.variant?.product?.name ?? null,
            to: i.newVariant?.product?.name ?? null,
            quantity: i.quantityToReplace,
          })),
        });
        const replacedBy = order.replacementRequest;
        const replacementOf = order.replacementResult;

        return {
          ok: true,
          code: "ORDER",
          data: {
            orderNumber: order.orderNumber,
            status: customerStatusLabel(order.status),
            createdAt: order.created_at,
            customerName: order.customerName,
            address: order.address,
            city: order.city,
            cityId: order.cityId ?? null,
            area: order.area ?? null,
            landmark: order.landmark ?? null,
            paymentMethod: order.paymentMethod,
            items: (order.items ?? []).map((i) => ({
              product: i.variant?.product?.name ?? null,
              options: i.variant?.attributes ?? null,
              quantity: i.quantity,
              unitPrice: Number(i.unitPrice ?? 0),
              variantId: i.variantId,
              bundleId: i.bundleId ?? null,
            })),
            productsTotal: Number(order.productsTotal ?? 0),
            shippingCost: Number(order.shippingCost ?? 0),
            discount: Number(order.discount ?? 0),
            total: Number(order.finalTotal ?? 0),
            shippingCompany: order.shippingCompany?.name ?? null,
            trackingNumber: order.trackingNumber ?? null,
            shippedAt: order.shippedAt ?? null,
            deliveredAt: order.deliveredAt ?? null,
            replacedBy: replacedBy
              ? {
                orderNumber: replacedBy.replacementOrder?.orderNumber ?? null,
                status: customerStatusLabel(replacedBy.replacementOrder?.status),
                ...describeReplacement(replacedBy),
              }
              : null,
            replacementOf: replacementOf
              ? {
                orderNumber: replacementOf.originalOrder?.orderNumber ?? null,
                ...describeReplacement(replacementOf),
              }
              : null,
            tags: (order.orderTags ?? []).map((t) => t.tag?.name).filter(Boolean),
          },
        };
      },
    });
  }

  private getMyCampaignOffers() {
    return new AiTool({
      name: "get_my_campaign_offers",
      audience: "customer",
      description:
        "Offers this customer received: products, prices, shipping, total, saved data, city/area requirements.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      isWrite: false,
      staleRecovery: "auto_recover",
      run: async (ctx) => {
        const scope = agentScopeOf(ctx);
        return { ok: true, code: "OFFERS", data: await this.offers.listForCustomer(scope) };
      },
    });
  }

  private getMyAddresses() {
    return new AiTool({
      name: "get_my_addresses",
      audience: "customer",
      description:
        "Customer's saved addresses, default first. Use them to fill an order instead of asking.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      isWrite: false,
      staleRecovery: "auto_recover",
      run: async (ctx) => {
        const scope = agentScopeOf(ctx);
        const clientId = await this.resolveClientId(scope);
        if (!clientId) return { ok: true, code: "ADDRESSES", data: { addresses: [] } };
        const addresses = await this.clients.findAddressesForAdmin(scope.adminId, clientId);
        return {
          ok: true,
          code: "ADDRESSES",
          data: {
            addresses: addresses.map((a) => ({
              addressId: a.id,
              label: a.label ?? null,
              address: a.address,
              city: a.cityDetails?.nameAr ?? a.city,
              cityId: a.cityId ?? null,
              area: a.areaDetails?.nameAr ?? a.area,
              areaId: a.areaId ?? null,
              landmark: a.landmark ?? null,
              isDefault: a.isDefault,
            })),
          },
        };
      },
    });
  }

  private listCategories() {
    return new AiTool({
      name: "list_categories",
      audience: "customer",
      description: "Store product categories with product counts. Use when asked what you sell.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      isWrite: false,
      staleRecovery: "auto_recover",
      run: async (ctx) => {
        const scope = agentScopeOf(ctx);
        return { ok: true, code: "CATEGORIES", data: await this.catalog.listCategories(scope.adminId) };
      },
    });
  }

  private searchProducts() {
    return new AiTool({
      name: "search_products",
      audience: "customer",
      description:
        "Search products by text, category, price, options, stock. Paged: offer the next page when total_records > current_page * per_page. Never invent products or prices. Use search_bundles for packs.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name, SKU, description or category." },
          categoryId: { type: "string", description: "Category id from list_categories." },
          minPrice: { type: "number", minimum: 0 },
          maxPrice: { type: "number", minimum: 0 },
          options: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Variant option filters.",
          },
          inStockOnly: { type: "boolean", description: "Defaults true; false includes out-of-stock." },
          limit: { type: "integer", minimum: 1, maximum: 10 },
          page: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      isWrite: false,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => this.runCatalogSearch(ctx, args, "product"),
    });
  }

  private searchBundles() {
    return new AiTool({
      name: "search_bundles",
      audience: "customer",
      description:
        "Search bundles (packs/combos) by text, price, stock. Paged: offer the next page when total_records > current_page * per_page. Never invent bundles or prices. Use search_products for single products.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name, SKU or keywords." },
          minPrice: { type: "number", minimum: 0 },
          maxPrice: { type: "number", minimum: 0 },
          inStockOnly: { type: "boolean", description: "Defaults true; false includes out-of-stock." },
          limit: { type: "integer", minimum: 1, maximum: 10 },
          page: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      isWrite: false,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => this.runCatalogSearch(ctx, args, "bundle"),
    });
  }

  private getProductDetails() {
    return new AiTool({
      name: "get_product_details",
      audience: "customer",
      description:
        "One product's options, variants (id/price/stock), images (main first), upsells. Call before asking for a variant choice and before send_image. Mention stock only when low (2 or fewer).",
      inputSchema: {
        type: "object",
        properties: { productId: { type: "string" } },
        required: ["productId"],
        additionalProperties: false,
      },
      isWrite: false,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        try {
          return { ok: true, code: "PRODUCT", data: await this.catalog.getProductDetails(agentScopeOf(ctx).adminId, str(args.productId)) };
        } catch (error) {
          return catalogFail(error);
        }
      },
    });
  }

  private getBundleDetails() {
    return new AiTool({
      name: "get_bundle_details",
      audience: "customer",
      description: "Get bundle price, contents, images, and available stock.",
      inputSchema: {
        type: "object",
        properties: { bundleId: { type: "string" } },
        required: ["bundleId"],
        additionalProperties: false,
      },
      isWrite: false,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        try {
          return { ok: true, code: "BUNDLE", data: await this.catalog.getBundleDetails(agentScopeOf(ctx).adminId, str(args.bundleId)) };
        } catch (error) {
          return catalogFail(error);
        }
      },
    });
  }

  // ---------------------------------------------------------------- write tools (pending actions)

  private requestOrder() {
    return new AiTool({
      name: "request_order",
      audience: "customer",
      description:
        "The confirmation step: call when variants, quantities, name and address are ready. The server prices, checks stock, and sends a Confirm/Edit/Cancel summary. Don't ask for confirmation first. Call again after corrections. End the turn after calling. shippingCost/discount default 0; pass a value only from Store knowledge or owner instructions, never the customer.",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                variantId: { type: "string", description: "variantId from get_product_details." },
                bundleId: { type: "string", description: "bundleId from search_bundles / get_bundle_details." },
                quantity: { type: "integer", minimum: 1, maximum: 50 },
              },
              additionalProperties: false,
            },
            description: "Each item is a product variant or a bundle, never both.",
          },
          customerName: { type: "string", maxLength: 200 },
          address: { type: "string", maxLength: 1000 },
          city: { type: "string", maxLength: 100 },
          cityId: { type: "string" },
          area: { type: "string", maxLength: 100 },
          areaId: { type: "string" },
          landmark: { type: "string", maxLength: 200 },
          notes: { type: "string", maxLength: 1000 },
          shippingCost: {
            type: "number",
            minimum: 0,
            description:
              "Only from an applicable Store-knowledge or owner shipping rule. Never the customer.",
          },
          discount: {
            type: "number",
            minimum: 0,
            description:
              "Only from an applicable Store-knowledge or owner discount rule. Never the customer.",
          },
          language: { type: "string", enum: ["ar", "en"] },
        },
        required: ["items", "customerName", "address", "language"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const requested = parseRequestedItems(args.items);
        if ("error" in requested) return requested.error;
        const address = await this.readAddressArgs(args);
        if ("error" in address) return address.error;
        const shippingCost = moneyArg(args.shippingCost, "shippingCost");
        if (typeof shippingCost !== "number") return shippingCost;
        const discount = moneyArg(args.discount, "discount");
        if (typeof discount !== "number") return discount;

        let draft: AgentOrderDraft;
        try {
          draft = await this.catalog.buildOrderDraft(scope.adminId, requested.items);
        } catch (error) {
          return catalogFail(error);
        }

        const en = args.language === "en";
        const summary = renderOrderSummary(draft, address.data, en, { shippingCost, discount });
        const action = await this.actions.create(scope, {
          type: AgentPendingActionType.ORDER,
          targetKey: "order:new",
          payload: {
            requested: requested.items,
            priceFingerprint: draft.priceFingerprint,
            clientId: await this.resolveClientId(scope),
            shippingCost,
            discount,
            ...address.data,
          },
          summary,
        });
        return this.sendConfirmation(scope, action, summary, en);
      },
    });
  }

  private requestCampaignOrder() {
    return new AiTool({
      name: "request_campaign_order",
      audience: "customer",
      description:
        "The confirmation step for a campaign order: validates, saves a pending action, sends Confirm/Edit/Cancel. Don't ask first. Call again after corrections. Nothing is ordered until later confirmation. End the turn after calling.",
      inputSchema: {
        type: "object",
        properties: {
          offerId: { type: "string", description: "offerId from get_my_campaign_offers" },
          customerName: { type: "string", maxLength: 200 },
          address: { type: "string", maxLength: 1000 },
          city: { type: "string", maxLength: 100 },
          cityId: { type: "string" },
          area: { type: "string", maxLength: 100 },
          areaId: { type: "string" },
          landmark: { type: "string", maxLength: 200 },
          notes: { type: "string", maxLength: 1000 },
          language: { type: "string", enum: ["ar", "en"], description: "Summary language (the one you're replying in)." },
        },
        required: ["offerId", "customerName", "address", "language"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const offerId = str(args.offerId);
        const recipient = offerId ? await this.offers.getOwnedRecipient(scope, offerId) : null;
        if (!recipient) return fail("NOT_FOUND", "This offer was not sent to this customer.");

        const offer = await this.offers.describe(scope.adminId, recipient);
        if (offer.status === "already_ordered") {
          return fail("ALREADY_ORDERED", `The customer already ordered this offer (order ${offer.orderNumber ?? "-"}).`);
        }
        if (offer.status !== "open") return fail("OFFER_UNAVAILABLE", "This offer is no longer available.");

        const payload = {
          offerId: recipient.id,
          customerName: str(args.customerName),
          address: str(args.address),
          city: str(args.city) || undefined,
          cityId: str(args.cityId) || undefined,
          area: str(args.area) || undefined,
          areaId: str(args.areaId) || undefined,
          landmark: str(args.landmark) || undefined,
          customerNotes: str(args.notes) || undefined,
        };
        if (!payload.customerName) return fail("MISSING_DATA", "customerName is required");
        if (!payload.address) return fail("MISSING_DATA", "address is required");
        if (offer.requiresCityAndArea && !payload.city) {
          return fail("MISSING_DATA", "city is required for this offer (use get_my_addresses or get_cities)");
        }
        if (payload.cityId) {
          const city = await this.cityRepo.findOne({ where: { id: payload.cityId, isActive: true } });
          if (!city) return fail("INVALID_ARGS", "cityId must come from get_cities or get_my_addresses");
        }
        if (payload.areaId) {
          const area = await this.areaRepo.findOne({
            where: { id: payload.areaId, isActive: true, ...(payload.cityId ? { cityId: payload.cityId } : {}) },
          });
          if (!area) return fail("INVALID_ARGS", "areaId must come from get_areas_by_city (or get_my_addresses) for the chosen city");
        }

        const en = args.language === "en";
        const summary = renderCampaignSummary(offer, payload, en);
        const action = await this.actions.create(scope, {
          type: AgentPendingActionType.CAMPAIGN_ORDER,
          targetKey: `campaign:${recipient.id}`,
          payload,
          summary,
        });
        return this.sendConfirmation(scope, action, summary, en);
      },
    });
  }

  private catalogItemProperties() {
    return {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          variantId: { type: "string", description: "variantId from get_product_details." },
          bundleId: { type: "string", description: "bundleId from search_bundles / get_bundle_details." },
          quantity: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      description: "Each item is a product variant or a bundle, never both.",
    };
  }

  private requestAddOrderItems() {
    return this.orderItemsWriteTool({
      name: "request_add_order_items",
      type: AgentPendingActionType.ADD_ORDER_ITEMS,
      description:
        "Add products or bundles to an existing order. Blocked after warehouse/courier statuses. Sends Confirm/Edit/Cancel. End the turn after calling.",
      extraProperties: {},
      extraRequired: [],
      summary: (en, orderNumber, draft) =>
        en
          ? `Add to order ${orderNumber}:\n${draftLines(draft)}\nConfirm?`
          : `إضافة لطلب ${orderNumber}:\n${draftLines(draft)}\nنأكد؟`,
    });
  }

  private requestUpdateOrderItems() {
    return this.orderItemsWriteTool({
      name: "request_update_order_items",
      type: AgentPendingActionType.UPDATE_ORDER_ITEMS,
      description:
        "Replace the order's items with this full list (quantities included). Blocked after warehouse/courier statuses. Sends Confirm/Edit/Cancel. End the turn after calling.",
      extraProperties: {},
      extraRequired: [],
      summary: (en, orderNumber, draft) =>
        en
          ? `Update items on order ${orderNumber} to:\n${draftLines(draft)}\nConfirm?`
          : `تحديث منتجات طلب ${orderNumber} إلى:\n${draftLines(draft)}\nنأكد؟`,
    });
  }

  private requestReplaceOrderItems() {
    return this.orderItemsWriteTool({
      name: "request_replace_order_items",
      type: AgentPendingActionType.REPLACE_ORDER_ITEMS,
      description:
        "Swap one item on an existing order (fromVariantId of a product line, or fromBundleId of a pack) for the items list. Blocked after warehouse/courier statuses. End the turn after calling.",
      extraProperties: {
        fromVariantId: { type: "string", description: "Existing product variantId from get_order_details." },
        fromBundleId: { type: "string", description: "Existing bundleId from get_order_details." },
      },
      extraRequired: [],
      summary: (en, orderNumber, draft, args) =>
        en
          ? `Replace ${str(args.fromBundleId) || str(args.fromVariantId)} on order ${orderNumber} with:\n${draftLines(draft)}\nConfirm?`
          : `استبدال ${str(args.fromBundleId) || str(args.fromVariantId)} في طلب ${orderNumber} بـ:\n${draftLines(draft)}\nنأكد؟`,
      validate: (args) => {
        if (Boolean(str(args.fromVariantId)) === Boolean(str(args.fromBundleId))) {
          return fail("INVALID_ARGS", "Pass either fromVariantId or fromBundleId");
        }
        return null;
      },
    });
  }

  private orderItemsWriteTool(opts: {
    name: string;
    type: AgentPendingActionType;
    description: string;
    extraProperties: Record<string, unknown>;
    extraRequired: string[];
    summary: (en: boolean, orderNumber: string, draft: AgentOrderDraft, args: Args) => string;
    validate?: (args: Args) => AiToolExecutionResult | null;
  }) {
    return new AiTool({
      name: opts.name,
      audience: "customer",
      description: opts.description,
      inputSchema: {
        type: "object",
        properties: {
          orderNumber: { type: "string" },
          items: this.catalogItemProperties(),
          language: { type: "string", enum: ["ar", "en"] },
          ...opts.extraProperties,
        },
        required: ["orderNumber", "items", "language", ...opts.extraRequired],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const invalid = opts.validate?.(args);
        if (invalid) return invalid;
        const prepared = await this.prepareMutableOrder(ctx, args);
        if ("error" in prepared) return prepared.error;
        const requested = parseRequestedItems(args.items);
        if ("error" in requested) return requested.error;
        let draft: AgentOrderDraft;
        try {
          draft = await this.catalog.buildOrderDraft(prepared.scope.adminId, requested.items);
        } catch (error) {
          return catalogFail(error);
        }
        const en = args.language === "en";
        const summary = opts.summary(en, prepared.order.orderNumber, draft, args);
        const action = await this.actions.create(prepared.scope, {
          type: opts.type,
          targetKey: `${opts.type}:${prepared.order.id}`,
          orderId: prepared.order.id,
          payload: {
            orderNumber: prepared.order.orderNumber,
            requested: requested.items,
            priceFingerprint: draft.priceFingerprint,
            fromVariantId: str(args.fromVariantId) || undefined,
            fromBundleId: str(args.fromBundleId) || undefined,
          },
          summary,
        });
        return this.sendConfirmation(prepared.scope, action, summary, en);
      },
    });
  }

  private requestUpdateOrderInfo() {
    return new AiTool({
      name: "request_update_order_info",
      audience: "customer",
      description:
        "Update an existing order's name, address, city, area, landmark or notes. Not allowed after warehouse/courier statuses. Sends Confirm/Edit/Cancel. End the turn after calling.",
      inputSchema: {
        type: "object",
        properties: {
          orderNumber: { type: "string" },
          customerName: { type: "string", maxLength: 200 },
          address: { type: "string", maxLength: 1000 },
          city: { type: "string", maxLength: 100 },
          cityId: { type: "string" },
          area: { type: "string", maxLength: 100 },
          areaId: { type: "string" },
          landmark: { type: "string", maxLength: 200 },
          notes: { type: "string", maxLength: 1000 },
          language: { type: "string", enum: ["ar", "en"] },
        },
        required: ["orderNumber", "language"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const prepared = await this.prepareMutableOrder(ctx, args);
        if ("error" in prepared) return prepared.error;
        const patch = {
          customerName: str(args.customerName) || undefined,
          address: str(args.address) || undefined,
          city: str(args.city) || undefined,
          cityId: str(args.cityId) || undefined,
          area: str(args.area) || undefined,
          areaId: str(args.areaId) || undefined,
          landmark: str(args.landmark) || undefined,
          customerNotes: str(args.notes) || undefined,
        };
        if (!Object.values(patch).some(Boolean)) {
          return fail("INVALID_ARGS", "Pass at least one field to update");
        }
        if (patch.cityId || patch.areaId) {
          const checked = await this.readAddressArgs({
            customerName: patch.customerName || prepared.order.customerName || "x",
            address: patch.address || prepared.order.address || "x",
            ...patch,
          });
          if ("error" in checked) return checked.error;
        }
        const en = args.language === "en";
        const bits = [
          patch.customerName && (en ? `Name: ${patch.customerName}` : `الاسم: ${patch.customerName}`),
          patch.address && (en ? `Address: ${patch.address}` : `العنوان: ${patch.address}`),
          (patch.city || patch.area) && (en ? `Area: ${[patch.area, patch.city].filter(Boolean).join(", ")}` : `المنطقة: ${[patch.area, patch.city].filter(Boolean).join("، ")}`),
          patch.landmark && (en ? `Landmark: ${patch.landmark}` : `علامة مميزة: ${patch.landmark}`),
          patch.customerNotes && (en ? `Notes: ${patch.customerNotes}` : `ملاحظات: ${patch.customerNotes}`),
        ].filter(Boolean);
        const summary = en
          ? `Update order ${prepared.order.orderNumber}:\n${bits.join("\n")}\nConfirm?`
          : `تحديث طلب ${prepared.order.orderNumber}:\n${bits.join("\n")}\nنأكد؟`;
        const action = await this.actions.create(prepared.scope, {
          type: AgentPendingActionType.UPDATE_ORDER_INFO,
          targetKey: `update_order_info:${prepared.order.id}`,
          orderId: prepared.order.id,
          payload: { orderNumber: prepared.order.orderNumber, ...patch },
          summary,
        });
        return this.sendConfirmation(prepared.scope, action, summary, en);
      },
    });
  }

  private requestCancelOrder() {
    return this.orderStatusWriteTool({
      name: "request_cancel_order",
      type: AgentPendingActionType.CANCEL_ORDER,
      description: "Cancel an existing order if it is not yet with the warehouse or courier. Sends Confirm/Edit/Cancel. End the turn after calling.",
      extra: {},
      summary: (en, n) => (en ? `Cancel order ${n}?` : `إلغاء طلب ${n}؟`),
    });
  }

  private requestConfirmOrder() {
    return this.orderStatusWriteTool({
      name: "request_confirm_order",
      type: AgentPendingActionType.CONFIRM_ORDER,
      description: "Confirm an existing order if it is not yet with the warehouse or courier. Sends Confirm/Edit/Cancel. End the turn after calling.",
      extra: {},
      summary: (en, n) => (en ? `Confirm order ${n}?` : `تأكيد طلب ${n}؟`),
    });
  }

  private requestPostponeOrder() {
    return this.orderStatusWriteTool({
      name: "request_postpone_order",
      type: AgentPendingActionType.POSTPONE_ORDER,
      description: "Postpone an existing order (YYYY-MM-DD). Not allowed after warehouse/courier statuses. Sends Confirm/Edit/Cancel. End the turn after calling.",
      extra: {
        postponedDate: { type: "string", description: "YYYY-MM-DD" },
      },
      extraRequired: ["postponedDate"],
      summary: (en, n, args) =>
        en ? `Postpone order ${n} to ${str(args.postponedDate)}?` : `تأجيل طلب ${n} ليوم ${str(args.postponedDate)}؟`,
      validate: (args) => {
        const raw = str(args.postponedDate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fail("INVALID_ARGS", "postponedDate must be YYYY-MM-DD");
        const date = new Date(`${raw}T12:00:00.000Z`);
        if (Number.isNaN(date.getTime())) return fail("INVALID_ARGS", "postponedDate must be YYYY-MM-DD");
        return null;
      },
    });
  }

  private orderStatusWriteTool(opts: {
    name: string;
    type: AgentPendingActionType;
    description: string;
    extra: Record<string, unknown>;
    extraRequired?: string[];
    summary: (en: boolean, orderNumber: string, args: Args) => string;
    validate?: (args: Args) => AiToolExecutionResult | null;
  }) {
    return new AiTool({
      name: opts.name,
      audience: "customer",
      description: opts.description,
      inputSchema: {
        type: "object",
        properties: {
          orderNumber: { type: "string" },
          language: { type: "string", enum: ["ar", "en"] },
          ...opts.extra,
        },
        required: ["orderNumber", "language", ...(opts.extraRequired ?? [])],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const invalid = opts.validate?.(args);
        if (invalid) return invalid;
        const prepared = await this.prepareMutableOrder(ctx, args);
        if ("error" in prepared) return prepared.error;
        const en = args.language === "en";
        const summary = opts.summary(en, prepared.order.orderNumber, args);
        const action = await this.actions.create(prepared.scope, {
          type: opts.type,
          targetKey: `${opts.type}:${prepared.order.id}`,
          orderId: prepared.order.id,
          payload: {
            orderNumber: prepared.order.orderNumber,
            postponedDate: str(args.postponedDate) || undefined,
          },
          summary,
        });
        return this.sendConfirmation(prepared.scope, action, summary, en);
      },
    });
  }

  private requestAddCustomerAddress() {
    return new AiTool({
      name: "request_add_customer_address",
      audience: "customer",
      description: "Save a new address in the customer's address book. Match city/area with get_cities / get_areas_by_city. Sends Confirm/Edit/Cancel. End the turn after calling.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string", maxLength: 100 },
          address: { type: "string", maxLength: 1000 },
          city: { type: "string", maxLength: 100 },
          cityId: { type: "string" },
          area: { type: "string", maxLength: 100 },
          areaId: { type: "string" },
          landmark: { type: "string", maxLength: 200 },
          isDefault: { type: "boolean" },
          language: { type: "string", enum: ["ar", "en"] },
        },
        required: ["address", "language"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const clientId = await this.resolveClientId(scope);
        if (!clientId) return fail("NOT_FOUND", "This customer has no address book yet.");
        const parsed = await this.readAddressArgs({ ...args, customerName: "x" });
        if ("error" in parsed) return parsed.error;
        const en = args.language === "en";
        const summary = en
          ? `Save this address${str(args.label) ? ` (${str(args.label)})` : ""}: ${parsed.data.address}. Confirm?`
          : `حفظ العنوان${str(args.label) ? ` (${str(args.label)})` : ""}: ${parsed.data.address}. نأكد؟`;
        const action = await this.actions.create(scope, {
          type: AgentPendingActionType.ADD_CUSTOMER_ADDRESS,
          targetKey: "address:add",
          payload: {
            label: str(args.label) || undefined,
            isDefault: Boolean(args.isDefault),
            ...parsed.data,
          },
          summary,
        });
        return this.sendConfirmation(scope, action, summary, en);
      },
    });
  }

  private requestRemoveCustomerAddress() {
    return new AiTool({
      name: "request_remove_customer_address",
      audience: "customer",
      description: "Remove a saved address (addressId from get_my_addresses). Sends Confirm/Edit/Cancel. End the turn after calling.",
      inputSchema: {
        type: "object",
        properties: {
          addressId: { type: "string" },
          language: { type: "string", enum: ["ar", "en"] },
        },
        required: ["addressId", "language"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const prepared = await this.prepareOwnedAddress(ctx, args);
        if ("error" in prepared) return prepared.error;
        const en = args.language === "en";
        const summary = en
          ? `Remove saved address ${prepared.address.address}?`
          : `مسح العنوان المحفوظ ${prepared.address.address}؟`;
        const action = await this.actions.create(prepared.scope, {
          type: AgentPendingActionType.REMOVE_CUSTOMER_ADDRESS,
          targetKey: `address:remove:${prepared.address.id}`,
          payload: { addressId: prepared.address.id },
          summary,
        });
        return this.sendConfirmation(prepared.scope, action, summary, en);
      },
    });
  }

  private requestUpdateCustomerAddress() {
    return new AiTool({
      name: "request_update_customer_address",
      audience: "customer",
      description: "Edit a saved address (addressId from get_my_addresses). Sends Confirm/Edit/Cancel. End the turn after calling.",
      inputSchema: {
        type: "object",
        properties: {
          addressId: { type: "string" },
          label: { type: "string", maxLength: 100 },
          address: { type: "string", maxLength: 1000 },
          city: { type: "string", maxLength: 100 },
          cityId: { type: "string" },
          area: { type: "string", maxLength: 100 },
          areaId: { type: "string" },
          landmark: { type: "string", maxLength: 200 },
          isDefault: { type: "boolean" },
          language: { type: "string", enum: ["ar", "en"] },
        },
        required: ["addressId", "language"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const prepared = await this.prepareOwnedAddress(ctx, args);
        if ("error" in prepared) return prepared.error;
        const patch = {
          label: str(args.label) || undefined,
          address: str(args.address) || undefined,
          cityId: str(args.cityId) || undefined,
          areaId: str(args.areaId) || undefined,
          landmark: str(args.landmark) || undefined,
          isDefault: args.isDefault === undefined ? undefined : Boolean(args.isDefault),
        };
        if (!Object.values(patch).some((v) => v !== undefined && v !== "")) {
          return fail("INVALID_ARGS", "Pass at least one field to update");
        }
        if (patch.cityId || patch.areaId) {
          const checked = await this.readAddressArgs({
            customerName: "x",
            address: patch.address || prepared.address.address,
            ...patch,
          });
          if ("error" in checked) return checked.error;
        }
        const en = args.language === "en";
        const summary = en
          ? `Update saved address ${prepared.address.address}. Confirm?`
          : `تحديث العنوان المحفوظ ${prepared.address.address}. نأكد؟`;
        const action = await this.actions.create(prepared.scope, {
          type: AgentPendingActionType.UPDATE_CUSTOMER_ADDRESS,
          targetKey: `address:update:${prepared.address.id}`,
          payload: { addressId: prepared.address.id, ...patch },
          summary,
        });
        return this.sendConfirmation(prepared.scope, action, summary, en);
      },
    });
  }

  private requestSetDefaultAddress() {
    return new AiTool({
      name: "request_set_default_address",
      audience: "customer",
      description: "Set a saved address as the default (addressId from get_my_addresses). Sends Confirm/Edit/Cancel. End the turn after calling.",
      inputSchema: {
        type: "object",
        properties: {
          addressId: { type: "string" },
          language: { type: "string", enum: ["ar", "en"] },
        },
        required: ["addressId", "language"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const prepared = await this.prepareOwnedAddress(ctx, args);
        if ("error" in prepared) return prepared.error;
        const en = args.language === "en";
        const summary = en
          ? `Make ${prepared.address.address} the default address?`
          : `جعل ${prepared.address.address} العنوان الافتراضي؟`;
        const action = await this.actions.create(prepared.scope, {
          type: AgentPendingActionType.SET_DEFAULT_ADDRESS,
          targetKey: `address:default:${prepared.address.id}`,
          payload: { addressId: prepared.address.id },
          summary,
        });
        return this.sendConfirmation(prepared.scope, action, summary, en);
      },
    });
  }

  private requestUpdateCustomer() {
    return new AiTool({
      name: "request_update_customer",
      audience: "customer",
      description: "Update the customer's name and/or email (email is stored on the linked client). Do not change the phone. Sends Confirm/Edit/Cancel. End the turn after calling.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 200 },
          email: { type: "string", maxLength: 200 },
          language: { type: "string", enum: ["ar", "en"] },
        },
        required: ["language"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const name = str(args.name) || undefined;
        const email = str(args.email) || undefined;
        if (!name && !email) return fail("INVALID_ARGS", "Pass name and/or email");
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("INVALID_ARGS", "email is invalid");
        if (email && !(await this.resolveClientId(scope))) {
          return fail("NOT_FOUND", "This customer has no client record for email.");
        }
        const en = args.language === "en";
        const bits = [
          name && (en ? `Name: ${name}` : `الاسم: ${name}`),
          email && (en ? `Email: ${email}` : `الإيميل: ${email}`),
        ].filter(Boolean);
        const summary = en ? `Update your details:\n${bits.join("\n")}\nConfirm?` : `تحديث بياناتك:\n${bits.join("\n")}\nنأكد؟`;
        const action = await this.actions.create(scope, {
          type: AgentPendingActionType.UPDATE_CUSTOMER,
          targetKey: `customer:${scope.customerId}`,
          payload: { name, email },
          summary,
        });
        return this.sendConfirmation(scope, action, summary, en);
      },
    });
  }

  private requestAddressUpdate() {
    return new AiTool({
      name: "request_address_update",
      audience: "customer",
      description:
        "The confirmation step for the open address task. Call only after the task shipping company covers this city, zone, and district with dropOff true. Validates and sends Confirm/Edit/Cancel. End the turn after calling; no message about it. Never invent ids.",
      inputSchema: {
        type: "object",
        properties: {
          cityId: { type: "string" },
          areaId: { type: "string" },
          area: { type: "string" },
          address: { type: "string" },
          landmark: { type: "string" },
          zoneId: { type: "string", description: "Zone id from get_shipping_zones for the task shipping company." },
          districtId: { type: "string", description: "District id from get_shipping_districts for the task shipping company." },
          latitude: { type: "number" },
          longitude: { type: "number" },
          language: { type: "string", enum: ["ar", "en"] },
        },
        required: ["cityId", "address", "landmark", "language"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const task = await this.tasks.getOpenForConversation(scope.adminId, scope.conversationId);
        if (!task) return fail("NO_TASK", "There is no open address task for this conversation.");
        const cityId = str(args.cityId);
        const address = str(args.address);
        const landmark = str(args.landmark);
        const areaId = str(args.areaId) || undefined;
        const areaText = str(args.area) || undefined;
        if (!cityId) return fail("INCOMPLETE", "cityId is required from get_cities.");
        if (!address) return fail("INCOMPLETE", "address is required.");
        if (!landmark) return fail("LANDMARK_REQUIRED", "A named landmark is required.");
        if (!areaId && !areaText) return fail("INCOMPLETE", "area or areaId is required.");

        const city = await this.cityRepo.findOne({
          where: { id: cityId, isActive: true },
          relations: { providerLocations: true },
        });
        if (!city) return fail("INVALID_ARGS", "cityId must come from get_cities.");

        if (areaId) {
          const area = await this.areaRepo.findOne({
            where: { id: areaId, isActive: true, cityId },
          });
          if (!area) return fail("AREA_NOT_IN_CITY", "areaId must belong to the chosen city.");
        }

        const provider = String(task.payload?.provider || "").toLowerCase();
        const providerLocation = (city.providerLocations ?? []).find(
          (pl) => String(pl.provider || "").toLowerCase() === provider,
        );
        if (!provider || provider === "none" || !providerLocation?.providerCityId) {
          return fail(
            "UNSUPPORTED_CITY",
            `${task.payload?.shippingCompany || provider || "This company"} does not cover ${city.nameAr || city.nameEn}. Tell the customer. Do not retry this address.`,
          );
        }
        if (providerLocation.dropOff === false) {
          return fail(
            "UNSUPPORTED_CITY",
            `${task.payload?.shippingCompany || provider} cannot deliver to ${city.nameAr || city.nameEn} (dropOff false). Tell the customer. Do not retry this address.`,
          );
        }

        let zones: any[] = [];
        let districts: any[] = [];
        try {
          const [zoneRes, districtRes] = await Promise.all([
            this.shipping.getZones(scope.adminId, provider, String(providerLocation.providerCityId)),
            this.shipping.getDistricts(scope.adminId, provider, String(providerLocation.providerCityId)),
          ]);
          zones = Array.isArray(zoneRes?.records) ? zoneRes.records : [];
          districts = Array.isArray(districtRes?.records) ? districtRes.records : [];
        } catch {
          return fail(
            "UNSUPPORTED_CITY",
            `${task.payload?.shippingCompany || provider} does not cover ${city.nameAr || city.nameEn}. Ask for another city or close the task.`,
          );
        }
        if (!zones.length && !districts.length) {
          return fail(
            "UNSUPPORTED_CITY",
            `${task.payload?.shippingCompany || provider} does not cover ${city.nameAr || city.nameEn}. Ask for another city or close the task.`,
          );
        }

        const zoneId = str(args.zoneId) || undefined;
        const districtId = str(args.districtId) || undefined;
        if (zones.length) {
          if (!zoneId) return fail("INCOMPLETE", "zoneId is required from get_shipping_zones.");
          const zone = zones.find((z) => String(z.id) === zoneId);
          if (!zone) {
            return fail("INVALID_ARGS", "zoneId must come from get_shipping_zones for this city and company.");
          }
          if (zone.dropOff === false) {
            return fail(
              "UNSUPPORTED_CITY",
              `${task.payload?.shippingCompany || provider} cannot deliver to this zone (dropOff false). Tell the customer. Do not retry this address.`,
            );
          }
        }
        if (districts.length) {
          if (!districtId) return fail("INCOMPLETE", "districtId is required from get_shipping_districts.");
          const district = districts.find((d) => String(d.id) === districtId);
          if (!district) {
            return fail("INVALID_ARGS", "districtId must come from get_shipping_districts for this city and company.");
          }
          if (district.dropOff === false) {
            return fail(
              "UNSUPPORTED_CITY",
              `${task.payload?.shippingCompany || provider} cannot deliver to this district (dropOff false). Tell the customer. Do not retry this address.`,
            );
          }
          const parent = district.zoneId ?? district.parentId;
          if (zoneId && parent && String(parent) !== zoneId) {
            return fail("INVALID_ARGS", "districtId must belong to the chosen zone.");
          }
        }

        const en = args.language === "en";
        const payload = {
          cityId,
          city: city.nameAr || city.nameEn,
          areaId,
          area: areaText,
          address,
          landmark,
          zoneId,
          districtId,
          latitude: args.latitude != null ? Number(args.latitude) : undefined,
          longitude: args.longitude != null ? Number(args.longitude) : undefined,
        };
        const summary = en
          ? [
              "Please confirm this delivery address:",
              payload.address,
              payload.landmark ? `Landmark: ${payload.landmark}` : "",
              [payload.area, payload.city].filter(Boolean).join(" — "),
            ]
              .filter(Boolean)
              .join("\n")
          : [
              "أكد العنوان:",
              payload.address,
              payload.landmark ? `علامة مميزة: ${payload.landmark}` : "",
              [payload.area, payload.city].filter(Boolean).join(" — "),
            ]
              .filter(Boolean)
              .join("\n");
        const action = await this.actions.create(scope, {
          type: AgentPendingActionType.ADDRESS_CORRECTION,
          targetKey: `address:${task.orderId}`,
          payload: { ...payload, taskId: task.id },
          summary,
          orderId: task.orderId,
        });
        return this.sendConfirmation(scope, action, summary, en);
      },
    });
  }

  private checkShippingCoverage() {
    return new AiTool({
      name: "check_shipping_coverage",
      audience: "customer",
      description:
        "Check if the task's shipping company covers a cityId from get_cities, including dropOff. Not a substitute for checking zone/district dropOff.",
      inputSchema: {
        type: "object",
        properties: { cityId: { type: "string" } },
        required: ["cityId"],
        additionalProperties: false,
      },
      isWrite: false,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const task = await this.tasks.getOpenForConversation(scope.adminId, scope.conversationId);
        if (!task) return fail("NO_TASK", "There is no open address task for this conversation.");
        const cityId = str(args.cityId);
        const city = await this.cityRepo.findOne({
          where: { id: cityId, isActive: true },
          relations: { providerLocations: true },
        });
        if (!city) return fail("INVALID_ARGS", "cityId must come from get_cities.");
        const provider = String(task.payload?.provider || "").toLowerCase();
        const providerLocation = (city.providerLocations ?? []).find(
          (pl) => String(pl.provider || "").toLowerCase() === provider,
        );
        const dropOff = !!providerLocation && providerLocation.dropOff !== false;
        const covered =
          !provider ||
          provider === "none" ||
          dropOff;
        return {
          ok: true,
          code: "COVERAGE",
          data: {
            cityId: city.id,
            city: city.nameAr,
            provider: task.payload?.provider || null,
            shippingCompany: task.payload?.shippingCompany || null,
            dropOff,
            covered,
          },
        };
      },
    });
  }

  private closeAddressTask() {
    return new AiTool({
      name: "close_address_task",
      audience: "customer",
      description:
        "Close the open address task when the customer refuses or delivery is impossible.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "manual_review",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const task = await this.tasks.getOpenForConversation(scope.adminId, scope.conversationId);
        if (!task) return fail("NO_TASK", "There is no open address task for this conversation.");
        await this.tasks.close(task.id, str(args.reason) || "customer_refused");
        return { ok: true, code: "TASK_CLOSED", data: { taskId: task.id } };
      },
    });
  }

  private confirmPendingAction() {
    return new AiTool({
      name: "confirm_pending_action",
      audience: "customer",
      description:
        "Execute a pending action after clear customer confirmation (message or positive reaction on the summary). Then send a separate done message.",
      inputSchema: {
        type: "object",
        properties: { actionId: { type: "string" } },
        required: ["actionId"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "manual_review",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const outcome = await this.actions.confirm(scope, str(args.actionId));
        return outcome.ok
          ? { ok: true, code: outcome.code, data: { actionId: outcome.actionId, ...outcome.result } }
          : fail(outcome.code, outcome.error);
      },
    });
  }

  private cancelPendingAction() {
    return new AiTool({
      name: "cancel_pending_action",
      audience: "customer",
      description: "Cancel a pending action the customer no longer wants.",
      inputSchema: {
        type: "object",
        properties: { actionId: { type: "string" } },
        required: ["actionId"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const outcome = await this.actions.cancel(scope, str(args.actionId));
        return outcome.ok ? { ok: true, code: outcome.code, data: { actionId: outcome.actionId } } : fail(outcome.code, outcome.error);
      },
    });
  }

  // ---------------------------------------------------------------- helpers

  private async runCatalogSearch(ctx: AiToolContext, args: Args, kind: AgentCatalogKind) {
    const scope = agentScopeOf(ctx);
    const data = await this.catalog.search(scope.adminId, {
      query: str(args.query) || undefined,
      categoryId: kind === "product" ? str(args.categoryId) || undefined : undefined,
      minPrice: args.minPrice != null ? Number(args.minPrice) : undefined,
      maxPrice: args.maxPrice != null ? Number(args.maxPrice) : undefined,
      options:
        kind === "product" && args.options && typeof args.options === "object" ? args.options : undefined,
      inStockOnly: args.inStockOnly,
      kind,
      limit: args.limit,
      page: args.page,
    });
    return { ok: true, code: kind === "product" ? "PRODUCTS" : "BUNDLES", data };
  }

  private async prepareMutableOrder(ctx: AiToolContext, args: Args) {
    const scope = agentScopeOf(ctx);
    const orderNumber = str(args.orderNumber);
    if (!orderNumber) return { error: fail("INVALID_ARGS", "orderNumber is required") };
    const order = await this.edits.findOwnedOrder(scope, orderNumber);
    if (!order) return { error: fail("NOT_FOUND", "No order with this number for this customer") };
    const locked = this.edits.warehouseBlocked(order);
    if (locked) return { error: fail("ORDER_LOCKED", locked) };
    return { scope, order };
  }

  private async prepareOwnedAddress(ctx: AiToolContext, args: Args) {
    const scope = agentScopeOf(ctx);
    const addressId = str(args.addressId);
    if (!addressId) return { error: fail("INVALID_ARGS", "addressId is required") };
    const clientId = await this.resolveClientId(scope);
    if (!clientId) return { error: fail("NOT_FOUND", "This customer has no address book yet.") };
    const addresses = await this.clients.findAddressesForAdmin(scope.adminId, clientId);
    const address = addresses.find((a) => a.id === addressId);
    if (!address) return { error: fail("NOT_FOUND", "No saved address with this id") };
    return { scope, address };
  }

  /** The customer's client record: the WhatsApp contact's link, else a lookup by phone. */
  private async resolveClientId(scope: AgentToolScope): Promise<string | null> {
    const customer = await this.customerRepo.findOne({
      where: { id: scope.customerId, adminId: scope.adminId },
      select: { id: true, clientId: true },
    });
    return (
      customer?.clientId ??
      (await this.clients.findClientIdByPhone(scope.adminId, normalizeEgyptianPhoneNumber(scope.phoneNumber)))
    );
  }

  /** Orders of the current customer: same phone number, or linked to the same client record. */
  private async scopeToCustomer(qb: SelectQueryBuilder<OrderEntity>, scope: AgentToolScope) {
    const clientId = await this.resolveClientId(scope);
    const phone = normalizeEgyptianPhoneNumber(scope.phoneNumber);
    qb.where("o.adminId = :adminId", { adminId: scope.adminId }).andWhere(
      new Brackets((b) => {
        b.where("o.normalized_phone = :phone", { phone });
        if (clientId) b.orWhere("o.clientId = :clientId", { clientId });
      }),
    );
  }

  private async sendConfirmation(
    scope: AgentToolScope,
    action: { id: string },
    summary: string,
    en: boolean,
  ): Promise<AiToolExecutionResult> {
    try {
      const { wamid } = await this.sender.send(
        scope,
        {
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: summary.slice(0, LIMITS.body) },
            action: {
              buttons: [
                { type: "reply", reply: { id: `${AGENT_CONFIRM_BUTTON_PREFIX}${action.id}`, title: en ? "Confirm" : "تأكيد" } },
                { type: "reply", reply: { id: `${AGENT_EDIT_BUTTON_PREFIX}${action.id}`, title: en ? "Edit" : "تعديل" } },
                { type: "reply", reply: { id: `${AGENT_CANCEL_BUTTON_PREFIX}${action.id}`, title: en ? "Cancel" : "إلغاء" } },
              ],
            },
          },
        },
        { agentPendingActionId: action.id },
      );
      await this.actions.attachSummaryMessage(action.id, wamid);
    } catch (error) {
      await this.actions.discard(action.id);
      if (error instanceof AgentCustomerWindowClosedError) throw error;
      if (error instanceof AgentSendBlockedError) return fail("SEND_BLOCKED", `${error.message}. End the turn.`);
      throw error;
    }
    return {
      ok: true,
      code: "CONFIRMATION_REQUESTED",
      data: {
        actionId: action.id,
        sentSummary: summary,
        next: "Summary with Confirm/Edit/Cancel sent. End the turn and wait for the customer.",
      },
    };
  }

  private async readAddressArgs(args: Args) {
    const data = {
      customerName: str(args.customerName),
      address: str(args.address),
      city: str(args.city) || undefined,
      cityId: str(args.cityId) || undefined,
      area: str(args.area) || undefined,
      areaId: str(args.areaId) || undefined,
      landmark: str(args.landmark) || undefined,
      customerNotes: str(args.notes) || undefined,
    };
    if (!data.customerName) return { error: fail("MISSING_DATA", "customerName is required") };
    if (!data.address) return { error: fail("MISSING_DATA", "address is required") };
    if (data.cityId) {
      const city = await this.cityRepo.findOne({ where: { id: data.cityId, isActive: true } });
      if (!city) return { error: fail("INVALID_ARGS", "cityId must come from get_cities or get_my_addresses") };
    }
    if (data.areaId) {
      const area = await this.areaRepo.findOne({
        where: { id: data.areaId, isActive: true, ...(data.cityId ? { cityId: data.cityId } : {}) },
      });
      if (!area) {
        return { error: fail("INVALID_ARGS", "areaId must come from get_areas_by_city (or get_my_addresses) for the chosen city") };
      }
    }
    return { data };
  }

}

const IN_FOLLOW_UP = { ar: "قيد المتابعة", en: "Being followed up" };
const BEING_PREPARED = { ar: "جاري تجهيز الطلب", en: "Being prepared" };

/** Internal-only statuses (duplicate, wrong number, ...) map to a neutral label on purpose. */
const CUSTOMER_STATUS_LABELS: Record<OrderStatus, { ar: string; en: string }> = {
  [OrderStatus.NEW]: { ar: "قيد المراجعة", en: "Under review" },
  [OrderStatus.UNDER_REVIEW]: { ar: "قيد المراجعة", en: "Under review" },
  [OrderStatus.POSTPONED]: { ar: "متأجل", en: "Postponed" },
  [OrderStatus.CONFIRMED]: { ar: "اتأكد", en: "Confirmed" },
  [OrderStatus.NO_ANSWER]: IN_FOLLOW_UP,
  [OrderStatus.NO_ANSWER_FOLLOW_UP]: IN_FOLLOW_UP,
  [OrderStatus.WRONG_NUMBER]: IN_FOLLOW_UP,
  [OrderStatus.OUT_OF_DELIVERY_AREA]: { ar: "خارج نطاق التوصيل", en: "Outside the delivery area" },
  [OrderStatus.DUPLICATE]: IN_FOLLOW_UP,
  [OrderStatus.REJECTED]: { ar: "اتلغى", en: "Cancelled" },
  [OrderStatus.CANCELLED]: { ar: "اتلغى", en: "Cancelled" },
  [OrderStatus.CANCELLED_FOLLOW_UP]: { ar: "اتلغى", en: "Cancelled" },
  [OrderStatus.FAILED_DELIVERY]: { ar: "التوصيل متمش", en: "Delivery was not completed" },
  [OrderStatus.DISTRIBUTED]: { ar: "اتسلم لشركة الشحن", en: "Handed to the courier" },
  [OrderStatus.PRINTED]: BEING_PREPARED,
  [OrderStatus.PREPARING]: BEING_PREPARED,
  [OrderStatus.READY]: { ar: "جاهز للشحن", en: "Ready to ship" },
  [OrderStatus.SHIPPED]: { ar: "في الطريق لحضرتك", en: "On the way" },
  [OrderStatus.DELIVERED]: { ar: "اتسلم", en: "Delivered" },
  [OrderStatus.RETURN_PREPARING]: { ar: "جاري تجهيز المرتجع", en: "Return in progress" },
  [OrderStatus.RETURNED]: { ar: "مرتجع", en: "Returned" },
  [OrderStatus.PARTIALLY_RETURNED]: { ar: "مرتجع جزئياً", en: "Partially returned" },
};

function customerStatusLabel(status?: OrderStatusEntity | null) {
  if (!status) return null;
  const label = status.system ? CUSTOMER_STATUS_LABELS[status.code as OrderStatus] : undefined;
  if (label) return label;
  return {
    name: status.name,
    note: "Store-defined status name; describe it naturally in the customer's language.",
  };
}

function moneyArg(value: unknown, field: string): number | AiToolExecutionResult {
  if (value == null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fail("INVALID_ARGS", `${field} must be 0 or a positive number`);
  return Math.round(n * 100) / 100;
}

function catalogFail(error: unknown): AiToolExecutionResult {
  if (error instanceof AgentCatalogError) {
    return { ok: false, code: error.code, error: error.message, data: error.data };
  }
  throw error;
}

function parseRequestedItems(raw: unknown): { items: AgentOrderLineInput[] } | { error: AiToolExecutionResult } {
  if (!Array.isArray(raw) || !raw.length) return { error: fail("INVALID_ARGS", "items are required") };
  const items: AgentOrderLineInput[] = [];
  for (const row of raw) {
    const variantId = str(row?.variantId) || undefined;
    const bundleId = str(row?.bundleId) || undefined;
    const quantity = Math.floor(Number(row?.quantity));
    if (Boolean(variantId) === Boolean(bundleId)) {
      return { error: fail("INVALID_ARGS", "Each item must have either variantId or bundleId") };
    }
    if (!Number.isFinite(quantity) || quantity < 1) {
      return { error: fail("INVALID_ARGS", "Each item quantity must be at least 1") };
    }
    items.push({ variantId, bundleId, quantity });
  }
  return { items };
}

function draftLines(draft: AgentOrderDraft) {
  return draft.lines
    .map((l) => `• ${l.name}${formatAttributes(l.attributes)} × ${l.quantity}`)
    .join("\n");
}

function formatAttributes(attrs: Record<string, string> | undefined) {
  const parts = Object.entries(attrs ?? {})
    .filter(([, v]) => v)
    .map(([, v]) => v);
  return parts.length ? ` (${parts.join(" / ")})` : "";
}

function renderOrderSummary(
  draft: AgentOrderDraft,
  data: { customerName: string; address: string; city?: string; area?: string; landmark?: string; customerNotes?: string },
  en: boolean,
  extras: { shippingCost: number; discount: number },
): string {
  const lines = draft.lines.map((l) => `• ${l.name}${formatAttributes(l.attributes)} × ${l.quantity} — ${roundMoney(l.unitPrice * l.quantity)}`);
  const place = [data.address, data.area, data.city].filter(Boolean).join("، ");
  const shippingLine = extras.shippingCost > 0
    ? (en ? `Shipping: ${roundMoney(extras.shippingCost)}` : `الشحن: ${roundMoney(extras.shippingCost)}`)
    : (en ? "Shipping fee will be confirmed by the store" : "مصاريف الشحن هيتم تأكيدها من المتجر");
  const discountLine = extras.discount > 0
    ? (en ? `Discount: ${roundMoney(extras.discount)}` : `الخصم: ${roundMoney(extras.discount)}`)
    : null;
  const payable = roundMoney(draft.productsTotal + extras.shippingCost - extras.discount);
  const totalLine = extras.shippingCost > 0 || extras.discount > 0
    ? (en ? `Total: ${payable} (cash on delivery)` : `الإجمالي: ${payable} (الدفع عند الاستلام)`)
    : (en ? "Payment: cash on delivery" : "الدفع عند الاستلام");
  const body = en
    ? [
      "Please confirm your order:",
      ...lines,
      `Products total: ${draft.productsTotal}`,
      shippingLine,
      discountLine,
      totalLine,
      "",
      `Name: ${data.customerName}`,
      `Address: ${place}`,
      data.landmark && `Landmark: ${data.landmark}`,
      data.customerNotes && `Notes: ${data.customerNotes}`,
    ]
    : [
      "من فضلك أكد الطلب:",
      ...lines,
      `إجمالي المنتجات: ${draft.productsTotal}`,
      shippingLine,
      discountLine,
      totalLine,
      "",
      `الاسم: ${data.customerName}`,
      `العنوان: ${place}`,
      data.landmark && `علامة مميزة: ${data.landmark}`,
      data.customerNotes && `ملاحظات: ${data.customerNotes}`,
    ];
  return body.filter((l) => typeof l === "string").join("\n");
}

function roundMoney(n: number) {
  return Math.round(n * 100) / 100;
}

function renderCampaignSummary(
  offer: Awaited<ReturnType<AgentCampaignOffersService["describe"]>>,
  data: { customerName: string; address: string; city?: string; area?: string; landmark?: string; customerNotes?: string },
  en: boolean,
): string {
  const currency = offer.currency ?? "";
  const products = (offer.products ?? [])
    .map((p) => `• ${p.name} × ${p.quantity} — ${p.price * p.quantity} ${currency}`)
    .join("\n");
  const place = [data.address, data.area, data.city].filter(Boolean).join("، ");
  const lines = en
    ? [
      "Please confirm your order:",
      products,
      `Shipping: ${offer.shipping ?? 0} ${currency}`,
      `Total: ${offer.total ?? 0} ${currency} (cash on delivery)`,
      "",
      `Name: ${data.customerName}`,
      `Address: ${place}`,
      data.landmark && `Landmark: ${data.landmark}`,
      data.customerNotes && `Notes: ${data.customerNotes}`,
    ]
    : [
      "من فضلك أكد الطلب:",
      products,
      `الشحن: ${offer.shipping ?? 0} ${currency}`,
      `الإجمالي: ${offer.total ?? 0} ${currency} (الدفع عند الاستلام)`,
      "",
      `الاسم: ${data.customerName}`,
      `العنوان: ${place}`,
      data.landmark && `علامة مميزة: ${data.landmark}`,
      data.customerNotes && `ملاحظات: ${data.customerNotes}`,
    ];
  return lines.filter((l) => typeof l === "string").join("\n");
}
