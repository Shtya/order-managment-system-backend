// orders/orders.service.ts
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository, In, EntityManager, Brackets } from "typeorm";
import {
  OrderEntity,
  OrderItemEntity,
  OrderStatusHistoryEntity,
  OrderMessageEntity,
  PaymentStatus,
  OrderStatusEntity,
  OrderStatus,
  slugify,
} from "entities/order.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import {
  CreateOrderDto,
  UpdateOrderDto,
  ChangeOrderStatusDto,
  UpdatePaymentStatusDto,
  AddOrderMessageDto,
  MarkMessagesReadDto,
  UpdateStatusDto,
  CreateStatusDto,
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

    @InjectRepository(OrderStatusEntity)
    private statusRepo: Repository<OrderStatusEntity>,

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
    fromStatusId: number | null; // Changed from Enum to ID
    toStatusId: number;         // Changed from Enum to ID
    userId?: number;
    notes?: string;
    ipAddress?: string;
    manager: EntityManager;      // Removed optional '?' because getRepository needs it
  }) {
    // [2025-12-24] Trim string identifiers for clean history
    const adminId = params.adminId;
    const notes = params.notes?.trim() || null;
    const ipAddress = params.ipAddress?.trim() || null;

    const historyRepo = params.manager.getRepository(OrderStatusHistoryEntity);

    const log = historyRepo.create({
      adminId,
      orderId: params.orderId,
      fromStatusId: params.fromStatusId,
      toStatusId: params.toStatusId,
      changedByUserId: params.userId || null,
      notes,
      ipAddress,
    });

    await params.manager.save(log);
  }

  // ========================================
  // ✅ STATS
  // ========================================
  async getStats(me: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const stats = await this.statusRepo
      .createQueryBuilder('status')
      // use relation path only (no join condition)
      .leftJoin('status.orders', 'o')
      .select([
        'status.id AS id',
        'status.name AS name',
        'status.code AS code',
        'status.color  AS color',
        'status.system AS system',
        'status.sortOrder AS sortOrder'
      ])
      .addSelect('COUNT(o.id)', 'count')
      .where(new Brackets(qb => {
        qb.where('status.adminId = :adminId', { adminId })
          .orWhere('status.system = :system', { system: true });
      }))
      // GROUP BY every non-aggregated selected column (Postgres requires this)
      .groupBy('status.id')
      .addGroupBy('status.name')
      .addGroupBy('status.code')
      .addGroupBy('status.color')
      .addGroupBy('status.system')
      .addGroupBy('status.sortOrder')
      .orderBy('status.sortOrder', 'ASC')
      .getRawMany();

    return stats.map(stat => ({
      ...stat,
      id: Number(stat.id),
      count: Number(stat.count) || 0,
      system: stat.system || stat.system
    }));
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
      relations: ["items", "items.variant", "items.variant.product", "statusHistory", 'status'],
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
      const defaultStatus = await this.getDefaultStatus(adminId)

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
        landmark: dto.landmark,
        deposit: dto.deposit,
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
        status: defaultStatus.id,
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
        fromStatusId: defaultStatus.id,
        toStatusId: defaultStatus.id,
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

    if (order.status?.system && (order.status.code === OrderStatus.SHIPPED || order.status.code === OrderStatus.DELIVERED)) {
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
      landmark: dto.landmark,
      deposit: dto.deposit,
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

      const newStatus = await this.getDefaultStatus(order.adminId)

      const oldStatusId = order.statusId;
      const oldStatusCode = order.status.code;
      const newStatusCode = newStatus.code;

      if (oldStatusId === dto.statusId) return order;


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

      if (!validTransitions[oldStatusCode]?.includes(newStatusCode)) {
        throw new BadRequestException(`Cannot transition from ${oldStatusCode} to ${newStatusCode}`);
      }

      // Handle stock changes
      if (newStatusCode === OrderStatus.CANCELLED || newStatusCode === OrderStatus.RETURNED) {
        // Release reserved stock
        for (const item of order.items) {
          const variant = item.variant;
          variant.reserved = Math.max(0, (variant.reserved || 0) - item.quantity);
          await manager.save(ProductVariantEntity, variant);
        }
      }

      if (newStatusCode === OrderStatus.SHIPPED && !order.shippedAt) {
        order.shippedAt = new Date();
      }

      if (newStatusCode === OrderStatus.DELIVERED && !order.deliveredAt) {
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
        fromStatusId: oldStatusId,
        toStatusId: newStatus.id,
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
    if (![OrderStatus.NEW, OrderStatus.CANCELLED].includes(order.status.code as OrderStatus)) {
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

  async findStatusByCode(name: string, adminId: string): Promise<OrderStatusEntity> {
    // [2025-12-24] Trim input and ensure case-insensitive matching if needed
    const trimmedName = name.trim();

    const status = await this.statusRepo.findOne({
      where: [
        { name: trimmedName, system: true },           // Condition 1: Global System Status
        { name: trimmedName, adminId: adminId }   // Condition 2: Admin-specific Status
      ],
    });

    if (!status) {
      throw new NotFoundException(`Status "${trimmedName}" not found for this account.`);
    }

    return status;
  }

  async getDefaultStatus(adminId: string): Promise<OrderStatusEntity> {
    const status = await this.statusRepo.findOne({
      where: [
        { isDefault: true, system: true },           // System-wide default
        { isDefault: true, adminId: adminId }    // Admin-specific default
      ],
      order: { system: 'DESC' } // Prioritize system default if both exist
    });

    if (!status) {
      throw new Error("Critical: No order statuses found in system.");
    }

    return status;
  }

  async createStatus(me: any, dto: CreateStatusDto) {
    const adminId = tenantId(me);
    const name = dto.name.trim(); // [2025-12-24] Trim


    const code = slugify(name)
    await this.validateStatusUniqueness(name, code, adminId);
    // Check if name already exists for this admin or system


    const status = this.statusRepo.create({
      ...dto,
      name: dto.name?.trim(),
      description: dto.description?.trim(),
      color: dto.color.trim(),
      sortOrder: dto.sortOrder,
      adminId: adminId,
      system: false, // Force false for admin-created statuses
    });

    return await this.statusRepo.save(status);
  }

  async updateStatus(me: any, id: number, dto: UpdateStatusDto) {
    const adminId = tenantId(me);
    const status = await this.statusRepo.findOneBy({ id, adminId: adminId });

    if (!status) throw new NotFoundException("Status not found or is a protected System Status.");

    // Extra safety: even if adminId matches, block if system is true
    if (status.system) throw new ForbiddenException("Cannot edit system statuses.");
    const newName = dto.name?.trim() ?? status.name;

    const code = slugify(newName)
    await this.validateStatusUniqueness(newName, code, adminId, id);

    Object.assign(status, {
      ...dto,
      name: dto.name?.trim() ?? status.name,
      description: dto.description?.trim(),
      color: dto.color.trim(),
      sortOrder: dto.sortOrder,
    });

    return await this.statusRepo.save(status);
  }

  private async validateStatusUniqueness(name: string, code: string, adminId: string, excludeId?: number): Promise<void> {
    const queryBuilder = this.statusRepo.createQueryBuilder('status')
      .where(new Brackets(qb => {
        qb.where('status.name = :name', { name })
          .orWhere('status.code = :code', { code });
      }))
      .andWhere(new Brackets(qb => {
        qb.where('status.adminId = :adminId', { adminId })
          .orWhere('status.system = :system', { system: true });
      }));

    if (excludeId) {
      queryBuilder.andWhere('status.id != :excludeId', { excludeId });
    }

    const existing = await queryBuilder.getOne();

    if (existing) {
      const conflictType = existing.code === code ? 'code (slug)' : 'name';
      throw new BadRequestException(`Status ${conflictType} already exists. Please choose another name.`);
    }
  }

  async removeStatus(me: any, id: number) {
    const adminId = tenantId(me);
    const status = await this.statusRepo.findOneBy({ id, adminId: adminId });

    if (!status) throw new NotFoundException("Status not found.");
    if (status.system) throw new ForbiddenException("System statuses cannot be deleted.");

    // [2025-12-24] Trim Risk: Check if orders are using this status
    const usageCount = await this.orderRepo.countBy({ statusId: id });
    if (usageCount > 0) {
      throw new BadRequestException(`Cannot delete: ${usageCount} orders are currently in this status.`);
    }

    return await this.statusRepo.remove(status);
  }
}