import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, Repository, SelectQueryBuilder } from "typeorm";
import { OrderEntity, OrderConfirmationSource, OrderStatus } from "entities/order.entity";
import { AgentPendingActionType } from "entities/agent-conversation.entity";
import { CustomerEntity } from "entities/customers.entity";
import { OrdersService } from "src/orders/services/orders.service";
import { ClientService } from "src/clients/clients.service";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";
import { AgentCatalogError, AgentCatalogService, AgentOrderLineInput } from "./agent-catalog.service";
import { AgentToolScope } from "./agent-runtime.constants";

const WAREHOUSE_BLOCKED = "This order is already with the warehouse or courier and cannot be changed here.";

type PricedLine = { variantId: string; bundleId?: string; quantity: number; unitPrice: number };

@Injectable()
export class AgentCustomerEditsService {
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(CustomerEntity)
    private readonly customerRepo: Repository<CustomerEntity>,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
    @Inject(forwardRef(() => ClientService))
    private readonly clients: ClientService,
    private readonly catalog: AgentCatalogService,
  ) {}

  async execute(scope: AgentToolScope, type: AgentPendingActionType, payload: Record<string, any>) {
    const me = { id: scope.adminId, adminId: scope.adminId };
    switch (type) {
      case AgentPendingActionType.ADD_ORDER_ITEMS:
        return this.applyItems(scope, payload, "add");
      case AgentPendingActionType.REPLACE_ORDER_ITEMS:
        return this.applyItems(scope, payload, "replace");
      case AgentPendingActionType.UPDATE_ORDER_ITEMS:
        return this.applyItems(scope, payload, "set");
      case AgentPendingActionType.UPDATE_ORDER_INFO:
        return this.applyOrderInfo(scope, me, payload);
      case AgentPendingActionType.CANCEL_ORDER:
        return this.applyStatus(scope, me, payload, OrderStatus.CANCELLED);
      case AgentPendingActionType.POSTPONE_ORDER:
        return this.applyStatus(scope, me, payload, OrderStatus.POSTPONED);
      case AgentPendingActionType.CONFIRM_ORDER:
        return this.applyStatus(scope, me, payload, OrderStatus.CONFIRMED);
      case AgentPendingActionType.ADD_CUSTOMER_ADDRESS:
        return this.applyAddAddress(scope, me, payload);
      case AgentPendingActionType.REMOVE_CUSTOMER_ADDRESS:
        return this.applyRemoveAddress(scope, me, payload);
      case AgentPendingActionType.UPDATE_CUSTOMER_ADDRESS:
        return this.applyUpdateAddress(scope, me, payload);
      case AgentPendingActionType.SET_DEFAULT_ADDRESS:
        return this.applySetDefaultAddress(scope, me, payload);
      case AgentPendingActionType.UPDATE_CUSTOMER:
        return this.applyUpdateCustomer(scope, me, payload);
      default:
        throw new Error(`Unknown action type ${type}`);
    }
  }

  async findOwnedOrder(scope: AgentToolScope, orderNumber: string) {
    const qb = this.orderRepo
      .createQueryBuilder("o")
      .leftJoinAndSelect("o.status", "status")
      .leftJoinAndSelect("o.items", "item")
      .leftJoinAndSelect("item.variant", "variant")
      .leftJoinAndSelect("variant.product", "product");
    await this.scopeToCustomer(qb, scope);
    return qb.andWhere("o.orderNumber = :orderNumber", { orderNumber }).getOne();
  }

  assertMutable(order: OrderEntity) {
    const reason = this.warehouseBlocked(order);
    if (reason) throw Object.assign(new Error(reason), { status: 409 });
  }

  warehouseBlocked(order: OrderEntity): string | null {
    const code = order.status?.code;
    if (code && this.orders.isWarehouseStatus(code)) return WAREHOUSE_BLOCKED;
    return null;
  }

  private async applyItems(
    scope: AgentToolScope,
    p: Record<string, any>,
    mode: "add" | "replace" | "set",
  ) {
    const order = await this.requireOrder(scope, p.orderNumber);
    this.assertMutable(order);
    const existing = pricedFromOrder(order);
    let next: PricedLine[];
    if (mode === "set") {
      const draft = await this.draft(scope.adminId, p.requested ?? [], p.priceFingerprint);
      next = pricedFromDraft(draft.lines);
    } else if (mode === "add") {
      const draft = await this.draft(scope.adminId, p.requested ?? [], p.priceFingerprint);
      next = mergeLines(existing, pricedFromDraft(draft.lines));
    } else {
      const remaining = existing.filter((line) => !matchesFrom(line, p.fromVariantId, p.fromBundleId));
      if (remaining.length === existing.length) {
        throw Object.assign(new Error("No matching item on this order to replace."), { status: 404 });
      }
      const draft = await this.draft(scope.adminId, p.requested ?? [], p.priceFingerprint);
      next = mergeLines(remaining, pricedFromDraft(draft.lines));
    }
    if (!next.length) {
      throw Object.assign(new Error("The order must keep at least one item."), { status: 400 });
    }
    await this.orders.update(agentMe(scope), order.id, {
      items: next.map((l) => ({
        variantId: l.variantId,
        bundleId: l.bundleId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
      })),
      removedItems: removedAgainst(existing, next),
    } as any);
    return { orderNumber: order.orderNumber };
  }

  private async applyOrderInfo(scope: AgentToolScope, me: { id: string; adminId: string }, p: Record<string, any>) {
    const order = await this.requireOrder(scope, p.orderNumber);
    this.assertMutable(order);
    await this.orders.update(me, order.id, {
      customerName: p.customerName,
      address: p.address,
      city: p.city,
      cityId: p.cityId,
      area: p.area,
      areaId: p.areaId,
      landmark: p.landmark,
      customerNotes: p.customerNotes,
    } as any);
    return { orderNumber: order.orderNumber };
  }

  private async applyStatus(
    scope: AgentToolScope,
    me: { id: string; adminId: string },
    p: Record<string, any>,
    code: OrderStatus,
  ) {
    const order = await this.requireOrder(scope, p.orderNumber);
    this.assertMutable(order);
    const status = await this.orders.findStatusByCode(code, scope.adminId);
    await this.orders.changeStatus(me, order.id, {
      statusId: status.id,
      postponedDate: p.postponedDate,
      confirmationSource: OrderConfirmationSource.WHATSAPP,
    });
    return { orderNumber: order.orderNumber, status: code };
  }

  private async applyAddAddress(scope: AgentToolScope, me: { id: string; adminId: string }, p: Record<string, any>) {
    const clientId = await this.requireClientId(scope);
    const saved = await this.clients.createAddress(me, clientId, {
      label: p.label,
      address: p.address,
      cityId: p.cityId,
      areaId: p.areaId,
      landmark: p.landmark,
      isDefault: Boolean(p.isDefault),
    });
    return { addressId: saved.id };
  }

  private async applyRemoveAddress(scope: AgentToolScope, me: { id: string; adminId: string }, p: Record<string, any>) {
    const clientId = await this.requireClientId(scope);
    await this.clients.removeAddress(me, clientId, p.addressId);
    return { addressId: p.addressId };
  }

  private async applyUpdateAddress(scope: AgentToolScope, me: { id: string; adminId: string }, p: Record<string, any>) {
    const clientId = await this.requireClientId(scope);
    await this.clients.updateAddress(me, clientId, p.addressId, {
      label: p.label,
      address: p.address,
      cityId: p.cityId,
      areaId: p.areaId,
      landmark: p.landmark,
      isDefault: p.isDefault,
    });
    return { addressId: p.addressId };
  }

  private async applySetDefaultAddress(scope: AgentToolScope, me: { id: string; adminId: string }, p: Record<string, any>) {
    const clientId = await this.requireClientId(scope);
    await this.clients.setDefaultAddress(me, clientId, p.addressId);
    return { addressId: p.addressId };
  }

  private async applyUpdateCustomer(scope: AgentToolScope, me: { id: string; adminId: string }, p: Record<string, any>) {
    if (p.name) {
      const customer = await this.customerRepo.findOne({ where: { id: scope.customerId, adminId: scope.adminId } });
      if (!customer) throw Object.assign(new Error("Customer not found"), { status: 404 });
      customer.name = String(p.name).trim();
      await this.customerRepo.save(customer);
    }
    if (p.email) {
      const clientId = await this.requireClientId(scope);
      await this.clients.update(me, clientId, { email: p.email });
    }
    return { customerId: scope.customerId };
  }

  private async draft(adminId: string, requested: AgentOrderLineInput[], fingerprint?: string) {
    try {
      return await this.catalog.buildOrderDraft(adminId, requested, fingerprint);
    } catch (error) {
      if (error instanceof AgentCatalogError) {
        throw Object.assign(new Error(error.message), { status: 409 });
      }
      throw error;
    }
  }

  private async requireOrder(scope: AgentToolScope, orderNumber: string) {
    const order = await this.findOwnedOrder(scope, String(orderNumber ?? "").trim());
    if (!order) throw Object.assign(new Error("No order with this number for this customer."), { status: 404 });
    return order;
  }

  private async requireClientId(scope: AgentToolScope) {
    const clientId = await this.resolveClientId(scope);
    if (!clientId) {
      throw Object.assign(new Error("This customer has no address book yet."), { status: 404 });
    }
    return clientId;
  }

  async resolveClientId(scope: AgentToolScope): Promise<string | null> {
    const customer = await this.customerRepo.findOne({
      where: { id: scope.customerId, adminId: scope.adminId },
      select: { id: true, clientId: true },
    });
    return (
      customer?.clientId ??
      (await this.clients.findClientIdByPhone(scope.adminId, normalizeEgyptianPhoneNumber(scope.phoneNumber)))
    );
  }

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
}

