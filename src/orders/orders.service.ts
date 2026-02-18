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
  OrderRetrySettingsEntity,
  OrderAssignmentEntity,
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
  UpsertOrderRetrySettingsDto,
  AutoAssignDto,
  GetFreeOrdersDto,
  ManualAssignManyDto,
  AutoPreviewDto,
} from "dto/order.dto";
import { ShippingCompanyEntity } from "entities/shipping.entity";
import { User } from "entities/user.entity";

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

    @InjectRepository(User)
    private userRepo: Repository<User>,

    @InjectRepository(OrderRetrySettingsEntity)
    private retryRepo: Repository<OrderRetrySettingsEntity>,

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

    const sortBy = String(q?.sortBy ?? "createdAt");
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const qb = this.orderRepo
      .createQueryBuilder("order")
      .where("order.adminId = :adminId", { adminId })
      .leftJoinAndSelect("order.items", "items")
      .leftJoinAndSelect("items.variant", "variant")
      .leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("order.shippingCompany", "shipping")
      .leftJoinAndSelect("order.store", "store")
      .leftJoinAndSelect(
        "order.assignments",
        "assignment",
        "assignment.isAssignmentActive = true"
      ).leftJoinAndSelect("assignment.employee", "employee");
    // Allowed columns mapping
    const sortColumns: Record<string, string> = {
      createdAt: "order.created_at",
      orderNumber: "order.orderNumber",
    };


    if (q?.userId) {
      qb.andWhere("assignment.employeeId = :userId", { userId: Number(q.userId) });
    }


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

    if (sortColumns[sortBy]) {
      qb.orderBy(sortColumns[sortBy], sortDir);
    } else {
      qb.orderBy("order.created_at", "DESC"); // fallback
    }

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

  async listMyAssignedOrders(me: any, limit: number = 50) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    // Assuming 'me' contains the logged-in user's ID (adjust to me.sub or me.userId if needed)
    const myUserId = me.id;
    if (!myUserId) throw new BadRequestException("Missing user ID");

    const fetchLimit = Number(limit) || 50;

    const records = await this.orderRepo
      .createQueryBuilder("order")
      .where("order.adminId = :adminId", { adminId })
      // INNER JOIN guarantees we only fetch orders actively assigned to THIS specific user
      .innerJoinAndSelect(
        "order.assignments",
        "assignment",
        "assignment.isAssignmentActive = true AND assignment.employeeId = :myUserId",
        { myUserId }
      )
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("order.shippingCompany", "shipping")
      .orderBy("order.created_at", "DESC")
      .take(fetchLimit)
      .getMany();

    return {
      per_page: fetchLimit,
      records,
    };
  }

  // ========================================
  // ✅ GET ORDER BY ID
  // ========================================

  async get(me: any, id: number) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const order = await this.orderRepo.createQueryBuilder("order")
      .leftJoinAndSelect("order.items", "items")
      .leftJoinAndSelect("items.variant", "variant")
      .leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("order.statusHistory", "statusHistory")
      .leftJoinAndSelect("statusHistory.fromStatus", "fromStatus")
      .leftJoinAndSelect("statusHistory.toStatus", "toStatus")
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("order.shippingCompany", "shippingCompany")
      .leftJoinAndSelect("order.store", "store")
      // Filter assignments to only include the active one
      .leftJoinAndSelect("order.assignments", "assignments", "assignments.isAssignmentActive = :active", { active: true })
      .leftJoinAndSelect("assignments.employee", "employee") // Optional: load the employee details
      .where("order.id = :id", { id })
      .andWhere("order.adminId = :adminId", { adminId })
      .getOne();

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
          where: { id: Number(dto.shippingCompanyId), adminId }
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
        where: { id: Number(dto.shippingCompanyId), adminId }
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
  validTransitions: Record<OrderStatus, OrderStatus[]> = {
    [OrderStatus.NEW]: [
      OrderStatus.UNDER_REVIEW,
      OrderStatus.CANCELLED,
      OrderStatus.CONFIRMED,    // النجاح
      OrderStatus.POSTPONED,    // محاولة (إعادة محاولة)
      OrderStatus.NO_ANSWER,    // محاولة (إعادة محاولة)
      OrderStatus.WRONG_NUMBER, // فشل نهائي
      OrderStatus.OUT_OF_DELIVERY_AREA, // فشل نهائي
      OrderStatus.DUPLICATE,    // فشل نهائي
      OrderStatus.CANCELLED
    ],

    [OrderStatus.UNDER_REVIEW]: [
      OrderStatus.CONFIRMED,    // النجاح
      OrderStatus.POSTPONED,    // محاولة (إعادة محاولة)
      OrderStatus.NO_ANSWER,    // محاولة (إعادة محاولة)
      OrderStatus.WRONG_NUMBER, // فشل نهائي
      OrderStatus.OUT_OF_DELIVERY_AREA, // فشل نهائي
      OrderStatus.DUPLICATE,    // فشل نهائي
      OrderStatus.CANCELLED
    ],

    // الحالات الفرعية للمراجعة تسمح بالعودة للمراجعة أو الانتقال للتجهيز
    [OrderStatus.POSTPONED]: [
      OrderStatus.UNDER_REVIEW,
      OrderStatus.CONFIRMED,
      OrderStatus.NO_ANSWER,    // محاولة (إعادة محاولة)
      OrderStatus.WRONG_NUMBER, // فشل نهائي
      OrderStatus.OUT_OF_DELIVERY_AREA, // فشل نهائي
      OrderStatus.DUPLICATE,
      OrderStatus.CANCELLED
    ],
    [OrderStatus.NO_ANSWER]: [
      OrderStatus.UNDER_REVIEW,
      OrderStatus.CONFIRMED,
      OrderStatus.POSTPONED,    // محاولة (إعادة محاولة)
      OrderStatus.WRONG_NUMBER, // فشل نهائي
      OrderStatus.OUT_OF_DELIVERY_AREA, // فشل نهائي
      OrderStatus.DUPLICATE,
      OrderStatus.CANCELLED
    ],

    [OrderStatus.CONFIRMED]: [
      OrderStatus.PREPARING,
      OrderStatus.CANCELLED
    ],

    [OrderStatus.PREPARING]: [
      OrderStatus.READY,
      OrderStatus.CANCELLED
    ],

    [OrderStatus.READY]: [
      OrderStatus.SHIPPED,
      OrderStatus.CANCELLED
    ],

    [OrderStatus.SHIPPED]: [
      OrderStatus.DELIVERED,
      OrderStatus.RETURNED
    ],

    [OrderStatus.DELIVERED]: [
      OrderStatus.RETURNED
    ],

    // حالات الفشل النهائي عادة لا تسمح بانتقالات أخرى إلا بواسطة الأدمن
    [OrderStatus.WRONG_NUMBER]: [],
    [OrderStatus.OUT_OF_DELIVERY_AREA]: [],
    [OrderStatus.DUPLICATE]: [],
    [OrderStatus.CANCELLED]: [], // للسماح بإعادة فتح الطلب إذا لزم الأمر
    [OrderStatus.RETURNED]: [],
  };
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


      //validate only for moving between system statuses
      if (newStatus.system && order.status.system && !this.validTransitions[oldStatusCode]?.includes(newStatusCode as OrderStatus)) {
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
  // ✅ CONFIRMATION TEAM: CHANGE ORDER STATUS
  // ========================================
  async changeConfirmationStatus(me: any, id: number, dto: ChangeOrderStatusDto, ipAddress?: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");
    const employeeId = me.id;

    return this.dataSource.transaction(async (manager) => {
      // 1. Fetch Order and its Active Assignment for this employee
      const order = await manager.findOne(OrderEntity, {
        where: { id, adminId } as any,
        relations: ["status", "items", "items.variant", "assignments"],
      });

      if (!order) throw new BadRequestException("Order not found");

      // Validate Active Assignment
      const activeAssignment = order.assignments.find(
        (a) => a.isAssignmentActive && a.employeeId === employeeId
      );
      if (!activeAssignment) {
        throw new BadRequestException("You do not have an active assignment for this order.");
      }

      // 2. Fetch Statuses & Settings
      let newStatus = await this.findStatusById(dto.statusId, adminId);
      const oldStatusId = order.statusId;
      const oldStatusCode = order.status.code;

      if (oldStatusId === newStatus.id) return order;

      const allowed = [
        OrderStatus.UNDER_REVIEW,
        OrderStatus.CANCELLED,
        OrderStatus.CONFIRMED,    // النجاح
        OrderStatus.POSTPONED,    // محاولة (إعادة محاولة)
        OrderStatus.NO_ANSWER,    // محاولة (إعادة محاولة)
        OrderStatus.WRONG_NUMBER, // فشل نهائي
        OrderStatus.OUT_OF_DELIVERY_AREA, // فشل نهائي
        OrderStatus.DUPLICATE,    // فشل نهائي
        OrderStatus.CANCELLED
      ]

      if (newStatus.system && !allowed.includes(newStatus.code as OrderStatus)) {
        throw new BadRequestException(`Confirmation team is not allowed to set status to ${newStatus.code}`);
      }

      if (newStatus.system && order.status.system && !this.validTransitions[oldStatusCode]?.includes(newStatus.code)) {
        throw new BadRequestException(`Cannot transition from ${oldStatusCode} to ${newStatus.code}`);
      }

      if (newStatus.system && order.status.system && !this.validTransitions[oldStatusCode]?.includes(newStatus.code)) {
        throw new BadRequestException(`Cannot transition from ${oldStatusCode} to ${newStatus.code}`);
      }

      // Fetch Retry Settings
      const settings = await this.getSettings(me);

      const now = new Date();
      activeAssignment.lastActionAt = now;

      // 3. Handle Retry & Assignment Logic
      const isRetryStatus = settings.retryStatuses.includes(newStatus.code);

      if (isRetryStatus && settings.enabled) {
        activeAssignment.retriesUsed += 1;

        if (activeAssignment.retriesUsed >= activeAssignment.maxRetriesAtAssignment) {
          // Max retries hit: Force auto-move status and finish assignment
          newStatus = await manager.findOne(OrderStatusEntity, {
            where: { code: settings.autoMoveStatus, adminId }
          });
          if (!newStatus) throw new BadRequestException("Auto-move status is not configured correctly.");

          activeAssignment.isAssignmentActive = false;
          activeAssignment.finishedAt = now;
          activeAssignment.lockedUntil = null;
        } else {
          // Lock for the retry interval
          activeAssignment.lockedUntil = new Date(now.getTime() + settings.retryInterval * 60000);
        }
      } else {
        // Success or Terminal Failure (Not a retry state): Finish assignment
        activeAssignment.isAssignmentActive = false;
        activeAssignment.finishedAt = now;
        activeAssignment.lockedUntil = null;
      }

      // 4. Update Order (Stock logic included for terminal states)
      if (newStatus.code === OrderStatus.CANCELLED || newStatus.code === OrderStatus.RETURNED) {
        for (const item of order.items) {
          item.variant.reserved = Math.max(0, (item.variant.reserved || 0) - item.quantity);
          await manager.save(ProductVariantEntity, item.variant);
        }
      }

      order.status = newStatus;
      order.updatedByUserId = employeeId;

      // Save Entities
      await manager.save(OrderAssignmentEntity, activeAssignment);
      const savedOrder = await manager.save(OrderEntity, order);

      if (settings.notifyAdmin) {
        console.log("notify admin here")
      }

      if (settings.notifyEmployee) {
        console.log("notify employee here")
      }
      // Log History
      await this.logStatusChange({
        adminId,
        orderId: savedOrder.id,
        fromStatusId: oldStatusId,
        toStatusId: newStatus.id,
        userId: employeeId,
        notes: dto.notes,
        ipAddress,
        manager,
      });

      return savedOrder;
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
      .leftJoinAndSelect("order.store", "store")
      .leftJoinAndSelect("order.assignments", "assignment", "assignment.isAssignmentActive = true")
      .leftJoinAndSelect("assignment.employee", "employee");

    // Filter by assigned employee (userId)
    if (q?.userId) {
      qb.andWhere("assignment.employeeId = :userId", { userId: Number(q.userId) });
    }

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
      const activeAssignment = order.assignments?.find(a => a.isAssignmentActive);
      const assignedTo = activeAssignment?.employee
        ? `${activeAssignment.employee.name || "N/A"} (ID: ${activeAssignment.employee.id || "N/A"})`
        : "Unassigned";
      return {
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        assignedTo: assignedTo,
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
      { header: "Assigned To", key: "assignedTo", width: 25 },
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

  async getSettings(me: any): Promise<OrderRetrySettingsEntity> {
    const adminId = tenantId(me);
    let settings = await this.retryRepo.findOneBy({ adminId: adminId });

    if (!settings) {
      settings = await this.retryRepo.create({ adminId })
    }

    // Return existing or a default object to keep frontend stable
    return settings;
  }

  async upsertSettings(me: any, dto: UpsertOrderRetrySettingsDto): Promise<OrderRetrySettingsEntity> {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    let settings = await this.retryRepo.findOneBy({ adminId });

    if (settings) {
      // Update existing record
      this.retryRepo.merge(settings, dto);
    } else {
      // Create new record for this admin
      settings = this.retryRepo.create({ ...dto, adminId });
    }

    return await this.retryRepo.save(settings);
  }



  async getFreeOrders(me: any, q: GetFreeOrdersDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const fetchLimit = Number(q.limit) || 20;

    const qb = this.orderRepo.createQueryBuilder("order")
      .innerJoin("order.status", "status")
      .where("order.adminId = :adminId", { adminId })
      .andWhere(qb => {
        const subQuery = qb.subQuery()
          .select("1")
          .from("order_assignments", "assignment")
          .where("assignment.orderId = order.id")
          .andWhere("assignment.isAssignmentActive = true")
          .getQuery();
        return `NOT EXISTS ${subQuery}`;
      });

    // ✅ Multiple statuses filter
    if (q.statusIds?.length) {
      qb.andWhere("status.id IN (:...statusIds)", {
        statusIds: q.statusIds
      });
    }

    // Date filters
    if (q?.startDate)
      qb.andWhere("order.created_at >= :startDate", {
        startDate: `${q.startDate}T00:00:00.000Z`,
      });

    if (q?.endDate)
      qb.andWhere("order.created_at <= :endDate", {
        endDate: `${q.endDate}T23:59:59.999Z`,
      });

    // Cursor pagination
    if (q.cursor) {
      qb.andWhere("order.created_at < :cursor", { cursor: q.cursor });
    }

    qb.orderBy("order.created_at", "DESC")
      .limit(fetchLimit + 1); // fetch one extra to check hasMore

    const orders = await qb.getMany();

    const hasMore = orders.length > fetchLimit;
    if (hasMore) orders.pop();

    const nextCursor = hasMore && orders.length > 0
      ? orders[orders.length - 1].created_at
      : null;

    return {
      data: orders,
      nextCursor,
      hasMore
    };
  }


  /** Get count of free (unassigned) orders by status and optional date range. */
  async getFreeOrdersCount(me: any, q: { statusIds: number[]; startDate?: string; endDate?: string }) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const qb = this.orderRepo
      .createQueryBuilder("order")
      .innerJoin("order.status", "status")
      .where("order.adminId = :adminId", { adminId })
      .andWhere((qb) => {
        const subQuery = qb
          .subQuery()
          .select("1")
          .from("order_assignments", "assignment")
          .where("assignment.orderId = order.id")
          .andWhere("assignment.isAssignmentActive = true")
          .getQuery();
        return `NOT EXISTS ${subQuery}`;
      });


    if (q.statusIds?.length) {
      qb.andWhere("status.id IN (:...statusIds)", {
        statusIds: q.statusIds
      });
    }

    if (q?.startDate) {
      qb.andWhere("order.created_at >= :startDate", {
        startDate: `${q.startDate}T00:00:00.000Z`,
      });
    }
    if (q?.endDate) {
      qb.andWhere("order.created_at <= :endDate", {
        endDate: `${q.endDate}T23:59:59.999Z`,
      });
    }

    const count = await qb.getCount();
    return { count };
  }

  async getEmployeesByLoad(me: any, limit: number = 20, cursor: number | null) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const fetchLimit = Number(limit) || 20;

    const qb = this.userRepo.createQueryBuilder("user")
      .leftJoin("user.assignments", "assignment", "assignment.isAssignmentActive = true")
      .where("user.adminId = :adminId", { adminId })
      .select([
        "user.id",
        "user.name",
        "user.email",
        "user.avatarUrl",
        "user.employeeType"
      ])
      .addSelect("COUNT(assignment.id)", "activeCount")
      .groupBy("user.id")
      .addGroupBy("user.name")
      .addGroupBy("user.email")
      .addGroupBy("user.avatarUrl")
      .addGroupBy("user.employeeType");

    // Filter by cursor (count)
    if (cursor !== null && cursor !== undefined) {
      qb.having("COUNT(assignment.id) >= :cursor", { cursor });
    }

    // Order by count (primary) and ID (secondary tie-breaker)
    qb.orderBy("COUNT(assignment.id)", "ASC")
      .addOrderBy("user.id", "ASC")
      .limit(fetchLimit + 1);

    const { entities, raw } = await qb.getRawAndEntities();

    const result = entities.map((u, i) => ({
      user: u,
      activeCount: parseInt(raw[i].activeCount, 10) || 0,
    }));

    const hasMore = result.length > fetchLimit;

    if (hasMore) {
      result.pop();
    }

    // Next cursor is the count of the last item
    const nextCursor = hasMore && result.length > 0
      ? result[result.length - 1].activeCount
      : null;

    return {
      data: result,
      nextCursor,
      hasMore,
    };
  }


  async manualAssignMany(me: any, dto: ManualAssignManyDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    // collect all employee ids and all order ids from payload
    const employeeIds = [...new Set(dto.assignments.map(a => a.userId))];
    const allOrderIds = [
      ...new Set(dto.assignments.flatMap(a => a.orderIds))
    ];

    // validate no duplicate order across different employees (already deduped above, but check in payload)
    const payloadOrderCount = dto.assignments.reduce((sum, a) => sum + a.orderIds.length, 0);
    if (allOrderIds.length !== payloadOrderCount) {
      throw new BadRequestException("Each order may only be assigned to a single employee in the same request");
    }

    return this.dataSource.transaction(async (manager) => {
      // 1) verify employees exist & belong to admin
      const employees = await manager.find(User, {
        where: { id: In(employeeIds), adminId } as any
      });

      if (employees.length !== employeeIds.length) {
        throw new NotFoundException(`Employees not found or not belonging to admin`);
      }

      // 2) verify orders exist & belong to admin
      const freeOrders = await manager.createQueryBuilder(OrderEntity, "order")
        .leftJoin(
          "order.assignments",
          "assignment",
          "assignment.isAssignmentActive = :isActive",
          { isActive: true }
        )
        .where("order.id IN (:...allOrderIds)", { allOrderIds })
        .andWhere("order.adminId = :adminId", { adminId })
        .andWhere("assignment.id IS NULL") // This ensures the order is "free"
        .select(["order.id", "order.orderNumber"])
        .getMany();

      if (freeOrders.length !== allOrderIds.length) {
        throw new BadRequestException(`Some orders are either invalid, restricted, or already actively assigned.`)
      }
      // 4) fetch settings
      const settings = await this.getSettings(me);
      const maxRetries = settings?.maxRetries || 3;

      // 5) create assignment entities in bulk
      const assignmentsToSave: OrderAssignmentEntity[] = [];

      for (const item of dto.assignments) {
        for (const orderId of item.orderIds) {
          const assignment = manager.create(OrderAssignmentEntity, {
            orderId,
            employeeId: item.userId,
            assignedByAdminId: Number(me.id),
            maxRetriesAtAssignment: maxRetries,
            isAssignmentActive: true,
          });
          assignmentsToSave.push(assignment);
        }
      }

      // 6) save all assignments
      const saved = await manager.save(OrderAssignmentEntity, assignmentsToSave);

      // return helpful summary
      const summary = {
        success: true,
        totalAssigned: saved.length,
        byEmployee: employees.map(emp => {
          const count = saved.filter(s => s.employeeId === emp.id).length;
          return { userId: emp.id, name: emp.name || null, assignedCount: count };
        })
      };

      return summary;
    });
  }

  async autoAssign(me: any, dto: AutoAssignDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    return this.dataSource.transaction(async (manager) => {
      // 1. Find 'Free' Orders (No active assignments)
      const q = manager.createQueryBuilder(OrderEntity, "order")
        .leftJoin("order.assignments", "assignment", "assignment.isAssignmentActive = :isActive", { isActive: true })
        .where("order.adminId = :adminId", { adminId })
        .andWhere("order.statusId IN (:...statusIds)", { statusIds: dto.statusIds })
        .andWhere("assignment.id IS NULL") // Only orders with NO active assignments
        .select(["order.id", "order.orderNumber"])


      if (dto?.startDate) q.andWhere("order.created_at >= :startDate", { startDate: `${dto.startDate}T00:00:00.000Z` });
      if (dto?.endDate) q.andWhere("order.created_at <= :endDate", { endDate: `${dto.endDate}T23:59:59.999Z` });

      const freeOrders = await q.limit(dto.orderCount).getMany();

      if (freeOrders.length === 0) {
        throw new NotFoundException("No free orders found matching these criteria");
      }
      if (freeOrders.length !== dto.orderCount) {
        throw new BadRequestException(
          `Cannot fulfill request. You requested ${dto.orderCount} orders, but only ${freeOrders.length} unassigned orders were found for the selected statuses.`
        );
      }

      // 2. Find 'Least Busy' Employees
      // We count active assignments for each employee and sort ASC
      const employees = await manager.createQueryBuilder(User, "user")
        .leftJoin("order_assignments", "oa", "oa.employeeId = user.id AND oa.isAssignmentActive = true")
        .where("user.adminId = :adminId", { adminId })
        // Add a role check here if necessary (e.g., .andWhere("user.role = 'employee'"))
        .select("user.id", "id")
        .addSelect("user.name", "name")
        .addSelect("COUNT(oa.id)", "activeCount")
        .groupBy("user.id")
        .orderBy("COUNT(oa.id)", "ASC")
        .limit(dto.employeeCount)
        .getRawMany();

      if (employees.length === 0) {
        throw new NotFoundException("No eligible employees found");
      }

      if (employees.length < dto.employeeCount) {
        throw new BadRequestException(
          `Insufficient employees. You requested assignment to ${dto.employeeCount} employees, but only ${employees.length} are available.`
        );
      }

      // 3. Fetch Settings
      const settings = await this.getSettings(me);
      const maxRetries = settings?.maxRetries || 3;

      const assignmentsToSave: OrderAssignmentEntity[] = [];

      freeOrders.forEach((order, index) => {
        const employee = employees[index % employees.length]; // Cycle through employees

        const assignment = manager.create(OrderAssignmentEntity, {
          orderId: order.id,
          employeeId: employee.id,
          assignedByAdminId: Number(me.id),
          maxRetriesAtAssignment: maxRetries,
          isAssignmentActive: true,
        });
        assignmentsToSave.push(assignment);
      });

      // 5. Save and Summary
      const saved = await manager.save(OrderAssignmentEntity, assignmentsToSave);

      return {
        success: true,
        totalAssigned: saved.length,
        employeesParticipating: employees.length,
        byEmployee: employees.map(emp => ({
          userId: emp.id,
          name: emp.name,
          previouslyActive: parseInt(emp.activeCount),
          newlyAssigned: saved.filter(s => s.employeeId === emp.id).length
        }))
      };
    });
  }

  async getAutoPreview(me: any, dto: AutoPreviewDto) {
    const adminId = tenantId(me);

    // 1. Fetch TOTAL Max Limits (Ceilings) in Parallel
    const orderCountQuery = this.orderRepo.createQueryBuilder("order")
      .leftJoin("order.assignments", "oa", "oa.isAssignmentActive = true")
      .where("order.adminId = :adminId", { adminId })
      .andWhere("order.statusId IN (:...statusIds)", { statusIds: dto.statusIds })
      .andWhere("oa.id IS NULL");

    if (dto?.startDate) {
      orderCountQuery.andWhere("order.created_at >= :startDate", { startDate: `${dto.startDate}T00:00:00.000Z` });
    }
    if (dto?.endDate) {
      orderCountQuery.andWhere("order.created_at <= :endDate", { endDate: `${dto.endDate}T23:59:59.999Z` });
    }

    const [maxOrdersCount, maxEmployeesCount] = await Promise.all([
      orderCountQuery.getCount(),
      this.userRepo.count({ where: { adminId } as any })
    ]);

    // 2. Cap the requested counts to the Max Limits
    const effectiveOrderCount = Math.min(dto.requestedOrderCount, maxOrdersCount);
    const effectiveEmployeeCount = Math.min(dto.requestedEmployeeCount, maxEmployeesCount);

    // If there's nothing to assign, return early
    if (effectiveOrderCount === 0 || effectiveEmployeeCount === 0) {
      return { maxOrders: maxOrdersCount, maxEmployees: maxEmployeesCount, assignments: [] };
    }
    // 3. Fetch specific Orders and Employees for the preview
    const [freeOrders, leastBusyEmployees] = await Promise.all([
      this.orderRepo.createQueryBuilder("order")
        .leftJoin("order.assignments", "oa", "oa.isAssignmentActive = true")
        .where("order.adminId = :adminId", { adminId })
        .andWhere("order.statusId IN (:...statusIds)", { statusIds: dto.statusIds })
        .andWhere("oa.id IS NULL")
        .select(["order.id", "order.orderNumber"])
        .limit(effectiveOrderCount)
        .getMany(),

      this.userRepo.createQueryBuilder("user")
        .leftJoin("order_assignments", "oa", "oa.employeeId = user.id AND oa.isAssignmentActive = true")
        .where("user.adminId = :adminId", { adminId })
        .select(["user.id", "user.name"])
        .addSelect("COUNT(oa.id)", "activeCount")
        .groupBy("user.id")
        .orderBy("COUNT(oa.id)", "ASC")
        .limit(effectiveEmployeeCount)
        .getMany()
    ]);
    // 4. In-Memory Round-Robin Assignment
    const assignmentMap = new Map<number, { name: string; orderNumbers: string[] }>();

    // Initialize map with selected employees
    leastBusyEmployees.forEach(emp => {
      assignmentMap.set(emp.id, { name: emp.name, orderNumbers: [] });
    });

    // Distribute orders
    freeOrders.forEach((order, index) => {
      const employee = leastBusyEmployees[index % leastBusyEmployees.length];
      assignmentMap.get(employee.id).orderNumbers.push(order.orderNumber);
    });

    return {
      maxOrders: maxOrdersCount,
      maxEmployees: maxEmployeesCount,
      assignments: Array.from(assignmentMap.values())
    };
  }

  async getNextAssignedOrder(me: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const orders = await this.orderRepo
      .createQueryBuilder("order")
      .innerJoin(
        "order.assignments",
        "assignment",
        `
        assignment.employeeId = :userId
        AND assignment.isAssignmentActive = true
        AND assignment.finishedAt IS NULL
        AND (
          assignment.lockedUntil IS NULL
          OR assignment.lockedUntil <= NOW()
        )
      `,
        { userId: me.id }
      )
      .where("order.adminId = :adminId", { adminId })
      .leftJoinAndSelect("order.items", "items")
      .leftJoinAndSelect("items.variant", "variant")
      .leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("order.statusHistory", "statusHistory")
      .leftJoinAndSelect("statusHistory.fromStatus", "fromStatus")
      .leftJoinAndSelect("statusHistory.toStatus", "toStatus")
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("order.shippingCompany", "shippingCompany")
      .leftJoinAndSelect("order.store", "store")
      .orderBy("assignment.assignedAt", "ASC") // 🔥 Old → New
      .getOne();

    return orders;
  }

} 