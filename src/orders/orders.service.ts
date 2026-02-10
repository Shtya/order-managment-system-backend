// orders/orders.service.ts
import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository, In, EntityManager } from "typeorm";
import {
  OrderEntity,
  OrderItemEntity,
  OrderStatusHistoryEntity,
  OrderMessageEntity,
  OrderStatus,
  PaymentStatus,
} from "entities/order.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import {
  CreateOrderDto,
  UpdateOrderDto,
  ChangeOrderStatusDto,
  UpdatePaymentStatusDto,
  AddOrderMessageDto,
  MarkMessagesReadDto,
} from "dto/order.dto";

export function tenantId(me: any): any | null {
  if (!me) return null;
  const roleName = me.role?.name;
  if (roleName === "super_admin") return null;
  if (roleName === "admin") return me.id;
  return me.adminId;
}

@Injectable()
export class OrdersService {
  constructor(
    private dataSource: DataSource,

    @InjectRepository(OrderEntity)
    private orderRepo: Repository<OrderEntity>,

    @InjectRepository(OrderItemEntity)
    private itemRepo: Repository<OrderItemEntity>,

    @InjectRepository(OrderStatusHistoryEntity)
    private historyRepo: Repository<OrderStatusHistoryEntity>,

    @InjectRepository(OrderMessageEntity)
    private messageRepo: Repository<OrderMessageEntity>,

    @InjectRepository(ProductVariantEntity)
    private variantRepo: Repository<ProductVariantEntity>
  ) { }

  // ✅ Generate unique order number
  private async generateOrderNumber(adminId: string): Promise<string> {
    const date = new Date();
    const dateStr = date.toISOString().split("T")[0].replace(/-/g, "");
    const prefix = `ORD-${dateStr}`;

    const lastOrder = await this.orderRepo
      .createQueryBuilder("o")
      .where("o.adminId = :adminId", { adminId })
      .andWhere("o.orderNumber LIKE :prefix", { prefix: `${prefix}%` })
      .orderBy("o.id", "DESC")
      .getOne();

    let sequence = 1;
    if (lastOrder) {
      const lastNum = lastOrder.orderNumber.split("-").pop();
      sequence = parseInt(lastNum || "0") + 1;
    }

    return `${prefix}-${String(sequence).padStart(3, "0")}`;
  }

  // ✅ Calculate totals
  private calculateTotals(items: any[], shippingCost = 0, discount = 0) {
    const productsTotal = items.reduce((sum, item) => {
      return sum + item.unitPrice * item.quantity;
    }, 0);

    const finalTotal = productsTotal + shippingCost - discount;

    const profit = items.reduce((sum, item) => {
      return sum + (item.unitPrice - item.unitCost) * item.quantity;
    }, 0);

    return { productsTotal, finalTotal, profit };
  }

  // ✅ Log status change
  private async logStatusChange(params: {
    adminId: string;
    orderId: number;
    fromStatus: OrderStatus;
    toStatus: OrderStatus;
    userId?: number;
    notes?: string;
    ipAddress?: string,
    manager?: EntityManager
  }) {

    const historyRepo = params.manager.getRepository(OrderStatusHistoryEntity)
    const log = historyRepo.create({
      adminId: params.adminId,
      orderId: params.orderId,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      changedByUserId: params.userId || null,
      notes: params.notes || null,
      ipAddress: params.ipAddress || null,
    } as any);

    await params.manager.save(log);
  }

  // ========================================
  // ✅ STATS
  // ========================================
  async getStats(me: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const [
      newCount,
      underReviewCount,
      preparingCount,
      readyCount,
      shippedCount,
      deliveredCount,
      cancelledCount,
      returnedCount,
    ] = await Promise.all([
      this.orderRepo.count({ where: { adminId, status: OrderStatus.NEW } as any }),
      this.orderRepo.count({ where: { adminId, status: OrderStatus.UNDER_REVIEW } as any }),
      this.orderRepo.count({ where: { adminId, status: OrderStatus.PREPARING } as any }),
      this.orderRepo.count({ where: { adminId, status: OrderStatus.READY } as any }),
      this.orderRepo.count({ where: { adminId, status: OrderStatus.SHIPPED } as any }),
      this.orderRepo.count({ where: { adminId, status: OrderStatus.DELIVERED } as any }),
      this.orderRepo.count({ where: { adminId, status: OrderStatus.CANCELLED } as any }),
      this.orderRepo.count({ where: { adminId, status: OrderStatus.RETURNED } as any }),
    ]);

    return {
      new: newCount,
      underReview: underReviewCount,
      preparing: preparingCount,
      ready: readyCount,
      shipped: shippedCount,
      delivered: deliveredCount,
      cancelled: cancelledCount,
      returned: returnedCount,
    };
  }