function agentMe(scope: AgentToolScope) {
  return { id: scope.adminId, adminId: scope.adminId };
}

function lineKey(variantId: string, bundleId?: string | null) {
  return `${variantId}::${bundleId || ""}`;
}

function pricedFromOrder(order: OrderEntity): PricedLine[] {
  const map = new Map<string, PricedLine>();
  for (const item of order.items ?? []) {
    const key = lineKey(item.variantId, item.bundleId);
    const cur = map.get(key);
    const qty = item.quantity || 0;
    if (cur) cur.quantity += qty;
    else {
      map.set(key, {
        variantId: item.variantId,
        bundleId: item.bundleId || undefined,
        quantity: qty,
        unitPrice: Number(item.unitPrice ?? 0),
      });
    }
  }
  return [...map.values()];
}

function pricedFromDraft(lines: Array<{ variantId: string; bundleId?: string; quantity: number; unitPrice: number }>): PricedLine[] {
  const map = new Map<string, PricedLine>();
  for (const line of lines) {
    const key = lineKey(line.variantId, line.bundleId);
    const cur = map.get(key);
    if (cur) cur.quantity += line.quantity;
    else map.set(key, { ...line, bundleId: line.bundleId || undefined });
  }
  return [...map.values()];
}

function mergeLines(base: PricedLine[], extra: PricedLine[]): PricedLine[] {
  const map = new Map(base.map((l) => [lineKey(l.variantId, l.bundleId), { ...l }]));
  for (const line of extra) {
    const key = lineKey(line.variantId, line.bundleId);
    const cur = map.get(key);
    if (cur) cur.quantity += line.quantity;
    else map.set(key, { ...line });
  }
  return [...map.values()];
}

function matchesFrom(line: PricedLine, fromVariantId?: string, fromBundleId?: string) {
  if (fromBundleId) return line.bundleId === fromBundleId;
  if (fromVariantId) return line.variantId === fromVariantId && !line.bundleId;
  return false;
}

function removedAgainst(existing: PricedLine[], next: PricedLine[]) {
  const keep = new Set(next.map((l) => lineKey(l.variantId, l.bundleId)));
  return existing
    .filter((l) => !keep.has(lineKey(l.variantId, l.bundleId)))
    .map((l) => ({ variantId: l.variantId, bundleId: l.bundleId }));
}
