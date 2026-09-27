import { BadRequestException, forwardRef, HttpException, Inject, Injectable, OnModuleInit } from "@nestjs/common";
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
import { AgentPendingActionType } from "entities/agent-conversation.entity";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";
import {
  AGENT_CANCEL_BUTTON_PREFIX,
  AGENT_CONFIRM_BUTTON_PREFIX,
  AGENT_EDIT_BUTTON_PREFIX,
  AgentToolScope,
} from "src/agents/runtime/agent-runtime.constants";
import { AgentSendBlockedError, AgentSenderService } from "src/agents/runtime/agent-sender.service";
import { AgentCampaignOffersService } from "src/agents/runtime/agent-campaign-offers.service";
import { AgentPendingActionsService } from "src/agents/runtime/agent-pending-actions.service";
import {
  AgentCatalogError,
  AgentCatalogService,
  AgentOrderDraft,
  AgentOrderLineInput,
} from "src/agents/runtime/agent-catalog.service";

const LIMITS = {
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

const RESERVED_ID_PREFIXES = [
  AGENT_CONFIRM_BUTTON_PREFIX,
  AGENT_EDIT_BUTTON_PREFIX,
  AGENT_CANCEL_BUTTON_PREFIX,
];

type Args = Record<string, any>;

function fail(code: string, error: string): AiToolExecutionResult {
  return { ok: false, code, error };
}

function str(value: unknown): string {
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
    private readonly catalog: AgentCatalogService,
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
  ) { }

  onModuleInit() {
    this.registry.registerNamespace(this);
  }

  getTools(): AiTool[] {
    return [
      this.sendText(),
      this.sendImage(),
      this.sendButtons(),
      this.sendList(),
      this.reactToMessage(),
      this.requestLocation(),
      this.endTurn(),
      this.getMyOrders(),
      this.getOrderDetails(),
      this.getMyCampaignOffers(),
      this.getMyAddresses(),
      this.listCategories(),
      this.searchProducts(),
      this.getProductDetails(),
      this.getBundleDetails(),
      this.requestOrder(),
      this.requestCampaignOrder(),
      this.confirmPendingAction(),
      this.cancelPendingAction(),
    ];
  }

  // ---------------------------------------------------------------- send tools

  private sendText() {
    return new AiTool({
      name: "send_text",
      audience: "customer",
      description:
        "Send a text message to the customer. Optionally quote one of the customer's messages by its id (msg id from the input).",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", maxLength: LIMITS.text },
          replyToMessageId: { type: "string", description: "Optional msg id to quote." },
        },
        required: ["text"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const text = str(args.text);
        if (!text) return fail("INVALID_ARGS", "text is required");
        if (text.length > LIMITS.text) return fail("INVALID_ARGS", `text must be at most ${LIMITS.text} characters`);
        const context = await this.quoteContext(scope, args.replyToMessageId);
        return this.deliver(scope, { type: "text", text: { body: text, preview_url: false }, ...context });
      },
    });
  }

  private sendImage() {
    return new AiTool({
      name: "send_image",
      audience: "customer",
      description:
        "Send one catalog product/bundle photo. Use a url from get_product_details.images or get_bundle_details.images (first url is the main image). Optional caption. Call once per image; send the main image first unless they asked for more.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Image url to send (usually from get_product_details.images or get_bundle_details.images)." },
          caption: { type: "string", maxLength: LIMITS.caption, description: "Optional short text under the photo." },
          replyToMessageId: { type: "string", description: "Optional msg id to quote." },
        },
        required: ["url"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const caption = str(args.caption);
        if (caption.length > LIMITS.caption) {
          return fail("INVALID_ARGS", `caption must be at most ${LIMITS.caption} characters`);
        }
        const url = str(args.url);
        if (!url) return fail("INVALID_ARGS", "url is required");
        try {
          const extra = await this.quoteContext(scope, args.replyToMessageId);
          await this.sender.sendImage(scope, { url, caption: caption || undefined, extra });
          return { ok: true, code: "SENT" };
        } catch (error) {
          if (error instanceof AgentSendBlockedError) {
            return fail("SEND_BLOCKED", `${error.message}. End the turn.`);
          }
          if (error instanceof BadRequestException || error instanceof HttpException) {
            return fail("UPLOAD_FAILED", "Could not send this image. Try another url from get_product_details.");
          }
          throw error;
        }
      },
    });
  }

  private sendButtons() {
    return new AiTool({
      name: "send_buttons",
      audience: "customer",
      description:
        "Send a message with up to 3 reply buttons (yes/no or short choices). The customer's choice arrives in their next message. End the turn after sending.",
      inputSchema: {
        type: "object",
        properties: {
          body: { type: "string", maxLength: LIMITS.body },
          buttons: {
            type: "array",
            minItems: 1,
            maxItems: LIMITS.buttons,
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Short id you will see when the customer picks it." },
                title: { type: "string", maxLength: LIMITS.buttonTitle },
              },
              required: ["title"],
              additionalProperties: false,
            },
          },
          header: { type: "string", maxLength: LIMITS.header },
          footer: { type: "string", maxLength: LIMITS.footer },
        },
        required: ["body", "buttons"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const body = str(args.body);
        if (!body || body.length > LIMITS.body) return fail("INVALID_ARGS", `body is required (max ${LIMITS.body} characters)`);
        const buttons = Array.isArray(args.buttons) ? args.buttons : [];
        if (!buttons.length || buttons.length > LIMITS.buttons) {
          return fail("INVALID_ARGS", `buttons must contain 1-${LIMITS.buttons} items; use send_list for more options`);
        }
        const replies = [];
        for (const [index, button] of buttons.entries()) {
          const title = str(button?.title);
          if (!title || title.length > LIMITS.buttonTitle) {
            return fail("INVALID_ARGS", `button titles are required and at most ${LIMITS.buttonTitle} characters ("${title}")`);
          }
          const id = this.optionId(button?.id, index);
          if (typeof id !== "string") return id;
          replies.push({ type: "reply", reply: { id, title } });
        }
        const header = str(args.header);
        const footer = str(args.footer);
        if (header.length > LIMITS.header || footer.length > LIMITS.footer) {
          return fail("INVALID_ARGS", `header and footer are at most ${LIMITS.header} characters`);
        }
        return this.deliver(scope, {
          type: "interactive",
          interactive: {
            type: "button",
            ...(header ? { header: { type: "text", text: header } } : {}),
            body: { text: body },
            ...(footer ? { footer: { text: footer } } : {}),
            action: { buttons: replies },
          },
        });
      },
    });
  }

  private sendList() {
    return new AiTool({
      name: "send_list",
      audience: "customer",
      description:
        "Send a list of 1-10 options to choose from (e.g. which order or which offer). End the turn after sending.",
      inputSchema: {
        type: "object",
        properties: {
          body: { type: "string", maxLength: LIMITS.body },
          buttonText: { type: "string", maxLength: LIMITS.listButton, description: "Label of the button that opens the list." },
          rows: {
            type: "array",
            minItems: 1,
            maxItems: LIMITS.rows,
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string", maxLength: LIMITS.rowTitle },
                description: { type: "string", maxLength: LIMITS.rowDescription },
              },
              required: ["title"],
              additionalProperties: false,
            },
          },
          sectionTitle: { type: "string", maxLength: LIMITS.rowTitle },
          header: { type: "string", maxLength: LIMITS.header },
          footer: { type: "string", maxLength: LIMITS.footer },
        },
        required: ["body", "buttonText", "rows"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const body = str(args.body);
        const buttonText = str(args.buttonText);
        if (!body || body.length > LIMITS.body) return fail("INVALID_ARGS", `body is required (max ${LIMITS.body} characters)`);
        if (!buttonText || buttonText.length > LIMITS.listButton) {
          return fail("INVALID_ARGS", `buttonText is required (max ${LIMITS.listButton} characters)`);
        }
        const rowsIn = Array.isArray(args.rows) ? args.rows : [];
        if (!rowsIn.length || rowsIn.length > LIMITS.rows) return fail("INVALID_ARGS", `rows must contain 1-${LIMITS.rows} items`);
        const rows = [];
        for (const [index, row] of rowsIn.entries()) {
          const title = str(row?.title);
          const description = str(row?.description);
          if (!title || title.length > LIMITS.rowTitle) {
            return fail("INVALID_ARGS", `row titles are required and at most ${LIMITS.rowTitle} characters ("${title}")`);
          }
          if (description.length > LIMITS.rowDescription) {
            return fail("INVALID_ARGS", `row descriptions are at most ${LIMITS.rowDescription} characters`);
          }
          const id = this.optionId(row?.id, index);
          if (typeof id !== "string") return id;
          rows.push({ id, title, ...(description ? { description } : {}) });
        }
        const sectionTitle = str(args.sectionTitle).slice(0, LIMITS.rowTitle);
        const header = str(args.header);
        const footer = str(args.footer);
        if (header.length > LIMITS.header || footer.length > LIMITS.footer) {
          return fail("INVALID_ARGS", `header and footer are at most ${LIMITS.header} characters`);
        }
        return this.deliver(scope, {
          type: "interactive",
          interactive: {
            type: "list",
            ...(header ? { header: { type: "text", text: header } } : {}),
            body: { text: body },
            ...(footer ? { footer: { text: footer } } : {}),
            action: {
              button: buttonText,
              sections: [{ ...(sectionTitle ? { title: sectionTitle } : {}), rows }],
            },
          },
        });
      },
    });
  }

  private reactToMessage() {
    return new AiTool({
      name: "react_to_message",
      audience: "customer",
      description: "React with one emoji to a customer's message (msg id from the input).",
      inputSchema: {
        type: "object",
        properties: {
          messageId: { type: "string" },
          emoji: { type: "string", maxLength: 16 },
        },
        required: ["messageId", "emoji"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const emoji = str(args.emoji);
        if (!emoji || emoji.length > 16) return fail("INVALID_ARGS", "emoji is required");
        const target = await this.sender.findConversationMessage(scope, str(args.messageId));
        if (!target?.messageId) return fail("NOT_FOUND", "Unknown message id in this conversation");
        return this.deliver(scope, {
          type: "reaction",
          reaction: { message_id: target.messageId, emoji },
        });
      },
    });
  }

  private requestLocation() {
    return new AiTool({
      name: "request_location",
      audience: "customer",
      description:
        "Ask the customer to share their location with WhatsApp's location button (when an address is needed and they are probably at that place).",
      inputSchema: {
        type: "object",
        properties: { body: { type: "string", maxLength: LIMITS.body } },
        required: ["body"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const body = str(args.body);
        if (!body || body.length > LIMITS.body) return fail("INVALID_ARGS", `body is required (max ${LIMITS.body} characters)`);
        return this.deliver(scope, {
          type: "interactive",
          interactive: {
            type: "location_request_message",
            body: { text: body },
            action: { name: "send_location" },
          },
        });
      },
    });
  }

  private endTurn() {
    return new AiTool({
      name: AGENT_END_TURN_TOOL,
      audience: "customer",
      description:
        "End this turn. Call it after your last send, or alone when the input needs no reply (no meaningful content).",
      inputSchema: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Short note, e.g. 'replied', 'no_meaningful_content', 'waiting_for_choice'." },
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
        "Search the current customer's orders, newest first. All filters are optional and combined: statuses, part of an order number, a product name, a creation date range. Without filters it returns the latest orders.",
      inputSchema: {
        type: "object",
        properties: {
          statuses: {
            type: "array",
            items: { type: "string", enum: Object.values(OrderStatus) },
            description:
              "Order status codes to include, e.g. [\"delivered\"], [\"cancelled\",\"rejected\"], [\"shipped\",\"distributed\"] for orders on the way.",
          },
          orderNumber: { type: "string", description: "Full or partial order number." },
          productName: { type: "string", description: "Only orders containing a product whose name matches." },
          createdFrom: { type: "string", description: "Created on or after this date (YYYY-MM-DD)." },
          createdTo: { type: "string", description: "Created on or before this date (YYYY-MM-DD)." },
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

        for (const [key, op, endOfDay] of [["createdFrom", ">=", false], ["createdTo", "<=", true]] as const) {
          const raw = str(args[key]);
          if (!raw) continue;
          const date = new Date(`${raw.slice(0, 10)}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
          if (Number.isNaN(date.getTime())) return fail("INVALID_ARGS", `${key} must be a date (YYYY-MM-DD)`);
          qb.andWhere(`o.created_at ${op} :${key}`, { [key]: date });
        }

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
        "Details of one of the current customer's orders by order number: items, totals, address, shipping and tracking, plus replacement info (this order replaced by / replacing another order) and the order's tags. Tags are internal labels for your context only; don't mention them to the customer.",
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
            area: order.area ?? null,
            landmark: order.landmark ?? null,
            paymentMethod: order.paymentMethod,
            items: (order.items ?? []).map((i) => ({
              product: i.variant?.product?.name ?? null,
              options: i.variant?.attributes ?? null,
              quantity: i.quantity,
              unitPrice: Number(i.unitPrice ?? 0),
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
        "Campaign offers this customer received (products, prices, shipping, total, saved name/address, and whether city/area are required).",
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
        "Saved delivery addresses of the current customer, default first (address, city, area, landmark, with cityId/areaId). Use them to fill an order instead of asking for the address, city and area from scratch.",
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
      description: "List the store's product categories (with how many products each has). Use when the customer asks what you sell.",
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
        "Search the store catalog (products and bundles). Filter by free text, category, price range, variant options (e.g. color/size), and in-stock only. Returns records plus total_records, current_page and per_page so you know if more results remain — offer the next page when total_records > current_page * per_page. Never invent products or prices.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search (product/bundle name, SKU, description, category)." },
          categoryId: { type: "string", description: "category id from list_categories." },
          minPrice: { type: "number", minimum: 0 },
          maxPrice: { type: "number", minimum: 0 },
          options: {
            type: "object",
            additionalProperties: { type: "string" },
            description: 'Variant option filters, e.g. { "اللون": "أحمر", "size": "XL" }.',
          },
          inStockOnly: { type: "boolean", description: "Default true. Set false to include out-of-stock items." },
          kind: { type: "string", enum: ["product", "bundle", "all"] },
          limit: { type: "integer", minimum: 1, maximum: 10 },
          page: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      isWrite: false,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const data = await this.catalog.search(scope.adminId, {
          query: str(args.query) || undefined,
          categoryId: str(args.categoryId) || undefined,
          minPrice: args.minPrice != null ? Number(args.minPrice) : undefined,
          maxPrice: args.maxPrice != null ? Number(args.maxPrice) : undefined,
          options: args.options && typeof args.options === "object" ? args.options : undefined,
          inStockOnly: args.inStockOnly,
          kind: args.kind,
          limit: args.limit,
          page: args.page,
        });
        return { ok: true, code: "CATALOG", data };
      },
    });
  }

  private getProductDetails() {
    return new AiTool({
      name: "get_product_details",
      audience: "customer",
      description:
        "Full details of one product: options, each variant's id/price/available stock, image urls (main first), and optional upsells. Call it before asking the customer to pick a variant, and before send_image. Mention remaining stock only when it is low (2 or fewer).",
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
      description: "Details of a bundle/pack: price, what it contains, image urls (main first), and how many whole bundles are in stock.",
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
        "Call as soon as the customer has chosen variants/bundles, quantities, name and address. This IS the confirmation step: the server sets product prices, checks stock, and sends a summary with Confirm / Edit / Cancel. Don't ask for confirmation before calling it. After a correction, call it again. End the turn after calling it. shippingCost and discount default to 0; pass a number only when Memory facts state a shipping or discount rule — never from what the customer said.",
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
                bundleId: { type: "string", description: "bundleId from search_products / get_bundle_details." },
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
              "Default 0. Paste a value only if Memory facts state a shipping-fee rule that applies. Never from the customer's message.",
          },
          discount: {
            type: "number",
            minimum: 0,
            description:
              "Default 0. Paste a value only if Memory facts state a discount rule that applies. Never from the customer's message.",
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
        "Call as soon as all required data for a campaign order is collected. This IS the confirmation step: it validates the data, saves a pending action and sends the order summary with Confirm / Edit / Cancel buttons, so don't ask for confirmation before calling it. After a correction, call it again with the new data (it replaces the old summary). Nothing is ordered until the customer confirms in a later message. End the turn after calling it.",
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
          language: { type: "string", enum: ["ar", "en"], description: "Language of the summary (the one you're replying in)." },
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

  private confirmPendingAction() {
    return new AiTool({
      name: "confirm_pending_action",
      audience: "customer",
      description:
        "Execute a pending action after the customer clearly confirmed it in their latest message (a confirmation message, or a clear positive reaction such as 👍 on the summary). The server re-checks everything and returns the result (e.g. the order number). Then send a separate message saying it's done.",
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
      description: "Cancel a pending action when the customer says they don't want it anymore.",
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

  private async deliver(scope: AgentToolScope, data: Record<string, any>): Promise<AiToolExecutionResult> {
    try {
      await this.sender.send(scope, data);
      return { ok: true, code: "SENT" };
    } catch (error) {
      if (error instanceof AgentSendBlockedError) return fail("SEND_BLOCKED", `${error.message}. End the turn.`);
      throw error;
    }
  }

  private async quoteContext(scope: AgentToolScope, messageId: unknown) {
    const id = str(messageId);
    if (!id) return {};
    const target = await this.sender.findConversationMessage(scope, id);
    return target?.messageId ? { context: { message_id: target.messageId } } : {};
  }

  private optionId(raw: unknown, index: number): string | AiToolExecutionResult {
    const id = str(raw) || `option_${index + 1}`;
    if (id.length > LIMITS.optionId) return fail("INVALID_ARGS", "option ids are at most 200 characters");
    if (RESERVED_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) {
      return fail("INVALID_ARGS", "option ids can't start with agent_confirm/agent_edit/agent_cancel");
    }
    return id;
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