  // ========================================
  // ✅ LIST ORDERS
  // ========================================
  async list(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? "").trim();

    const qb = this.orderRepo
      .createQueryBuilder("order")
      .where("order.adminId = :adminId", { adminId })
      .leftJoinAndSelect("order.items", "items")
      .leftJoinAndSelect("items.variant", "variant")
      .leftJoinAndSelect("variant.product", "product");

    // Filters
    if (q?.status) qb.andWhere("order.status = :status", { status: q.status });
    if (q?.paymentStatus) qb.andWhere("order.paymentStatus = :paymentStatus", { paymentStatus: q.paymentStatus });
    if (q?.paymentMethod) qb.andWhere("order.paymentMethod = :paymentMethod", { paymentMethod: q.paymentMethod });
    if (q?.shippingCompany) qb.andWhere("order.shippingCompany = :shippingCompany", { shippingCompany: q.shippingCompany });

    // Date range
    if (q?.startDate) qb.andWhere("order.created_at >= :startDate", { startDate: `${q.startDate}T00:00:00.000Z` });
    if (q?.endDate) qb.andWhere("order.created_at <= :endDate", { endDate: `${q.endDate}T23:59:59.999Z` });

    // Search
    if (search) {
      qb.andWhere(
        "(order.orderNumber ILIKE :s OR order.customerName ILIKE :s OR order.phoneNumber ILIKE :s)",
        { s: `%${search}%` }
      );
    }

    qb.orderBy("order.created_at", "DESC");

    const total = await qb.getCount();
    const records = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  // ========================================
  // ✅ GET ORDER BY ID
  // ========================================
  async get(me: any, id: number) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const order = await this.orderRepo.findOne({
      where: { id, adminId } as any,
      relations: ["items", "items.variant", "items.variant.product", "statusHistory"],
    });

