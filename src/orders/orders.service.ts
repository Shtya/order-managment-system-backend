// orders/orders.service.ts
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository, In, EntityManager, Brackets } from "typeorm";
import * as ExcelJS from "exceljs";
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
import { ShippingCompanyEntity } from "src/shipping/shipping.entity";

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

    @InjectRepository(ShippingCompanyEntity)
    private shippingRepo: Repository<ShippingCompanyEntity>,

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
      .leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("order.shippingCompany", "shipping")
      .leftJoinAndSelect("order.store", "store");

    // Filters
    // Status: accept numeric id or status code string
    if (q?.status) {
      const statusParam = q.status;
      if (!isNaN(Number(statusParam))) {
        qb.andWhere("order.statusId = :statusId", { statusId: Number(statusParam) });
      } else {
        qb.andWhere("status.code = :statusCode", { statusCode: String(statusParam).trim() });
      }
    }
    if (q?.paymentStatus) qb.andWhere("order.paymentStatus = :paymentStatus", { paymentStatus: q.paymentStatus });
    if (q?.paymentMethod) qb.andWhere("order.paymentMethod = :paymentMethod", { paymentMethod: q.paymentMethod });
    if (q?.shippingCompanyId) qb.andWhere("order.shippingCompanyId = :shippingCompanyId", { shippingCompanyId: Number(q.shippingCompanyId) });
    if (q?.storeId) qb.andWhere("order.storeId = :storeId", { storeId: Number(q.storeId) });

    // Date range
    if (q?.startDate) qb.andWhere("order.created_at >= :startDate", { startDate: `${q.startDate}T00:00:00.000Z` });
    if (q?.endDate) qb.andWhere("order.created_at <= :endDate", { endDate: `${q.endDate}T23:59:59.999Z` });

    // Search
    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("order.orderNumber ILIKE :s", { s: `%${search}%` })
            .orWhere("order.customerName ILIKE :s", { s: `%${search}%` })
            .orWhere("order.phoneNumber ILIKE :s", { s: `%${search}%` });
        }),
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
      relations: ["items", "items.variant", "items.variant.product", "statusHistory", 'status', 'shippingCompany', "store"],
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

      if (dto.shippingCompanyId) {
        const shippingCompany = await manager.findOne(ShippingCompanyEntity, {
          where: { id: Number(dto.shippingCompanyId) }
        });

        if (!shippingCompany) {
          throw new BadRequestException("The selected shipping company is invalid or does not belong to your account.");
        }
      }
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
        shippingCompanyId: dto.shippingCompanyId ? dto.shippingCompanyId : null,
        shippingCost: dto.shippingCost ?? 0,
        discount: dto.discount ?? 0,
        productsTotal,
        finalTotal,
        profit,
        notes: dto.notes,
        customerNotes: dto.customerNotes,
        statusId: defaultStatus.id,
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
    if (dto.shippingCompanyId) {
      const shippingCompany = await this.shippingRepo.findOne({
        where: { id: Number(dto.shippingCompanyId) }
      });

      if (!shippingCompany) {
        throw new BadRequestException("The selected shipping company is invalid or does not belong to your account.");
      }
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
      shippingCompanyId: dto.shippingCompanyId ?? order.shippingCompanyId,
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

      const newStatus = await this.findStatusById(dto.statusId, order.adminId)

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

      //validate only for moving between system statuses
      if (newStatus.system && order.status.system && !validTransitions[oldStatusCode]?.includes(newStatusCode)) {
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

  async findStatusByCode(code: string, adminId: string): Promise<OrderStatusEntity> {
    // [2025-12-24] Trim input and ensure case-insensitive matching if needed
    const trimmedCode = code.trim();

    const status = await this.statusRepo.findOne({
      where: [
        { code: trimmedCode, system: true },           // Condition 1: Global System Status
        { code: trimmedCode, adminId: adminId }   // Condition 2: Admin-specific Status
      ],
    });

    if (!status) {
      throw new NotFoundException(`Status "${trimmedCode}" not found for this account.`);
    }

    return status;
  }
  async findStatusById(id: number, adminId: string): Promise<OrderStatusEntity> {
    // [2025-12-24] Trim input and ensure case-insensitive matching if needed

    const status = await this.statusRepo.findOne({
      where: [
        { id: id, system: true },           // Condition 1: Global System Status
        { id: id, adminId: adminId }   // Condition 2: Admin-specific Status
      ],
    });

    if (!status) {
      throw new NotFoundException(`Status "${id}" not found for this account.`);
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

  // ========================================
  // ✅ EXPORT ORDERS TO EXCEL
  // ========================================
  async exportOrders(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const search = String(q?.search ?? "").trim();

    const qb = this.orderRepo
      .createQueryBuilder("order")
      .where("order.adminId = :adminId", { adminId })
      .leftJoinAndSelect("order.items", "items")
      .leftJoinAndSelect("items.variant", "variant")
      .leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("order.shippingCompany", "shipping")
      .leftJoinAndSelect("order.store", "store");

    // Apply same filters as list method
    if (q?.status) {
      const statusParam = q.status;
      if (!isNaN(Number(statusParam))) {
        qb.andWhere("order.statusId = :statusId", { statusId: Number(statusParam) });
      } else {
        qb.andWhere("status.code = :statusCode", { statusCode: String(statusParam).trim() });
      }
    }
    if (q?.paymentStatus) qb.andWhere("order.paymentStatus = :paymentStatus", { paymentStatus: q.paymentStatus });
    if (q?.paymentMethod) qb.andWhere("order.paymentMethod = :paymentMethod", { paymentMethod: q.paymentMethod });
    if (q?.shippingCompanyId) qb.andWhere("order.shippingCompanyId = :shippingCompanyId", { shippingCompanyId: Number(q.shippingCompanyId) });
    if (q?.storeId) qb.andWhere("order.storeId = :storeId", { storeId: Number(q.storeId) });

    // Date range
    if (q?.startDate) qb.andWhere("order.created_at >= :startDate", { startDate: `${q.startDate}T00:00:00.000Z` });
    if (q?.endDate) qb.andWhere("order.created_at <= :endDate", { endDate: `${q.endDate}T23:59:59.999Z` });

    // Search
    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("order.orderNumber ILIKE :s", { s: `%${search}%` })
            .orWhere("order.customerName ILIKE :s", { s: `%${search}%` })
            .orWhere("order.phoneNumber ILIKE :s", { s: `%${search}%` });
        }),
      );
    }

    qb.orderBy("order.created_at", "DESC");

    // Get all records (no pagination for export)
    const orders = await qb.getMany();

    // Prepare Excel data
    const exportData = orders.map((order) => {
      const productsList = order.items
        ?.map((item) => `${item.variant?.product?.name || "N/A"} (x${item.quantity})`)
        .join("; ") || "N/A";

      return {
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        phoneNumber: order.phoneNumber || "N/A",
        email: order.email || "N/A",
        address: order.address || "N/A",
        city: order.city || "N/A",
        area: order.area || "N/A",
        landmark: order.landmark || "N/A",
        products: productsList,
        status: order.status?.system ? order.status.code : (order.status?.name || "N/A"),
        paymentMethod: order.paymentMethod || "N/A",
        paymentStatus: order.paymentStatus || "N/A",
        shippingCompany: order.shippingCompany?.name || "N/A",
        shippingCost: order.shippingCost || 0,
        discount: order.discount || 0,
        deposit: order.deposit || 0,
        finalTotal: (order.items?.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0) || 0) + (order.shippingCost || 0) - (order.discount || 0),
        notes: order.notes || "N/A",
        customerNotes: order.customerNotes || "N/A",
        createdAt: order.created_at ? new Date(order.created_at).toLocaleDateString() : "N/A",
        updatedAt: order.updated_at ? new Date(order.updated_at).toLocaleDateString() : "N/A",
      };
    });

    // Create workbook and worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Orders");

    // Define columns
    const columns = [
      { header: "Order Number", key: "orderNumber", width: 18 },
      { header: "Customer Name", key: "customerName", width: 25 },
      { header: "Phone Number", key: "phoneNumber", width: 18 },
      // { header: "Alternative Phone", key: "alternativePhone", width: 18 },
      { header: "Email", key: "email", width: 30 },
      { header: "Address", key: "address", width: 35 },
      { header: "City", key: "city", width: 15 },
      { header: "Area", key: "area", width: 15 },
      { header: "Landmark", key: "landmark", width: 20 },
      { header: "Products", key: "products", width: 40 },
      { header: "Status", key: "status", width: 20 },
      { header: "Payment Method", key: "paymentMethod", width: 18 },
      { header: "Payment Status", key: "paymentStatus", width: 18 },
      { header: "Shipping Company", key: "shippingCompany", width: 20 },
      { header: "Shipping Cost", key: "shippingCost", width: 15 },
      { header: "Discount", key: "discount", width: 15 },
      { header: "Deposit", key: "deposit", width: 15 },
      { header: "Final Total", key: "finalTotal", width: 15 },
      { header: "Notes", key: "notes", width: 30 },
      { header: "Customer Notes", key: "customerNotes", width: 30 },
      { header: "Created At", key: "createdAt", width: 15 },
      { header: "Updated At", key: "updatedAt", width: 15 },
    ];

    worksheet.columns = columns;

    // Style header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };

    // Add data rows
    exportData.forEach((row) => {
      worksheet.addRow(row);
    });

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }

  // ========================================
  // ✅ BULK UPLOAD: TEMPLATE (matches CreateOrderDto, comma-separated arrays)
  // ========================================
  async getBulkTemplate(me: any): Promise<Buffer> {
    tenantId(me);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Orders", { views: [{ state: "frozen", ySplit: 1 }] });

    const columns = [
      { header: "Customer Name", key: "customerName", width: 22 },
      { header: "Phone Number", key: "phoneNumber", width: 16 },
      { header: "Email", key: "email", width: 28 },
      { header: "Address", key: "address", width: 32 },
      { header: "City", key: "city", width: 14 },
      { header: "Area", key: "area", width: 14 },
      { header: "Landmark", key: "landmark", width: 18 },
      { header: "Payment Method", key: "paymentMethod", width: 18 },
      { header: "Payment Status", key: "paymentStatus", width: 16 },
      { header: "Shipping Company Name", key: "shippingCompanyName", width: 22 },
      { header: "Shipping Cost", key: "shippingCost", width: 14 },
      { header: "Discount", key: "discount", width: 12 },
      { header: "Deposit", key: "deposit", width: 12 },
      { header: "Notes", key: "notes", width: 24 },
      { header: "Customer Notes", key: "customerNotes", width: 24 },
      { header: "Product SKUs (comma-separated)", key: "productSkus", width: 30 },
      { header: "Quantities (comma-separated)", key: "quantities", width: 25 },
      { header: "Unit Prices (comma-separated)", key: "unitPrices", width: 28 },
    ];
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0E0E0" } };
    // Example order with two products
    sheet.addRow({
      customerName: "أحمد محمد",
      phoneNumber: "01234567890",
      email: "examble@gmail.com",
      address: "شارع 9 - مبنى 15",
      city: "القاهرة",
      area: "المعادي",
      landmark: "بجوار مسجد النور",
      paymentMethod: "cod",
      paymentStatus: "pending",
      shippingCompanyName: "شركة أرامكس",
      shippingCost: 50,
      discount: 0,
      deposit: 0,
      notes: "",
      customerNotes: "يفضل التواصل مساءً",
      productSkus: "SKU-001, SKU-002",
      quantities: "2, 1",
      unitPrices: "350, 200",
    });
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer as unknown as Buffer;
  }

  // ========================================
  // ✅ BULK CREATE ORDERS FROM EXCEL
  // ========================================
  async bulkCreateOrders(me: any, file: Express.Multer.File): Promise<{ created: number; failed: number; errors: { rowNumber: number; message: string }[] }> {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");
    if (!file?.buffer) throw new BadRequestException("No file uploaded");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException("Excel file has no sheet");

    const rows: Record<string, string | number>[] = [];
    const headerRow = sheet.getRow(1);
    const keys: string[] = [];
    headerRow.eachCell((cell, colNumber) => {
      const val = String(cell.value ?? "").trim();
      keys[colNumber - 1] = val ? val.toLowerCase().replace(/\s+/g, "") : "";
    });

    //extract values of rows
    for (let i = 2; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i);
      const obj: Record<string, string | number> = {};
      row.eachCell((cell, colNumber) => {
        const key = keys[colNumber - 1];
        if (!key) return;
        const v = cell.value;
        if (v === null || v === undefined) obj[key] = "";
        else if (typeof v === "number") obj[key] = v;
        else obj[key] = String(v).trim();
      });
      rows.push(obj);
    }

    const col = (obj: Record<string, string | number>, ...names: string[]) => {
      for (const n of names) {
        const k = n.replace(/\s+/g, "").toLowerCase();
        if (obj[k] !== undefined && obj[k] !== "") return String(obj[k]).trim();
      }
      return "";
    };
    const num = (obj: Record<string, string | number>, key: string, def = 0) => {
      const k = key.replace(/\s+/g, "").toLowerCase();
      const v = obj[k];
      if (v === undefined || v === "") return def;
      const n = Number(v);
      return isNaN(n) ? def : n;
    };

    const shippingCompanies = await this.shippingRepo.find({ where: { adminId } as any });
    const shippingByName = new Map<string, number>();
    shippingCompanies.forEach((s) => shippingByName.set(s.name.trim().toLowerCase(), s.id));

    const paymentMethods = ["cash", "card", "bank_transfer", "cod"];
    const paymentStatuses = ["pending", "paid", "partial"];

    let created = 0;
    const errors: { rowNumber: number; message: string }[] = [];

    //Add each order by inner create method
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      const rowNumber = rowIdx + 2; // +2 because excel rows start at 1 and data starts at row 2

      const customerName = col(row, "Customer Name", "customername");
      const phoneNumber = col(row, "Phone Number", "phonenumber");
      const address = col(row, "Address", "address");
      const city = col(row, "City", "city");
      if (!customerName || !phoneNumber || !address || !city) {
        errors.push({ rowNumber, message: "Missing required: Customer Name, Phone Number, Address, or City" });
        continue;
      }

      // Parse comma-separated arrays
      const skusStr = col(row, "Product SKUs (comma-separated)", "productskus");
      const quantitiesStr = col(row, "Quantities (comma-separated)", "quantities");
      const unitPricesStr = col(row, "Unit Prices (comma-separated)", "unitprices");

      if (!skusStr || !quantitiesStr || !unitPricesStr) {
        errors.push({ rowNumber, message: "Missing required: Product SKUs, Quantities, or Unit Prices" });
        continue;
      }

      const skus = skusStr.split(",").map(s => s.trim()).filter(s => s);
      const quantities = quantitiesStr.split(",").map(q => {
        const num = Number(q.trim());
        return isNaN(num) ? null : num;
      });
      const unitPrices = unitPricesStr.split(",").map(p => {
        const num = Number(p.trim());
        return isNaN(num) ? null : num;
      });

      // Validate array lengths match
      if (skus.length !== quantities.length || skus.length !== unitPrices.length) {
        errors.push({
          rowNumber,
          message: `Array length mismatch: ${skus.length} SKUs, ${quantities.length} quantities, ${unitPrices.length} prices. All must be equal.`
        });
        continue;
      }

      // Validate no null values
      if (quantities.includes(null) || unitPrices.includes(null)) {
        errors.push({ rowNumber, message: "Invalid quantities or unit prices (must be numbers)" });
        continue;
      }

      // Collect unique SKUs for targeted fetch
      const uniqueSkus = [...new Set(skus.map(s => s))];
      const variants = await this.variantRepo.find({
        where: {
          adminId,
          sku: In(uniqueSkus)
        } as any,
        relations: ["product"]
      });
      const variantBySku = new Map<string, { id: number; price: number }>();
      variants.forEach((v) => {
        if (v.sku) variantBySku.set(String(v.sku).trim().toLowerCase(), { id: v.id, price: v.price ?? 0 });
      });

      const paymentMethodRaw = col(row, "Payment Method", "paymentmethod") || "cod";
      const paymentMethod = paymentMethods.includes(paymentMethodRaw) ? paymentMethodRaw : "cod";
      const paymentStatusRaw = col(row, "Payment Status", "paymentstatus") || "pending";
      const paymentStatus = paymentStatuses.includes(paymentStatusRaw) ? paymentStatusRaw : "pending";

      let shippingCompanyId: string | undefined;
      const shippingName = col(row, "Shipping Company Name", "shippingcompanyname");
      if (shippingName) {
        const sid = shippingByName.get(shippingName.toLowerCase());
        if (sid != null) shippingCompanyId = String(sid);
      }

      // Build items array
      const items: { variantId: number; quantity: number; unitPrice: number; unitCost?: number }[] = [];
      for (let i = 0; i < skus.length; i++) {
        const sku = skus[i];
        const qty = quantities[i] as number;
        const unitPrice = unitPrices[i] as number;

        if (qty < 1) {
          errors.push({ rowNumber, message: `Invalid quantity for SKU ${sku}: must be >= 1` });
          continue;
        }

        const variant = variantBySku.get(sku.toLowerCase());
        if (!variant) {
          errors.push({ rowNumber, message: `Product SKU not found: ${sku}` });
          break;
        }
        items.push({ variantId: variant.id, quantity: qty, unitPrice, unitCost: variant.price });
      }

      if (items.length === 0) {
        errors.push({ rowNumber, message: "No valid items processed" });
        continue;
      }

      const dto: CreateOrderDto = {
        customerName,
        phoneNumber,
        email: col(row, "Email", "email") || undefined,
        address,
        city,
        area: col(row, "Area", "area") || undefined,
        landmark: col(row, "Landmark", "landmark") || undefined,
        paymentMethod: paymentMethod as any,
        paymentStatus: paymentStatus as any,
        shippingCompanyId: shippingCompanyId ?? "",
        shippingCost: num(row, "Shipping Cost", 0),
        discount: num(row, "Discount", 0),
        deposit: num(row, "Deposit", 0),
        notes: col(row, "Notes", "notes") || undefined,
        customerNotes: col(row, "Customer Notes", "customernotes") || undefined,
        items,
      };

      try {
        await this.create(me, dto, undefined);
        created++;
      } catch (err: any) {
        errors.push({ rowNumber, message: err?.message || "Create failed" });
      }
    }

    return { created, failed: errors.length, errors };
  }
}