    if (!order) throw new BadRequestException("Order not found");
    return order;
  }

  // ========================================
  // ✅ CREATE ORDER
  // ========================================
  async create(me: any, dto: CreateOrderDto, ipAddress?: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    return this.dataSource.transaction(async (manager) => {
      // Generate order number
      const orderNumber = await this.generateOrderNumber(adminId);

      // Get variants
      const variantIds = dto.items.map((it) => it.variantId);
      const variants = await manager.find(ProductVariantEntity, {
        where: { adminId, id: In(variantIds) } as any,
      });

      const variantMap = new Map(variants.map((v) => [v.id, v]));

      // Check stock availability
      for (const item of dto.items) {
        const variant = variantMap.get(item.variantId);
        if (!variant) throw new BadRequestException(`Variant ${item.variantId} not found`);

        const available = (variant.stockOnHand || 0) - (variant.reserved || 0);
        if (available < item.quantity) {
          throw new BadRequestException(
            `Insufficient stock for variant ${variant.sku}. Available: ${available}, Requested: ${item.quantity}`
          );
        }
      }

      // Create order items
      const items = dto.items.map((it) => {
        const variant = variantMap.get(it.variantId)!;
        const unitPrice = it.unitPrice;
        const unitCost = it.unitCost ?? variant.price ?? 0;
        const lineTotal = unitPrice * it.quantity;
        const lineProfit = (unitPrice - unitCost) * it.quantity;

        return manager.create(OrderItemEntity, {
          adminId,
          variantId: it.variantId,
          quantity: it.quantity,
          unitPrice,
          unitCost,
          lineTotal,
          lineProfit,
        } as any);
      });

      // Calculate totals
      const { productsTotal, finalTotal, profit } = this.calculateTotals(
        dto.items.map((it, i) => ({
          unitPrice: it.unitPrice,
          unitCost: it.unitCost ?? variantMap.get(it.variantId)!.price ?? 0,
          quantity: it.quantity,
        })),
        dto.shippingCost ?? 0,
        dto.discount ?? 0
      );

      // Create order
      const order = manager.create(OrderEntity, {
        adminId,
        orderNumber,
        customerName: dto.customerName,
        phoneNumber: dto.phoneNumber,
        email: dto.email,
        address: dto.address,
        city: dto.city,
        area: dto.area,
        paymentMethod: dto.paymentMethod,
        paymentStatus: dto.paymentStatus ?? PaymentStatus.PENDING,
        shippingCompany: dto.shippingCompany,
        shippingCost: dto.shippingCost ?? 0,
        discount: dto.discount ?? 0,
        productsTotal,
        finalTotal,
        profit,
        notes: dto.notes,
        customerNotes: dto.customerNotes,
        status: OrderStatus.NEW,
        items,
        createdByUserId: me?.id,
      } as any);

      const saved = await manager.save(OrderEntity, order);

      // Reserve stock
      for (const item of dto.items) {
        const variant = variantMap.get(item.variantId)!;
        variant.reserved = (variant.reserved || 0) + item.quantity;
        await manager.save(ProductVariantEntity, variant);
      }

      // Log initial status
      await this.logStatusChange({
        adminId,
        orderId: saved.id,
        fromStatus: OrderStatus.NEW,
        toStatus: OrderStatus.NEW,
        userId: me?.id,
        notes: "Order created",
        ipAddress,
        manager
      });

      return saved;
    });
  }

  // ========================================
  // ✅ UPDATE ORDER
  // ========================================
  async update(me: any, id: number, dto: UpdateOrderDto, ipAddress?: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const order = await this.get(me, id);

    // Don't allow updates if shipped/delivered
    if ([OrderStatus.SHIPPED, OrderStatus.DELIVERED].includes(order.status)) {
      throw new BadRequestException("Cannot update shipped or delivered orders");
    }

    // Update basic fields
    Object.assign(order, {
      customerName: dto.customerName ?? order.customerName,
      phoneNumber: dto.phoneNumber ?? order.phoneNumber,
      email: dto.email ?? order.email,
      address: dto.address ?? order.address,
      city: dto.city ?? order.city,
      area: dto.area ?? order.area,
      paymentMethod: dto.paymentMethod ?? order.paymentMethod,
      shippingCompany: dto.shippingCompany ?? order.shippingCompany,
      shippingCost: dto.shippingCost ?? order.shippingCost,
      discount: dto.discount ?? order.discount,
      notes: dto.notes ?? order.notes,
      customerNotes: dto.customerNotes ?? order.customerNotes,
      trackingNumber: dto.trackingNumber ?? order.trackingNumber,
      updatedByUserId: me?.id,
    });

    // Recalculate if needed
    if (dto.shippingCost !== undefined || dto.discount !== undefined) {
      const { productsTotal, finalTotal, profit } = this.calculateTotals(
        order.items.map((it: any) => ({
          unitPrice: it.unitPrice,
          unitCost: it.unitCost,
          quantity: it.quantity,
        })),
        order.shippingCost,
        order.discount
      );
      order.productsTotal = productsTotal;
      order.finalTotal = finalTotal;
      order.profit = profit;
    }

    return this.orderRepo.save(order);
  }

  // ========================================
  // ✅ CHANGE ORDER STATUS
  // ========================================
  async changeStatus(me: any, id: number, dto: ChangeOrderStatusDto, ipAddress?: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(OrderEntity, {
        where: { id, adminId } as any,
        relations: ["items", "items.variant"],
      });

      if (!order) throw new BadRequestException("Order not found");

      const oldStatus = order.status;
      const newStatus = dto.status;

      if (oldStatus === newStatus) return order;

      // Status transition validation
      const validTransitions: Record<OrderStatus, OrderStatus[]> = {
        [OrderStatus.NEW]: [OrderStatus.UNDER_REVIEW, OrderStatus.CANCELLED],
        [OrderStatus.UNDER_REVIEW]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
        [OrderStatus.PREPARING]: [OrderStatus.READY, OrderStatus.CANCELLED],
        [OrderStatus.READY]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
        [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.RETURNED],
        [OrderStatus.DELIVERED]: [OrderStatus.RETURNED],
        [OrderStatus.CANCELLED]: [],
        [OrderStatus.RETURNED]: [],
      };

      if (!validTransitions[oldStatus]?.includes(newStatus)) {
        throw new BadRequestException(`Cannot transition from ${oldStatus} to ${newStatus}`);
      }

      // Handle stock changes
      if (newStatus === OrderStatus.CANCELLED || newStatus === OrderStatus.RETURNED) {
        // Release reserved stock
        for (const item of order.items) {
          const variant = item.variant;
          variant.reserved = Math.max(0, (variant.reserved || 0) - item.quantity);
          await manager.save(ProductVariantEntity, variant);
        }
      }

      if (newStatus === OrderStatus.SHIPPED && !order.shippedAt) {
        order.shippedAt = new Date();
      }

      if (newStatus === OrderStatus.DELIVERED && !order.deliveredAt) {
        order.deliveredAt = new Date();
        // Deduct from stock & release reserved
        for (const item of order.items) {
          const variant = item.variant;
          variant.stockOnHand = Math.max(0, (variant.stockOnHand || 0) - item.quantity);
          variant.reserved = Math.max(0, (variant.reserved || 0) - item.quantity);
          await manager.save(ProductVariantEntity, variant);
        }
      }

      order.status = newStatus;
      order.updatedByUserId = me?.id;
      const saved = await manager.save(OrderEntity, order);

      // Log status change
      await this.logStatusChange({
        adminId,
        orderId: saved.id,
        fromStatus: oldStatus,
        toStatus: newStatus,
        userId: me?.id,
        notes: dto.notes,
        ipAddress,
        manager
      });

      return saved;
    });
  }

  // ========================================
  // ✅ UPDATE PAYMENT STATUS
  // ========================================
  async updatePaymentStatus(me: any, id: number, dto: UpdatePaymentStatusDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const order = await this.get(me, id);
    order.paymentStatus = dto.paymentStatus;
    order.updatedByUserId = me?.id;

    return this.orderRepo.save(order);
  }

  // ========================================
  // ✅ ORDER MESSAGES/CHAT
  // ========================================
  async getMessages(me: any, orderId: number) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    await this.get(me, orderId); // validate access

    return this.messageRepo.find({
      where: { adminId, orderId } as any,
      order: { created_at: "ASC" },
    });
  }

  async addMessage(me: any, orderId: number, dto: AddOrderMessageDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    await this.get(me, orderId); // validate access

    const message = this.messageRepo.create({
      adminId,
      orderId,
      senderType: dto.senderType,
      senderUserId: dto.senderType === "admin" ? me?.id : null,
      message: dto.message,
      isRead: false,
    } as any);

    return this.messageRepo.save(message);
  }

  async markMessagesRead(me: any, orderId: number, dto: MarkMessagesReadDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    await this.get(me, orderId); // validate access

    await this.messageRepo.update(
      { adminId, orderId, id: In(dto.messageIds) } as any,
      { isRead: true }
    );

    return { updated: dto.messageIds.length };
  }

  // ========================================
  // ✅ DELETE ORDER
  // ========================================
  async remove(me: any, id: number) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const order = await this.get(me, id);

    // Only allow deleting new/cancelled orders
    if (![OrderStatus.NEW, OrderStatus.CANCELLED].includes(order.status)) {
      throw new BadRequestException("Can only delete new or cancelled orders");
    }

    // Release reserved stock
    for (const item of order.items) {
      const variant = await this.variantRepo.findOne({ where: { id: item.variantId } as any });
      if (variant) {
        variant.reserved = Math.max(0, (variant.reserved || 0) - item.quantity);
        await this.variantRepo.save(variant);
      }
    }

    await this.orderRepo.delete({ id, adminId } as any);
    return { ok: true };
  }

  async findByExternalId(externalId: string): Promise<OrderEntity | null> {
    return this.orderRepo.findOne({ where: { externalId } });
  }

  async updateExternalId(orderId: number, externalId: string) {
    await this.orderRepo.update(orderId, { externalId });
  }
}