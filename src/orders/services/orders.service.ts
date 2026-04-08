// orders/orders.service.ts
import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
  DataSource,
  Repository,
  In,
  EntityManager,
  Brackets,
  IsNull,
  Not,
  MoreThanOrEqual,
} from "typeorm";
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
  OrderReplacementEntity,
  OrderReplacementItemEntity,
  PaymentMethod,
  OrderScanLogEntity,
  ScanReason,
  ScanLogType,
  ShipmentManifestEntity,
  OrderActionType,
  OrderActionLogEntity,
  OrderActionResult,
  ShipmentManifestType,
  ReturnRequestEntity,
  StockDeductionStrategy,
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
  CreateReplacementDto,
  CreateManifestDto,
} from "dto/order.dto";
import { User } from "entities/user.entity";
import { BulkUploadUsage } from "dto/plans.dto";

import { Notification, NotificationType } from "entities/notifications.entity";
import { OrderFailStatus, StoreEntity } from "entities/stores.entity";
import {
  ShippingCompanyEntity,
  ShippingIntegrationEntity,
} from "entities/shipping.entity";
import { SubscriptionStatus } from "entities/plans.entity";
import { RedisService } from "common/redis/RedisService";
import { ShippingQueueService } from "src/shipping/queues/shipping.queues";
import { WalletService } from "src/wallet/wallet.service";
import { NotificationService } from "src/notifications/notification.service";

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

    @InjectRepository(BulkUploadUsage)
    private usageRepo: Repository<BulkUploadUsage>,

    @InjectRepository(OrderRetrySettingsEntity)
    private retryRepo: Repository<OrderRetrySettingsEntity>,

    @InjectRepository(ShippingCompanyEntity)
    private shippingRepo: Repository<ShippingCompanyEntity>,

    @InjectRepository(ShippingIntegrationEntity)
    private shippingIntegrationRepo: Repository<ShippingIntegrationEntity>,

    @InjectRepository(StoreEntity)
    private storeRepo: Repository<StoreEntity>,

    @InjectRepository(OrderItemEntity)
    private itemRepo: Repository<OrderItemEntity>,

    @InjectRepository(OrderStatusHistoryEntity)
    private historyRepo: Repository<OrderStatusHistoryEntity>,

    @InjectRepository(OrderMessageEntity)
    private messageRepo: Repository<OrderMessageEntity>,

    @InjectRepository(ProductVariantEntity)
    private variantRepo: Repository<ProductVariantEntity>,

    @InjectRepository(OrderScanLogEntity)
    private scanLogRepo: Repository<OrderScanLogEntity>,

    @InjectRepository(ShipmentManifestEntity)
    private manifestRepo: Repository<ShipmentManifestEntity>,

    @InjectRepository(OrderActionLogEntity)
    private orderActionLogRepo: Repository<OrderActionLogEntity>,

    @Inject(forwardRef(() => ShippingQueueService))
    private shippingQueueService: ShippingQueueService,

    @Inject(forwardRef(() => WalletService))
    private walletService: WalletService,

    private notificationService: NotificationService,
    private redisService: RedisService,
  ) { }

  //private function to lock order if he delivered and has monthly closign id
  private async throwIfDelivered(order: OrderEntity, message?: string) {
    const deliveryStatus = await this.statusRepo.findOne({
      where: {
        name: OrderStatus.DELIVERED,
      },
    });

    if (order.statusId === deliveryStatus.id && order.monthlyClosingId) {
      throw new BadRequestException(message || "Cannot update or delete a order that has been closed.");
    }

  }
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
  public async logStatusChange(params: {
    adminId: string;
    orderId: number;
    fromStatusId: number | null; // Changed from Enum to ID
    toStatusId: number; // Changed from Enum to ID
    userId?: number;
    notes?: string;
    ipAddress?: string;
    manager: EntityManager; // Removed optional '?' because getRepository needs it
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
      .createQueryBuilder("status")
      // use relation path only (no join condition)
      .leftJoin("status.orders", "o")
      .select([
        "status.id AS id",
        "status.name AS name",
        "status.code AS code",
        "status.color  AS color",
        "status.system AS system",
        "status.sortOrder AS sortOrder",
      ])
      .addSelect("COUNT(o.id)", "count")
      .where(
        new Brackets((qb) => {
          qb.where("status.adminId = :adminId", { adminId }).orWhere(
            "status.system = :system",
            { system: true },
          );
        }),
      )
      // GROUP BY every non-aggregated selected column (Postgres requires this)
      .groupBy("status.id")
      .addGroupBy("status.name")
      .addGroupBy("status.code")
      .addGroupBy("status.color")
      .addGroupBy("status.system")
      .addGroupBy("status.sortOrder")
      .orderBy("status.sortOrder", "ASC")
      .getRawMany();

    return stats.map((stat) => ({
      ...stat,
      id: Number(stat.id),
      count: Number(stat.count) || 0,
      system: stat.system || stat.system,
    }));
  }
  async getStatuses(me: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const statuses = await this.statusRepo
      .createQueryBuilder("status")
      .select([
        "status.id AS id",
        "status.name AS name",
        "status.code AS code",
        "status.color  AS color",
        "status.system AS system",
        "status.sortOrder AS sortOrder",
      ])
      .where(
        new Brackets((qb) => {
          qb.where("status.adminId = :adminId", { adminId }).orWhere(
            "status.system = :system",
            { system: true },
          );
        }),
      )
      .orderBy("status.sortOrder", "ASC")
      .getRawMany();

    return statuses;
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
      .leftJoinAndSelect("order.rejectedBy", "rejectedBy")
      .leftJoinAndSelect("order.items", "items")
      .leftJoinAndSelect("items.variant", "variant")
      .leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("order.shippingCompany", "shipping")
      .leftJoinAndSelect("order.store", "store")
      .leftJoinAndSelect(
        "order.assignments",
        "assignment",
        "assignment.isAssignmentActive = true",
      )
      .leftJoinAndSelect("assignment.employee", "employee");

    // Allowed columns mapping
    const sortColumns: Record<string, string> = {
      createdAt: "order.created_at",
      orderNumber: "order.orderNumber",
    };

    if (q?.userId) {
      qb.andWhere("assignment.employeeId = :userId", {
        userId: Number(q.userId),
      });
    }

    // Filters
    // Status: accept numeric id or status code string, or comma separated list of codes
    if (q?.status) {
      const statusParam = q.status;
      if (typeof statusParam === "string" && statusParam.includes(",")) {
        const statusCodes = statusParam.split(",").map((s) => s.trim());
        qb.andWhere("status.code IN (:...statusCodes)", { statusCodes });
      } else if (!isNaN(Number(statusParam))) {
        qb.andWhere("order.statusId = :statusId", {
          statusId: Number(statusParam),
        });
      } else {
        qb.andWhere("status.code = :statusCode", {
          statusCode: String(statusParam).trim(),
        });
      }
    }
    if (q?.paymentStatus) {
      if (q?.paymentStatus === PaymentMethod.CASH_ON_DELIVERY) {
        qb.andWhere("order.paymentMethod = :paymentMethod", {
          paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        });
      } else {
        qb.andWhere("order.paymentStatus = :paymentStatus", {
          paymentStatus: q.paymentStatus,
        });
      }
    }
    // if (q?.paymentMethod) qb.andWhere("order.paymentMethod = :paymentMethod", { paymentMethod: q.paymentMethod });
    // Shipping Company Filter
    if (q?.shippingCompanyId && q.shippingCompanyId !== "all") {
      if (q.shippingCompanyId === "none") {
        qb.andWhere("order.shippingCompanyId IS NULL");
      } else if (q.shippingCompanyId !== "all") {
        qb.andWhere("order.shippingCompanyId = :shippingCompanyId", {
          shippingCompanyId: Number(q.shippingCompanyId),
        });
      }
    }

    // Store Filter
    if (q?.storeId) {
      if (q.storeId === "none") {
        qb.andWhere("order.storeId IS NULL");
      } else if (q.storeId !== "all") {
        qb.andWhere("order.storeId = :storeId", {
          storeId: Number(q.storeId),
        });
      }
    }

    // Product Filter
    if (q?.productId && q.productId !== "all") {
      qb.andWhere("variant.productId = :productId", {
        productId: Number(q.productId),
      });
    }

    // Label Printed Filter
    if (q?.labelPrinted !== undefined && q.labelPrinted !== "all") {
      if (q.labelPrinted === "true" || q.labelPrinted === true) {
        qb.andWhere("order.labelPrinted IS NOT NULL");
      } else if (q.labelPrinted === "false" || q.labelPrinted === false) {
        qb.andWhere("order.labelPrinted IS NULL");
      }
    }

    // Date range
    if (q?.startDate)
      qb.andWhere("order.created_at >= :startDate", {
        startDate: `${q.startDate}T00:00:00.000Z`,
      });
    if (q?.endDate)
      qb.andWhere("order.created_at <= :endDate", {
        endDate: `${q.endDate}T23:59:59.999Z`,
      });

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

    if (q?.hasReplacement !== undefined) {
      qb.leftJoin("order.replacementRequest", "replacementRequest");

      if (q.hasReplacement === "false" || q.hasReplacement === false) {
        qb.andWhere("replacementRequest.id IS NULL");
      } else if (q.hasReplacement === "true" || q.hasReplacement === true) {
        qb.andWhere("replacementRequest.id IS NOT NULL");
      }
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

    if (q?.status === OrderStatus.CONFIRMED && records.length > 0) {
      await this.shippingQueueService.attachIsAssigningState(records);
    }

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }
  async listManifests(me: any, q?: any) {
    const adminId = tenantId(me);
    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? "").trim();
    const type = q?.type;
    const qb = this.manifestRepo
      .createQueryBuilder("manifest")
      .leftJoinAndSelect("manifest.shippingCompany", "shippingCompany")
      .leftJoinAndSelect("manifest.orders", "orders")
      .leftJoin("orders.items", "items")
      // ✅ FIX: Use the relation path "items.variant" instead of just "items"
      .leftJoin("items.variant", "variant")
      .leftJoinAndSelect("orders.lastReturn", "lastReturn")
      .leftJoinAndSelect("lastReturn.items", "returnItems")
      .select([
        "manifest",
        "shippingCompany", // Selects the whole joined entity
        "orders.id",
        "orders.orderNumber",
        "orders.failedScanCounts",
        "items.id",
        "variant.id",
        "variant.sku",
        "items.quantity",
        "lastReturn",
        "returnItems",
      ])
      .where("manifest.adminId = :adminId", { adminId });

    // Filter: Shipping Company
    if (q?.shippingCompanyId && q.shippingCompanyId !== "all") {
      qb.andWhere("manifest.shippingCompanyId = :coId", {
        coId: q.shippingCompanyId,
      });
    }
    if (type && type !== "all") {
      qb.andWhere("manifest.type = :manifestType", {
        manifestType: type.trim(), // تذكر دائماً عمل trim للقيم النصية كما طلبت
      });
    }
    // Filter: Is Printed
    if (q?.isPrinted !== undefined && q.isPrinted !== "all") {
      if (q.isPrinted === "true")
        qb.andWhere("manifest.lastPrintedAt IS NOT NULL");
      else qb.andWhere("manifest.lastPrintedAt IS NULL");
    }

    // Search: Manifest Number or Driver Name
    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("manifest.manifestNumber ILIKE :s", {
            s: `%${search}%`,
          }).orWhere("manifest.driverName ILIKE :s", { s: `%${search}%` });
        }),
      );
    }

    const [records, total] = await qb
      .orderBy("manifest.createdAt", "DESC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { total_records: total, records };
  }

  async markAsPrinted(id: number, me: any) {
    const adminId = tenantId(me);
    const userId = me.id;

    const settings = await this.getSettings(me);

    // Wrap everything in a transaction to ensure manifest update and status logs are atomic
    return await this.dataSource.transaction(async (manager) => {
      // 1. Get repositories scoped to this manager
      const manifestRepo = manager.getRepository(ShipmentManifestEntity);
      const orderRepo = manager.getRepository(OrderEntity);
      const statusHistoryRepo = manager.getRepository(OrderStatusHistoryEntity);

      // 2. Check if manifest exists
      const manifest = await manifestRepo.findOne({
        where: { id, adminId },
        relations: ["orders"], // Assuming you need the orders tied to this manifest
      });

      if (!manifest) {
        throw new NotFoundException(`Manifest with ID ${id} not found.`);
      }
      const orderIds = manifest.orders.map((o) => o.id);
      const isReturn = manifest.type === ShipmentManifestType.RETURN;
      const manifestLabel = isReturn ? "Return Manifest" : "Shipping Waybill";
      // [2025-12-24] Trim applied to manifest number for notes
      const manifestNumber = manifest.manifestNumber?.trim();

      if (!manifest.lastPrintedAt) {
        if (manifest.type === ShipmentManifestType.SHIPPING) {
          const packedStatus = await this.findStatusByCode(
            OrderStatus.PACKED,
            adminId,
            manager,
          );
          const shippedStatus = await this.findStatusByCode(
            OrderStatus.SHIPPED,
            adminId,
            manager,
          );

          if (orderIds.length > 0) {
            // Fetch full orders with items to use the deduction method
            const ordersToUpdate = await manager.getRepository(OrderEntity).find({
              where: { id: In(orderIds), adminId },
              relations: ["items", "items.variant"],
            });

            for (const order of ordersToUpdate) {
              // Deduct stock only if strategy is ON_SHIPMENT
              if (
                settings.stockDeductionStrategy ===
                StockDeductionStrategy.ON_SHIPMENT
              ) {
                await this.deductStockForOrder(manager, order);
              }
            }

            await orderRepo.update(orderIds, {
              statusId: shippedStatus.id,
              shippedAt: new Date(),
            });

            const statusLogs = orderIds.map((orderId) => ({
              adminId,
              orderId,
              fromStatusId: packedStatus.id,
              toStatusId: shippedStatus.id,
              userId: userId,
              notes: `Bulk assigned to Manifest: ${manifestNumber}`,
              createdAt: new Date(),
            }));

            await statusHistoryRepo.insert(statusLogs);
          }
        } else if (manifest.type === ShipmentManifestType.RETURN) {
          const preparingStatus = await this.findStatusByCode(
            OrderStatus.RETURN_PREPARING,
            adminId,
            manager,
          );
          const returnedStatus = await this.findStatusByCode(
            OrderStatus.RETURNED,
            adminId,
            manager,
          );

          // 2. Update the Parent Orders
          await orderRepo.update(orderIds, {
            statusId: returnedStatus.id,
            returnedAt: new Date(),
            returnedById: userId,
            updatedByUserId: userId,
            manifestId: manifest.id, // Ensure manifest linkage is saved
          });

          // 3. Create Status Logs (Fixed from/to logic)
          const statusLogs = orderIds.map((orderId) => ({
            adminId,
            orderId,
            fromStatusId: preparingStatus.id, // ✅ Correct: coming from Preparing
            toStatusId: returnedStatus.id, // ✅ Correct: moving to Returned
            userId: userId,
            notes: `Added to Return Manifest: ${manifestNumber}`,
            createdAt: new Date(),
          }));

          await statusHistoryRepo.insert(statusLogs);
        }

        await this.logBulkOrderActions({
          manager,
          adminId,
          userId,
          orderIds,
          actionType: OrderActionType.MANIFEST_PRINTED,
          result: OrderActionResult.SUCCESS,
          details: `Initial ${manifestLabel} printed. Manifest: ${manifestNumber}`, // ✅ Dynamic
        });
      } else {
        // 3. Logic for re-printing (already printed)
        await this.logBulkOrderActions({
          manager,
          adminId,
          userId,
          orderIds,
          actionType: OrderActionType.MANIFEST_REPRINTED,
          result: OrderActionResult.SUCCESS,
          details: `${manifestLabel} re-printed.`, // ✅ Dynamic
        });
      }

      // 3. Update Manifest Print Date
      const now = new Date();
      await manifestRepo.update(id, {
        lastPrintedAt: now,
      });

      return {
        success: true,
        lastPrintedAt: now,
      };
    });
  }

  async listMyAssignedOrders(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const myUserId = me?.id;
    if (!myUserId) throw new BadRequestException("Missing user ID");

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? "").trim();

    const sortBy = String(q?.sortBy ?? "createdAt");
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const qb = this.orderRepo
      .createQueryBuilder("order")
      .where("order.adminId = :adminId", { adminId })

      // 🔥 IMPORTANT: only my active assignments
      .innerJoinAndSelect(
        "order.assignments",
        "assignment",
        "assignment.isAssignmentActive = true AND assignment.employeeId = :myUserId",
        { myUserId },
      )

      .leftJoinAndSelect("order.items", "items")
      .leftJoinAndSelect("items.variant", "variant")
      .leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("order.shippingCompany", "shipping")
      .leftJoinAndSelect("order.store", "store")
      .leftJoinAndSelect("assignment.employee", "employee");

    // Allowed sorting columns
    const sortColumns: Record<string, string> = {
      createdAt: "order.created_at",
      orderNumber: "order.orderNumber",
    };

    // Filters
    if (q?.status) {
      const statusParam = q.status;
      if (!isNaN(Number(statusParam))) {
        qb.andWhere("order.statusId = :statusId", {
          statusId: Number(statusParam),
        });
      } else {
        qb.andWhere("status.code = :statusCode", {
          statusCode: String(statusParam).trim(),
        });
      }
    }
    if (q?.type) {
      qb.andWhere("order.type = :type", { type: q.type });
    }
    if (q?.paymentStatus)
      qb.andWhere("order.paymentStatus = :paymentStatus", {
        paymentStatus: q.paymentStatus,
      });

    if (q?.paymentMethod)
      qb.andWhere("order.paymentMethod = :paymentMethod", {
        paymentMethod: q.paymentMethod,
      });

    if (q?.shippingCompanyId)
      qb.andWhere("order.shippingCompanyId = :shippingCompanyId", {
        shippingCompanyId: Number(q.shippingCompanyId),
      });

    if (q?.storeId)
      qb.andWhere("order.storeId = :storeId", {
        storeId: Number(q.storeId),
      });

    // Date range
    if (q?.startDate)
      qb.andWhere("order.created_at >= :startDate", {
        startDate: `${q.startDate}T00:00:00.000Z`,
      });

    if (q?.endDate)
      qb.andWhere("order.created_at <= :endDate", {
        endDate: `${q.endDate}T23:59:59.999Z`,
      });

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

    // Sorting
    if (sortColumns[sortBy]) {
      qb.orderBy(sortColumns[sortBy], sortDir);
    } else {
      qb.orderBy("order.created_at", "DESC");
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
  async listLogs(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? "").trim();

    const sortBy = String(q?.sortBy ?? "createdAt");
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const qb = this.dataSource
      .getRepository(OrderActionLogEntity)
      .createQueryBuilder("log")
      .leftJoinAndSelect("log.order", "order")
      .leftJoinAndSelect("order.status", "status") // Current order status
      .leftJoinAndSelect("log.shippingCompany", "shipping")
      .leftJoinAndSelect("log.user", "user") // The employee who performed the action
      .where("log.adminId = :adminId", { adminId });

    // 1. Filter by Action Type (Enum: WAYBILL_PRINTED, REJECTED, etc.)
    if (q?.actionType) {
      const types = Array.isArray(q.actionType)
        ? q.actionType
        : String(q.actionType).split(",");
      qb.andWhere("log.actionType IN (:...types)", { types });
    }

    // 2. Filter by Result (Enum: SUCCESS, FAILED, WARNING)
    if (q?.result) {
      qb.andWhere("log.result = :result", { result: q.result });
    }

    // 3. Filter by Shipping Company
    if (q?.shippingCompanyId) {
      qb.andWhere("log.shippingCompanyId = :shippingCompanyId", {
        shippingCompanyId: Number(q.shippingCompanyId),
      });
    }

    // 4. Filter by Employee (User)
    if (q?.userId) {
      qb.andWhere("log.userId = :userId", { userId: Number(q.userId) });
    }

    // 5. Date Range Filter
    if (q?.startDate) {
      qb.andWhere("log.createdAt >= :startDate", {
        startDate: `${q.startDate}T00:00:00.000Z`,
      });
    }
    if (q?.endDate) {
      qb.andWhere("log.createdAt <= :endDate", {
        endDate: `${q.endDate}T23:59:59.999Z`,
      });
    }

    // 6. Search (Order Number or Operation ID)
    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("log.operationNumber ILIKE :s", { s: `%${search}%` })
            .orWhere("order.orderNumber ILIKE :s", { s: `%${search}%` })
            .orWhere("log.details ILIKE :s", { s: `%${search}%` });
        }),
      );
    }

    // Sorting
    const sortColumns: Record<string, string> = {
      createdAt: "log.createdAt",
      operationNumber: "log.operationNumber",
      orderNumber: "order.orderNumber",
    };

    qb.orderBy(sortColumns[sortBy] || "log.createdAt", sortDir);

    const [records, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  async exportLogs(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const search = String(q?.search ?? "").trim();

    // 1. Setup Query Builder (Same relations as listLogs)
    const qb = this.dataSource
      .getRepository(OrderActionLogEntity)
      .createQueryBuilder("log")
      .leftJoinAndSelect("log.order", "order")
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("log.shippingCompany", "shipping")
      .leftJoinAndSelect("log.user", "user")
      .where("log.adminId = :adminId", { adminId });

    // 2. Apply Filters
    if (q?.actionType) {
      const types = Array.isArray(q.actionType)
        ? q.actionType
        : String(q.actionType).split(",");
      qb.andWhere("log.actionType IN (:...types)", { types });
    }

    if (q?.result) {
      qb.andWhere("log.result = :result", { result: q.result });
    }

    if (q?.shippingCompanyId) {
      qb.andWhere("log.shippingCompanyId = :shippingCompanyId", {
        shippingCompanyId: Number(q.shippingCompanyId),
      });
    }

    if (q?.userId) {
      qb.andWhere("log.userId = :userId", { userId: Number(q.userId) });
    }

    if (q?.startDate) {
      qb.andWhere("log.createdAt >= :startDate", {
        startDate: `${q.startDate}T00:00:00.000Z`,
      });
    }
    if (q?.endDate) {
      qb.andWhere("log.createdAt <= :endDate", {
        endDate: `${q.endDate}T23:59:59.999Z`,
      });
    }

    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("log.operationNumber ILIKE :s", { s: `%${search}%` })
            .orWhere("order.orderNumber ILIKE :s", { s: `%${search}%` })
            .orWhere("log.details ILIKE :s", { s: `%${search}%` });
        }),
      );
    }

    // 3. Sort and Execute (No pagination)
    qb.orderBy("log.createdAt", "DESC");
    const logs = await qb.getMany();

    const actionTypeTranslations: Record<string, string> = {
      CONFIRMED: "تأكيد الطلب",
      COURIER_ASSIGNED: "إسناد لشركة الشحن",
      WAYBILL_PRINTED: "طباعة البوليصة",
      WAYBILL_REPRINTED: "إعادة طباعة البوليصة",
      PREPARATION_STARTED: "إتمام التجهيز والجمع",
      OUTGOING_DISPATCHED: "تسليم للشحن (بيان تحميل)",
      REJECTED: "رفض الطلب",
      RETURN_RECEIVED: "استلام مرتجع",
      RETRY_ATTEMPT: "إعادة المحاولة",
    };

    const resultTranslations: Record<string, string> = {
      SUCCESS: "تم بنجاح",
      FAILED: "فشل / خطأ",
      WARNING: "تنبيه / تكرار",
      PENDING: "قيد الانتظار",
    };

    // 5. Prepare Data
    const exportData = logs.map((log) => {
      return {
        operationNumber: log.operationNumber || "N/A",
        orderNumber: log.order?.orderNumber || "N/A",
        actionType: log.actionType
          ? actionTypeTranslations[log.actionType] || log.actionType
          : "N/A",
        result: log.result
          ? resultTranslations[log.result] || log.result
          : "N/A",
        employee: log.user
          ? `${log.user.name || "N/A"} (ID: ${log.user.id})`
          : "System",
        shippingCompany: log.shippingCompany?.name || "N/A",
        currentOrderStatus:
          log.order?.status?.code || log.order?.status?.name || "N/A",
        details: log.details || "N/A",
        createdAt: log.createdAt
          ? new Date(log.createdAt).toLocaleString("en-GB")
          : "N/A",
      };
    });

    // 6. Create Workbook (Following your exact working structure)
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Operational Logs");

    const columns = [
      { header: "Operation ID", key: "operationNumber", width: 25 },
      { header: "Order Number", key: "orderNumber", width: 18 },
      { header: "Action", key: "actionType", width: 25 },
      { header: "Result", key: "result", width: 15 },
      { header: "Performed By", key: "employee", width: 25 },
      { header: "Shipping Company", key: "shippingCompany", width: 20 },
      { header: "Status", key: "currentOrderStatus", width: 15 },
      { header: "Details", key: "details", width: 45 },
      { header: "Created At", key: "createdAt", width: 20 },
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

    // 7. Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }

  // shipment-manifest.service.ts

  async createManifest(dto: CreateManifestDto, me: any) {
    const adminId = tenantId(me);
    const userId = me.id;

    return await this.dataSource.transaction(async (manager) => {
      // const [packedStatus, shippedStatus] = await Promise.all([
      //   manager.findOneBy(OrderStatusEntity, { code: OrderStatus.PACKED }),
      //   manager.findOneBy(OrderStatusEntity, { code: OrderStatus.SHIPPED }),
      // ]);
      const orderRepo = manager.getRepository(OrderEntity);
      // 1. Validate Orders (Status must be PACKED and match Shipping Company)
      const orders = await manager.find(OrderEntity, {
        where: { id: In(dto.orderIds), adminId },
        relations: ["status"],
      });

      if (orders.length !== dto.orderIds.length) {
        throw new BadRequestException("Some orders were not found.");
      }

      for (const order of orders) {
        if (order.status.code !== OrderStatus.PACKED) {
          throw new BadRequestException(
            `Order ${order.orderNumber} cannot be shipped. Current status: ${order.status.name}. It must be PACKED first.`,
          );
        }

        if (order.shippingCompanyId !== dto.shippingCompanyId) {
          throw new BadRequestException(
            `Order ${order.orderNumber} belongs to a different courier.`,
          );
        }
        if (order.manifestId) {
          throw new BadRequestException(
            `Order ${order.orderNumber} is already on another manifest.`,
          );
        }
      }

      // 2. Generate Manifest Number (e.g., MAN-20260316-001)
      const dateStr = new Date().toISOString().split("T")[0].replace(/-/g, "");
      const count = await manager.count(ShipmentManifestEntity, {
        where: { adminId },
      });
      const manifestNumber = `MAN-${dateStr}-${(count + 1).toString().padStart(3, "0")}`;

      // 3. Create Manifest
      const manifest = manager.create(ShipmentManifestEntity, {
        adminId,
        manifestNumber,
        shippingCompanyId: dto.shippingCompanyId,
        driverName: dto.driverName,
        type: ShipmentManifestType.SHIPPING,
        changedByUserId: userId,
        totalOrders: orders.length,
      });

      const savedManifest = await manager.save(manifest);
      await orderRepo.update(dto.orderIds, {
        manifestId: manifest.id,
        updatedByUserId: userId,
      });
      await this.logBulkOrderActions({
        manager,
        adminId,
        userId,
        orderIds: dto.orderIds, // Passes array of {id, orderNumber}
        actionType: OrderActionType.OUTGOING_DISPATCHED,
        result: OrderActionResult.SUCCESS,
        shippingCompanyId: dto.shippingCompanyId,
        details: `Order dispatched. Manifest: ${manifestNumber}. Driver: ${dto.driverName || "N/A"}`,
      });

      return savedManifest;
    });
  }

  async createReturnManifest(dto: CreateManifestDto, me: any) {
    const adminId = tenantId(me);
    const userId = me.id;

    return await this.dataSource.transaction(async (manager) => {
      const returnRepo = manager.getRepository(ReturnRequestEntity);
      const manifestRepo = manager.getRepository(ShipmentManifestEntity);
      const orderRepo = manager.getRepository(OrderEntity);

      // 1. Fetch the requests and their associated orders
      const returns = await returnRepo.find({
        where: { adminId, orderId: In(dto.orderIds) },
        relations: ["order"],
      });

      if (returns.length === 0) {
        throw new BadRequestException("No valid return requests selected.");
      }

      const invalidOrders = returns.filter(
        (o) => o.order.status.code !== OrderStatus.RETURN_PREPARING,
      );

      if (invalidOrders.length > 0) {
        // ✅ 3. LOG ACTION FAIL for every invalid order
        await Promise.all(
          invalidOrders.map((o) =>
            this.logOrderAction({
              manager,
              adminId,
              userId,
              orderId: o.id,
              actionType: OrderActionType.MANIFEST_PRINTED, // Tracking manifest attempt
              result: OrderActionResult.FAILED,
              details: `Failed to add to manifest. Reason: Order is in ${o.order.status.code} but must be RETURN_PREPARING.`,
            }),
          ),
        );

        const nums = invalidOrders.map((o) => o.order.orderNumber).join(", ");
        throw new BadRequestException(
          `The following orders are not in 'Return Preparing' status: ${nums}`,
        );
      }

      for (const ret of returns) {
        const order = ret.order;

        // التحقق من شركة الشحن
        if (order.shippingCompanyId !== dto.shippingCompanyId) {
          throw new BadRequestException(
            `Order ${order.orderNumber} belongs to a different courier.`
          );
        }

        if (order.manifestId) {
          throw new BadRequestException(
            `Order ${order.orderNumber} is already on another return manifest.`
          );
        }
      }



      // [2025-12-24] Generate a clean, trimmed manifest number
      const dateStr = new Date().toISOString().split("T")[0].replace(/-/g, "");
      const manifestNumber =
        `RET-MAN-${dateStr}-${Math.floor(Math.random() * 1000)}`.trim();

      // 2. Create the Manifest Record
      const manifest = await manifestRepo.save({
        adminId,
        manifestNumber,
        shippingCompanyId: dto.shippingCompanyId,
        driverName: dto.driverName,
        type: ShipmentManifestType.RETURN,
        changedByUserId: userId,
        totalOrders: returns.length,
      });

      const orderIds = returns.map((req) => req.orderId);
      await orderRepo.update(orderIds, {
        manifestId: manifest.id,
        updatedByUserId: userId,
      });
      await this.logBulkOrderActions({
        manager,
        adminId,
        userId,
        orderIds,
        actionType: OrderActionType.MANIFEST_PRINTED,
        result: OrderActionResult.SUCCESS,
        details: `Order included in Return Manifest: ${manifestNumber}`,
      });

      return {
        success: true,
        manifestId: manifest.id,
        manifestNumber,
        count: returns.length,
      };
    });
  }

  async getManifestDetail(id: number, me: any) {
    const adminId = tenantId(me);

    const manifest = await this.manifestRepo.findOne({
      where: { id, adminId },
      relations: [
        "shippingCompany",
        "changedByUser",
        "orders",
        "orders.items",
        "orders.items.variant",
        "orders.items.variant.product",
        "orders.lastReturn",
        "orders.lastReturn.items",
        "orders.lastReturn.items.returnedVariant",
        "orders.lastReturn.items.returnedVariant.product",
      ],
    });

    if (!manifest) throw new NotFoundException("Manifest not found");
    return manifest;
  }

  async getReturnsSummaryStats(me: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    // 1. Setup Date Boundaries
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );

    // 2. Fetch required status IDs (Adjust codes based on your OrderStatus enum)
    const [shippedStatus, returnedStatus] = await Promise.all([
      this.findStatusByCode(OrderStatus.SHIPPED, adminId),
      this.findStatusByCode(OrderStatus.RETURNED, adminId),
    ]);

    // 3. Execute queries concurrently
    const [withCarrier, returnedToday, totalReturns, returnFiles] =
      await Promise.all([
        // Orders currently with the shipping company (Shipped but not yet returned/delivered)
        this.orderRepo.count({
          where: { adminId, statusId: shippedStatus?.id },
        }),

        // Orders that moved to 'RETURNED' status today
        this.orderRepo.count({
          where: {
            adminId,
            statusId: returnedStatus?.id,
            updated_at: MoreThanOrEqual(startOfToday),
          },
        }),

        // All-time returned orders
        this.orderRepo.count({
          where: { adminId, statusId: returnedStatus?.id },
        }),

        // Count of Manifests marked as 'RETURN' type
        this.manifestRepo.count({
          where: { adminId, type: ShipmentManifestType.RETURN },
        }),
      ]);

    return {
      withCarrier,
      returnedToday,
      totalReturns,
      returnFiles,
    };
  }

  async getShippingSummary(me: any) {
    const adminId = tenantId(me);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    //
    const [readyStatus, shippedStatus] = await Promise.all([
      this.findStatusByCode(OrderStatus.READY, adminId),
      this.findStatusByCode(OrderStatus.PACKED, adminId),
      this.findStatusByCode(OrderStatus.SHIPPED, adminId),
    ]);

    const [readyForShipment, deliveryFiles, shippedToday, totalShippedEver] =
      await Promise.all([
        this.orderRepo.count({ where: { adminId, statusId: readyStatus?.id } }),

        this.manifestRepo.count({
          where: { adminId, type: ShipmentManifestType.SHIPPING },
        }),

        this.orderRepo.count({
          where: {
            adminId,
            statusId: shippedStatus?.id,
            shippedAt: MoreThanOrEqual(todayStart),
          },
        }),

        this.orderRepo.count({
          where: { adminId, statusId: shippedStatus?.id },
        }),
      ]);

    return {
      readyForShipment,
      deliveryFiles,
      shippedToday,
      totalShippedEver,
    };
  }

  async getPrintLifecycleStats(me: any) {
    const adminId = tenantId(me);

    const [distributedStatus, preparingStatus] = await Promise.all([
      this.findStatusByCode(OrderStatus.DISTRIBUTED.trim(), adminId),
      this.findStatusByCode(OrderStatus.PRINTED.trim(), adminId),
    ]);

    const [totalDistributed, printed, notPrinted] = await Promise.all([
      this.orderRepo.count({
        where: {
          adminId,
          statusId: distributedStatus?.id,
        },
      }),
      this.orderRepo.count({
        where: {
          adminId,
          statusId: preparingStatus?.id,
          labelPrinted: Not(IsNull()),
        },
      }),
      this.orderRepo.count({
        where: {
          adminId,
          statusId: distributedStatus?.id,
          labelPrinted: IsNull(),
        },
      }),
    ]);

    return {
      totalDistributed,
      printed,
      notPrinted,
    };
  }

  async getRejectedOrdersStats(me: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    //
    const rejectedStatus = await this.findStatusByCode(
      OrderStatus.REJECTED,
      adminId,
    );
    if (!rejectedStatus) {
      return { totalRejected: 0, rejectedToday: 0, rejectedThisWeek: 0 };
    }

    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );

    const startOfWeek = new Date(startOfToday);
    const dayOfWeek = startOfToday.getDay();

    const diffToSaturday = dayOfWeek === 6 ? 0 : dayOfWeek + 1;
    startOfWeek.setDate(startOfToday.getDate() - diffToSaturday);

    const [totalRejected, rejectedToday, rejectedThisWeek] = await Promise.all([
      this.orderRepo.count({
        where: {
          adminId,
          statusId: rejectedStatus.id,
          rejectedAt: Not(IsNull()),
        },
      }),
      this.orderRepo.count({
        where: {
          adminId,
          statusId: rejectedStatus.id,
          rejectedAt: MoreThanOrEqual(startOfToday),
        },
      }),
      this.orderRepo.count({
        where: {
          adminId,
          statusId: rejectedStatus.id,
          rejectedAt: MoreThanOrEqual(startOfWeek),
        },
      }),
    ]);

    return {
      totalRejected,
      rejectedToday,
      rejectedThisWeek,
    };
  }
  async getLogOperationalStats(
    me: any,
    q?: { startDate?: string; endDate?: string },
  ) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const qb = this.dataSource
      .getRepository(OrderActionLogEntity)
      .createQueryBuilder("log")
      .where("log.adminId = :adminId", { adminId });

    // Perform a single query to get all counts at once
    const stats = await qb
      .select("COUNT(log.id)", "total")
      .addSelect(
        `COUNT(CASE WHEN log.result = '${OrderActionResult.SUCCESS}' THEN 1 END)`,
        "successCount",
      )
      .addSelect(
        `COUNT(CASE WHEN log.result = '${OrderActionResult.FAILED}' THEN 1 END)`,
        "failedCount",
      )
      .getRawOne();

    const total = parseInt(stats.total || "0", 10);
    const success = parseInt(stats.successCount || "0", 10);
    const failed = parseInt(stats.failedCount || "0", 10);

    // Calculate Success Rate safely
    const successRate =
      total > 0 ? parseFloat(((success / total) * 100).toFixed(2)) : 0;

    return {
      totalOperations: total,
      successCount: success,
      failedCount: failed,
      rawSuccessRate: successRate,
    };
  }

  async bulkPrint(me: any, orderNumbers: string[]) {
    const adminId = tenantId(me);
    const userId = me?.id;

    const settings = await this.getSettings(me);

    return await this.dataSource.transaction(async (manager) => {
      // 1. Fetch orders to get IDs and current Status (needed for logs)
      const orders = await manager.find(OrderEntity, {
        where: { adminId, orderNumber: In(orderNumbers) },
        relations: ["items", "items.variant"],
        select: ["id", "statusId", "orderNumber"],
      });

      if (orders.length === 0)
        return { success: false, message: "No orders found" };

      const orderIds = orders.map((o) => o.id);

      // 2. Fetch the PRINTED status entity
      const printedStatus = await this.findStatusByCode(
        OrderStatus.PRINTED,
        adminId,
        manager,
      );
      if (!printedStatus) throw new Error("PRINTED status not configured");

      // 3. Deduct stock if strategy is ON_SHIPMENT (printing usually means ready to ship)
      if (settings.stockDeductionStrategy === StockDeductionStrategy.ON_SHIPMENT) {
        await this.deductStockForMultipleOrders(manager, orders);
      }

      const newPrintOrders = [];
      const reprintOrders = [];

      orders.forEach((order) => {
        // If status is already PRINTED or further in the workflow, it's a reprint
        if (order.statusId === printedStatus.id) {
          reprintOrders.push(order);
        } else {
          newPrintOrders.push(order);
        }
      });
      // 3. Perform Bulk Update
      await manager.update(
        OrderEntity,
        { id: In(orderIds), adminId },
        {
          labelPrinted: new Date(),
          statusId: printedStatus.id,
        },
      );

      // 4. ✅ Log the Operational Movement (Bulk)
      // This creates the "OP-XXXXX" entries for the "Waybill Printed" action
      if (newPrintOrders.length > 0) {
        await this.logBulkOrderActions({
          manager,
          adminId,
          userId,
          orderIds,
          actionType: OrderActionType.WAYBILL_PRINTED,
          result: OrderActionResult.SUCCESS,
          details: "Initial waybill printed.",
        });
      }

      // 5. ✅ Log Reprints (Action: WAYBILL_REPRINTED, Result: WARNING)
      if (reprintOrders.length > 0) {
        await this.logBulkOrderActions({
          manager,
          adminId,
          userId,
          orderIds,
          actionType: OrderActionType.WAYBILL_REPRINTED,
          result: OrderActionResult.SUCCESS,
          details: "Waybill re-printed.",
        });
      }
      // 5. ✅ Log the Status Change Timeline (Bulk)
      // We map these to a single insert to maintain high performance
      const statusLogs = orders.map((order) => ({
        adminId,
        orderId: order.id,
        fromStatusId: order.statusId,
        toStatusId: printedStatus.id,
        userId: userId,
        notes: "Waybill printed",
        createdAt: new Date(),
      }));

      await manager.insert(OrderStatusHistoryEntity, statusLogs);

      return { success: true, count: orders.length };
    });
  }

  async getPreparationStats(me: any) {
    const adminId = tenantId(me);

    const [printedStatus, preparingStatus] = await Promise.all([
      this.findStatusByCode(OrderStatus.PRINTED, adminId),
      this.findStatusByCode(OrderStatus.PREPARING, adminId),
    ]);

    const printedId = printedStatus?.id;
    const preparingId = preparingStatus?.id;

    const [scanning, notStarted] = await Promise.all([
      this.orderRepo.count({ where: { adminId, statusId: preparingId } }),
      this.orderRepo.count({ where: { adminId, statusId: printedId } }),
    ]);

    return {
      scanning,
      notStarted,
      total: scanning + notStarted,
    };
  }

  async scanItem(orderId: number, sku: string, me: any) {
    const userId = me?.id;
    const adminId = tenantId(me);

    return await this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(OrderEntity, {
        where: { id: orderId, adminId },
        relations: ["items", "items.variant", "status"],
        select: ["id", "statusId", "adminId"],
      });

      if (!order) throw new NotFoundException("Order not found");
      const oldStatusId = order.statusId;
      const allowedStatuses = [OrderStatus.PRINTED, OrderStatus.PREPARING];

      if (!allowedStatuses.includes(order.status.code as OrderStatus)) {
        await this.logFailedScan(
          manager,
          orderId,
          sku,
          userId,
          adminId,
          ScanReason.INVALID_STATUS,
          ScanLogType.PREPARATION,
          `Current: ${order.status.code}`,
        );
        return {
          success: false,
          message: "Order must be Printed or Preparing",
        };
      }

      if (order.status?.code === OrderStatus.PRINTED) {
        const preparingStatus = await manager.findOneBy(OrderStatusEntity, {
          code: OrderStatus.PREPARING,
        });
        await manager.update(OrderEntity, order.id, {
          statusId: preparingStatus.id,
        });
        await this.logStatusChange({
          adminId,
          orderId: order.id,
          fromStatusId: oldStatusId,
          toStatusId: preparingStatus.id,
          userId,
          notes: "Automatic: Picking started via scan",
          manager,
        });

        order.statusId = preparingStatus.id;
      }

      const item = order.items.find(
        (i) => i.variant?.sku?.trim() === sku.trim(),
      );

      if (!item) {
        await this.logFailedScan(
          manager,
          orderId,
          sku,
          userId,
          adminId,
          ScanReason.SKU_NOT_IN_ORDER,
          ScanLogType.PREPARATION,
        );
        return { success: false, message: `SKU ${sku} not in order` };
      }

      if (item.scannedQuantity >= item.quantity) {
        await this.logFailedScan(
          manager,
          orderId,
          sku,
          userId,
          adminId,
          ScanReason.ALREADY_FULLY_SCANNED,
          ScanLogType.PREPARATION,
        );
        return { success: false, message: "Item already fully scanned" };
      }

      item.scannedQuantity += 1;
      await manager.save(item);

      const isOrderComplete = order.items.every(
        (i) => i.scannedQuantity >= i.quantity,
      );
      if (isOrderComplete) {
        // Use your internal helper method and pass the manager to keep it in the transaction
        const readyStatus = await this.findStatusByCode(
          OrderStatus.READY,
          adminId,
          manager,
        );

        await manager.update(OrderEntity, order.id, {
          statusId: readyStatus.id,
        });
        await this.logStatusChange({
          adminId,
          orderId: order.id,
          fromStatusId: order.statusId, // Current status is now Preparing
          toStatusId: readyStatus.id,
          userId,
          notes: "Automatic: All items scanned successfully",

          manager,
        });
        await this.logOrderAction({
          manager,
          adminId,
          userId,
          orderId: order.id,
          actionType: OrderActionType.PREPARATION_STARTED,
          result: OrderActionResult.SUCCESS,
          details: "Preparation phase completed successfully.",
        });
      }

      return {
        success: true,
        scanned: item.scannedQuantity,
        total: item.quantity,
        isOrderComplete,
      };
    });
  }

  async scanForShipping(orderId: number, sku: string, me: any) {
    const userId = me?.id;
    const adminId = tenantId(me);

    return await this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(OrderEntity, {
        where: { id: orderId, adminId },
        relations: ["items", "items.variant", "status"],
        select: ["id", "statusId", "adminId"],
      });

      if (!order) throw new NotFoundException("Order not found");
      const oldStatusId = order.statusId;
      if (order.status.code !== OrderStatus.READY) {
        await this.logFailedScan(
          manager,
          orderId,
          sku,
          userId,
          adminId,
          ScanReason.INVALID_STATUS,
          ScanLogType.SHIPPING,
          `Current: ${order.status.code}`,
        );
        return {
          success: false,
          message: "Order must be in READY status for shipping scan",
        };
      }

      const item = order.items.find(
        (i) => i.variant?.sku?.trim() === sku.trim(),
      );

      if (!item) {
        await this.logFailedScan(
          manager,
          orderId,
          sku,
          userId,
          adminId,
          ScanReason.SKU_NOT_IN_ORDER,
          ScanLogType.SHIPPING,
        );
        return { success: false, message: `SKU ${sku} not in order` };
      }

      if (item.shippingScannedQuantity >= item.quantity) {
        await this.logFailedScan(
          manager,
          orderId,
          sku,
          userId,
          adminId,
          ScanReason.ALREADY_FULLY_SCANNED,
          ScanLogType.SHIPPING,
        );
        return {
          success: false,
          message: "Item already fully scanned for shipping",
        };
      }

      item.shippingScannedQuantity += 1;
      await manager.save(item);

      const isShippingReady = order.items.every(
        (i) => i.shippingScannedQuantity >= i.quantity,
      );
      if (isShippingReady) {
        const packedStatus = await manager.findOneBy(OrderStatusEntity, {
          code: OrderStatus.PACKED,
        });

        const shippedStatus = await manager.findOneBy(OrderStatusEntity, {
          code: OrderStatus.PACKED,
        });
        await manager.update(OrderEntity, order.id, {
          statusId: shippedStatus.id,
        });
        // ✅ Log the transition: READY -> PACKED
        await this.logStatusChange({
          adminId,
          orderId: order.id,
          fromStatusId: oldStatusId,
          toStatusId: packedStatus.id,
          userId,
          notes: "Automatic: Shipping scan completed (All items packed)",
          manager,
        });
      }

      return {
        success: true,
        scanned: item.shippingScannedQuantity,
        total: item.quantity,
        isShippingReady,
      };
    });
  }

  private async logFailedScan(
    manager: EntityManager,
    orderId: number,
    sku: string,
    userId: number,
    adminId: string,
    reason: ScanReason,
    phase: ScanLogType,
    details?: string,
  ) {
    // 1. Insert the log entry
    const logEntry = manager.create(OrderScanLogEntity, {
      orderId,
      sku: sku.trim(),
      userId,
      adminId,
      reason,
      phase,
      details,
    });

    await manager.save(logEntry);

    // 2. Fetch the order to update the JSON column
    const order = await manager.findOne(OrderEntity, {
      where: { id: orderId },
      select: ["id", "failedScanCounts"],
    });

    if (order) {
      // Initialize if null
      const counts = order.failedScanCounts || { preparation: 0, shipping: 0 };

      // Increment based on phase
      if (phase === ScanLogType.PREPARATION) {
        counts.preparation = (counts.preparation || 0) + 1;
      } else {
        counts.shipping = (counts.shipping || 0) + 1;
      }

      // Assign back and SAVE
      order.failedScanCounts = counts;
      await manager.save(OrderEntity, order);
    }
  }
  async getOrderScanLogs(orderId: number, phase: ScanLogType, me: any) {
    const adminId = tenantId(me);

    return await this.scanLogRepo.find({
      where: {
        orderId,
        adminId,
        phase,
      },
      // ✅ Add "order" to the relations array
      relations: ["user", "order"],
      select: {
        user: {
          id: true,
          name: true,
          email: true,
          avatarUrl: true,
        },
        // ✅ Add the specific order fields you need
        order: true,
      },
      order: {
        createdAt: "DESC",
      },
    });
  }

  async getManifestScanLogs(manifestId: number, me: any) {
    const adminId = tenantId(me);

    return await this.scanLogRepo
      .createQueryBuilder("log")
      .leftJoinAndSelect("log.user", "user")
      // ✅ FIX: Use the relation property "log.order" instead of the raw string "order"
      .innerJoin("log.order", "o")
      .where("o.manifestId = :manifestId", { manifestId })
      .andWhere("log.adminId = :adminId", { adminId })
      .select([
        "log",
        "user.id",
        "user.name",
        "user.email",
        "user.avatarUrl",
        "o.id",
        "o.orderNumber",
      ])
      .orderBy("log.createdAt", "DESC")
      .getMany();
  }

  // ========================================
  // ✅ GET ORDER BY ID
  // ========================================

  async get(me: any, id: number, manager?: EntityManager) {
    const adminId = tenantId(me);
    const repo = manager ? manager.getRepository(OrderEntity) : this.orderRepo;
    if (!adminId) throw new BadRequestException("Missing adminId");

    const order = await repo
      .createQueryBuilder("order")
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
      .leftJoinAndSelect(
        "order.assignments",
        "assignments",
        "assignments.isAssignmentActive = :active",
        { active: true },
      )
      .leftJoinAndSelect("assignments.employee", "employee") // Optional: load the employee details

      // 🔥 Replacement Data
      .leftJoinAndSelect("order.replacementResult", "replacementResult")

      // Join the Replacement Order (The result) and ITS items to get NEW prices
      .leftJoinAndSelect("replacementResult.originalOrder", "repOrder")
      // 3. Link Bridge Items back to Original Prices
      .leftJoinAndSelect("replacementResult.items", "bridgeItems")
      .leftJoinAndSelect("bridgeItems.originalOrderItem", "origItem") // Gets old unitPrice/quantity
      .leftJoinAndSelect("origItem.variant", "bridgeVar")
      .leftJoinAndSelect("bridgeVar.product", "bridgeNewProd")

      .where("order.id = :id", { id })
      .andWhere("order.adminId = :adminId", { adminId })
      .getOne();

    if (!order) throw new BadRequestException("Order not found");

    return order;
  }

  // orders.service.ts

  async getByOrderNumber(
    me: any,
    orderNumber: string,
    manager?: EntityManager,
  ) {
    const adminId = tenantId(me);
    const repo = manager ? manager.getRepository(OrderEntity) : this.orderRepo;

    if (!adminId) throw new BadRequestException("Missing adminId");

    const order = await repo
      .createQueryBuilder("order")
      .leftJoinAndSelect("order.items", "items")
      .leftJoinAndSelect("items.variant", "variant")
      .leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("order.statusHistory", "statusHistory")
      .leftJoinAndSelect("statusHistory.fromStatus", "fromStatus")
      .leftJoinAndSelect("statusHistory.toStatus", "toStatus")
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("order.shippingCompany", "shippingCompany")
      .leftJoinAndSelect("order.store", "store")
      .leftJoinAndSelect(
        "order.assignments",
        "assignments",
        "assignments.isAssignmentActive = :active",
        { active: true },
      )
      .leftJoinAndSelect("assignments.employee", "employee")
      .leftJoinAndSelect("order.replacementResult", "replacementResult")
      .leftJoinAndSelect("replacementResult.originalOrder", "repOrder")
      .leftJoinAndSelect("replacementResult.items", "bridgeItems")
      .leftJoinAndSelect("bridgeItems.originalOrderItem", "origItem")
      .leftJoinAndSelect("origItem.variant", "bridgeVar")
      .leftJoinAndSelect("bridgeVar.product", "bridgeNewProd")
      // 🔥 Search by orderNumber instead of ID
      .where("order.orderNumber = :orderNumber", { orderNumber })
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
      return this.createWithManager(manager, adminId, me, dto, ipAddress);
    });
  }

  // Helper that performs order creation logic using an existing transaction manager
  public async createWithManager(
    manager: EntityManager,
    adminId: string,
    me: any,
    dto: CreateOrderDto,
    ipAddress?: string,
  ) {
    await this.walletService.processOrderUsage(me, 1, manager);
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
      if (!variant)
        throw new BadRequestException(`Variant ${item.variantId} not found`);

      const available = (variant.stockOnHand || 0) - (variant.reserved || 0);
      if (available < item.quantity) {
        throw new BadRequestException(
          `Insufficient stock for variant ${variant.sku}. Available: ${available}, Requested: ${item.quantity}`,
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
        isAdditional: it.isAdditional !== undefined ? false : it.isAdditional,
        unitPrice,
        unitCost,
        lineTotal,
        lineProfit,
      } as any);
    });

    // Calculate totals
    const { productsTotal, finalTotal, profit } = this.calculateTotals(
      dto.items.map((it) => ({
        unitPrice: it.unitPrice,
        unitCost: it.unitCost ?? variantMap.get(it.variantId)!.price ?? 0,
        quantity: it.quantity,
      })),
      dto.shippingCost ?? 0,
      dto.discount ?? 0,
    );

    const defaultStatus = await this.getDefaultStatus(adminId);

    if (dto.shippingCompanyId) {
      const companyId = Number(dto.shippingCompanyId);
      const company = await this.shippingRepo.findOne({
        where: { id: companyId },
      });
      if (!company) {
        throw new BadRequestException("Invalid shipping company selected.");
      }

      const integration = await this.shippingIntegrationRepo.findOne({
        where: {
          shippingCompanyId: companyId,
          adminId,
        },
      });

      if (!integration || !integration.isActive) {
        throw new BadRequestException(
          `${company.name} is not currently active.`,
        );
      }
    }

    if (dto.storeId) {
      const store = await manager.findOne(StoreEntity, {
        where: { id: Number(dto.storeId), adminId },
      });

      if (!store) {
        throw new BadRequestException(
          "The selected store is invalid or does not belong to your account.",
        );
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
      secondPhoneNumber: dto.secondPhoneNumber ?? null,
      allowOpenPackage: dto.allowOpenPackage ?? false,
      paymentStatus: dto.paymentStatus ?? PaymentStatus.PENDING,
      shippingCompanyId: dto.shippingCompanyId ? dto.shippingCompanyId : null,
      storeId: dto.storeId ? dto.storeId : null,
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
      shippingMetadata: dto.shippingMetadata,
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
      manager,
    });

    return saved;
  }

  // ========================================
  // ✅ UPDATE ORDER
  // ========================================
  async update(me: any, id: number, dto: UpdateOrderDto, ipAddress?: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    return this.dataSource.transaction(async (manager) => {
      const order = await manager
        .createQueryBuilder(OrderEntity, "order")
        .leftJoinAndSelect("order.items", "items")
        .leftJoinAndSelect("items.variant", "variant")
        .leftJoinAndSelect("variant.product", "product")
        .leftJoinAndSelect("order.statusHistory", "statusHistory")
        .leftJoinAndSelect("statusHistory.fromStatus", "fromStatus")
        .leftJoinAndSelect("statusHistory.toStatus", "toStatus")
        .leftJoinAndSelect("order.status", "status")
        .leftJoinAndSelect("order.shippingCompany", "shippingCompany")
        .leftJoinAndSelect("order.store", "store")
        .where("order.id = :id", { id })
        .andWhere("order.adminId = :adminId", { adminId })
        .getOne();

      await this.throwIfDelivered(order, "Cannot update a order that has been closed.");
      const shippingRepo = manager.getRepository(ShippingCompanyEntity);
      const storeRepo = manager.getRepository(StoreEntity);
      const integrationRepo = manager.getRepository(ShippingIntegrationEntity);

      if (
        order.status?.system &&
        (order.status.code === OrderStatus.SHIPPED ||
          order.status.code === OrderStatus.DELIVERED)
      ) {
        throw new BadRequestException(
          "Cannot update shipped or delivered orders",
        );
      }
      if (dto.shippingCompanyId) {
        const companyId = Number(dto.shippingCompanyId);
        const company = await shippingRepo.findOne({
          where: { id: companyId },
        });
        if (!company) {
          throw new BadRequestException("Invalid shipping company selected.");
        }

        const integration = await integrationRepo.findOne({
          where: {
            shippingCompanyId: companyId,
            adminId,
          },
        });

        if (!integration || !integration.isActive) {
          throw new BadRequestException(
            `${company.name} is not currently active.`,
          );
        }
        order.shippingCompanyId = companyId;
      }

      if (dto.storeId) {
        const store = await storeRepo.findOne({
          where: { id: Number(dto.storeId), adminId },
        });

        if (!store) {
          throw new BadRequestException(
            "The selected store is invalid or does not belong to your account.",
          );
        }
      }
      let currentOrderItems = [...order.items];
      // --- 1. PROCESS REMOVED ITEMS ---
      if (dto.removedItems && dto.removedItems.length > 0) {
        const removedVariantIds = dto.removedItems.map((i) => i.variantId);

        // Find the entities that belong to this order to remove them

        const updateIds = new Set(dto.items.map((i) => i.variantId));
        const itemsToRemove = dto.removedItems.filter(
          (i) => !updateIds.has(i.variantId),
        );

        if (itemsToRemove.length > 0) {
          // 2. Fetch the Variants to update their reserved stock
          const RemovedOrderItems = await manager.find(OrderItemEntity, {
            where: {
              adminId,

              variantId: In(itemsToRemove.map((i) => i.variantId)),
            } as any,
            relations: {
              variant: true,
            },
          });

          const RemovedItemsMap = new Map(
            RemovedOrderItems.map((v) => [v.variantId, v]),
          );
          const variantsToUpdate = new Map<number, ProductVariantEntity>();
          // 3. Release reserved stock based on the OrderItem's quantity
          for (const item of itemsToRemove) {
            const removedItem = RemovedItemsMap.get(item.variantId);
            if (removedItem) {
              // Use item.quantity (from the DB) to decrease the reservation
              const qtyToRelease = removedItem.quantity || 0;
              removedItem.variant.reserved = Math.max(
                0,
                (removedItem.variant.reserved || 0) - qtyToRelease,
              );
              variantsToUpdate.set(removedItem.variant.id, removedItem.variant);
            }
          }

          // 4. Batch Save variants and Batch Remove items
          if (variantsToUpdate.size > 0) {
            await manager.save(
              ProductVariantEntity,
              Array.from(variantsToUpdate.values()),
            );
          }
          await manager.remove(OrderItemEntity, RemovedOrderItems);

          // Update the local array for subsequent total calculations
          currentOrderItems = currentOrderItems.filter(
            (i) => !removedVariantIds.includes(i.variantId),
          );
        }
      }

      if (dto.items && dto.items.length > 0) {
        const newVariantIds = dto.items.map((i) => i.variantId);

        const variants = await manager.find(ProductVariantEntity, {
          where: { adminId, id: In(newVariantIds) } as any,
        });
        const variantMap = new Map(variants.map((v) => [v.id, v]));

        const itemsToSave = [];
        const modifiedVariants = new Set<ProductVariantEntity>(); // Use a Set to avoid duplicate saves

        for (const dtoItem of dto.items) {
          const variant = variantMap.get(dtoItem.variantId);
          if (!variant)
            throw new BadRequestException(
              `Variant ID ${dtoItem.variantId} not found`,
            );

          const existingItemIndex = currentOrderItems.findIndex(
            (i) => i.variantId === dtoItem.variantId,
          );
          const existingItem =
            existingItemIndex > -1
              ? currentOrderItems[existingItemIndex]
              : null;

          const oldQty = existingItem ? existingItem.quantity : 0;
          const qtyDiff = dtoItem.quantity - oldQty;

          // 1. Stock Validation
          if (qtyDiff > 0) {
            const available =
              (variant.stockOnHand || 0) - (variant.reserved || 0);
            if (available < qtyDiff) {
              throw new BadRequestException(
                `Insufficient stock for variant ${variant.sku}. Available: ${available}, Requested Increase: ${qtyDiff}`,
              );
            }
          }

          // 2. Update variant in memory
          if (qtyDiff !== 0) {
            variant.reserved = Math.max(0, (variant.reserved || 0) + qtyDiff);
            modifiedVariants.add(variant);
          }

          // 3. Prepare OrderItemEntity
          if (existingItem) {
            // Update existing
            existingItem.quantity = dtoItem.quantity;
            existingItem.unitPrice = dtoItem.unitPrice;
            if (dtoItem.isAdditional !== undefined)
              existingItem.isAdditional = dtoItem.isAdditional;

            existingItem.lineTotal = dtoItem.quantity * dtoItem.unitPrice;
            existingItem.lineProfit =
              (dtoItem.unitPrice - existingItem.unitCost) * dtoItem.quantity;

            currentOrderItems[existingItemIndex] = existingItem;
            itemsToSave.push(existingItem);
          } else {
            // Create new
            const unitCost = dtoItem.unitCost ?? variant.price ?? 0;
            const newItem = manager.create(OrderItemEntity, {
              adminId,
              orderId: order.id,
              variantId: dtoItem.variantId,
              quantity: dtoItem.quantity,
              unitPrice: dtoItem.unitPrice,
              unitCost: unitCost,
              isAdditional: dtoItem.isAdditional ?? false,
              lineTotal: dtoItem.quantity * dtoItem.unitPrice,
              lineProfit: (dtoItem.unitPrice - unitCost) * dtoItem.quantity,
            } as any);

            currentOrderItems.push(newItem);
            itemsToSave.push(newItem);
          }
        }

        // --- BATCH SAVES ---
        // Save all modified variants at once
        if (modifiedVariants.size > 0) {
          await manager.save(
            ProductVariantEntity,
            Array.from(modifiedVariants),
          );
        }

        // Save all new/updated order items at once
        if (itemsToSave.length > 0) {
          await manager.save(OrderItemEntity, itemsToSave);
        }
      }

      // Attach final items list so calculateTotals uses the exact latest state
      order.items = currentOrderItems;
      // Update basic fields
      Object.assign(order, {
        customerName: dto.customerName ?? order.customerName,
        phoneNumber: dto.phoneNumber ?? order.phoneNumber,
        secondPhoneNumber: dto.secondPhoneNumber ?? order.secondPhoneNumber,
        allowOpenPackage: dto.allowOpenPackage ?? order.allowOpenPackage,
        email: dto.email ?? order.email,
        address: dto.address ?? order.address,
        city: dto.city ?? order.city,
        area: dto.area ?? order.area,
        paymentMethod: dto.paymentMethod ?? order.paymentMethod,
        storeId: dto.storeId ?? order.storeId,
        shippingCost: dto.shippingCost ?? order.shippingCost,
        discount: dto.discount ?? order.discount,
        notes: dto.notes ?? order.notes,
        customerNotes: dto.customerNotes ?? order.customerNotes,
        trackingNumber: dto.trackingNumber ?? order.trackingNumber,
        updatedByUserId: me?.id,
        landmark: dto.landmark,
        deposit: dto.deposit,
        shippingMetadata: dto.shippingMetadata
          ? { ...order.shippingMetadata, ...dto.shippingMetadata }
          : order.shippingMetadata,
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
          order.discount,
        );
        order.productsTotal = productsTotal;
        order.finalTotal = finalTotal;
        order.profit = profit;
      }

      const updatedOrder = await manager.save(OrderEntity, order);

      await this.notificationService.create({
        userId: Number(adminId),
        type: NotificationType.ORDER_UPDATED,
        title: "Order Updated",
        message: `Order #${order.orderNumber} has been updated.`,
        relatedEntityType: "order",
        relatedEntityId: String(order.id),
      });

      return updatedOrder;
    });
  }

  // ========================================
  // ✅ CHANGE ORDER STATUS
  // ========================================
  async changeStatus(
    me: any,
    id: number,
    dto: ChangeOrderStatusDto,
    ipAddress?: string,
  ) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(OrderEntity, {
        where: { id, adminId } as any,
        relations: ["items", "items.variant"],
      });

      if (!order) throw new BadRequestException("Order not found");
      await this.throwIfDelivered(order, "Cannot update a order that has been closed.");

      const newStatus = await this.findStatusById(dto.statusId, order.adminId);

      const oldStatusId = order.statusId;
      const newStatusCode = newStatus.code;

      if (oldStatusId === dto.statusId) return order;

      // Handle stock changes
      if (
        newStatusCode === OrderStatus.CANCELLED ||
        newStatusCode === OrderStatus.RETURNED
      ) {
        // Release reserved stock
        for (const item of order.items) {
          const variant = item.variant;
          variant.reserved = Math.max(
            0,
            (variant.reserved || 0) - item.quantity,
          );
          await manager.save(ProductVariantEntity, variant);
        }
      }

      if (newStatusCode === OrderStatus.SHIPPED && !order.shippedAt) {
        order.shippedAt = new Date();
      }

      //only decrease stock when order hasn't shipping
      if (
        newStatusCode === OrderStatus.DELIVERED &&
        !order.deliveredAt &&
        !order.shippingCompanyId
      ) {
        order.deliveredAt = new Date();
        // Deduct from stock & release reserved
        for (const item of order.items) {
          const variant = item.variant;
          variant.stockOnHand = Math.max(
            0,
            (variant.stockOnHand || 0) - item.quantity,
          );
          variant.reserved = Math.max(
            0,
            (variant.reserved || 0) - item.quantity,
          );
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
        manager,
      });

      await this.notificationService.create({
        userId: Number(adminId),
        type: NotificationType.ORDER_STATUS_UPDATE,
        title: "Order Status Updated",
        message: `Order #${order.orderNumber} status changed to ${newStatus.name}.`,
        relatedEntityType: "order",
        relatedEntityId: String(order.id),
      });

      return saved;
    });
  }

  async rejectOrder(
    me: any,
    id: number,
    dto: { notes?: string },
    ipAddress?: string,
  ) {
    const adminId = tenantId(me);
    const userId = me?.id;
    if (!adminId) throw new BadRequestException("Missing adminId");

    return this.dataSource.transaction(async (manager) => {
      // 1. Fetch Order and Rejected Status
      const [order, rejectedStatus] = await Promise.all([
        manager.findOne(OrderEntity, {
          where: { id, adminId },
          select: ["id", "orderNumber", "statusId"],
        }),
        this.findStatusByCode(OrderStatus.REJECTED, adminId, manager),
      ]);

      if (!order) throw new NotFoundException("Order not found");
      await this.throwIfDelivered(order, "Cannot reject a order that has been closed.");
      if (!rejectedStatus)
        throw new BadRequestException("Rejected status not found");

      const oldStatusId = order.statusId;

      // 2. Update Order with the new "Reason" column
      await manager.update(OrderEntity, id, {
        statusId: rejectedStatus.id,
        rejectReason: dto.notes, // ✅ Saving the notes into the new reason column
        rejectedAt: new Date(),
        rejectedById: userId,
        updatedByUserId: userId,
      });

      // 3. ✅ LOG OPERATIONAL ACTION (The Movement)
      // We mark this as FAILED because the order is being pulled out of the flow
      await this.logOrderAction({
        manager,
        adminId,
        userId,
        orderId: order.id,
        actionType: OrderActionType.REJECTED,
        result: OrderActionResult.FAILED,
        details: `Order Rejected. Reason: ${dto.notes || "No reason provided"}`,
      });

      // 4. ✅ LOG STATUS CHANGE (The Timeline)
      await this.logStatusChange({
        adminId,
        orderId: order.id,
        fromStatusId: oldStatusId,
        toStatusId: rejectedStatus.id,
        userId,
        notes: dto.notes,
        ipAddress,
        manager,
      });

      await this.notificationService.create({
        userId: Number(adminId),
        type: NotificationType.ORDER_REJECTED,
        title: "Order Rejected",
        message: `Order #${order.orderNumber} has been rejected. Reason: ${dto.notes || "No reason provided"}`,
        relatedEntityType: "order",
        relatedEntityId: String(order.id),
      });

      return { success: true, orderId: id, status: OrderStatus.REJECTED };
    });
  }

  async reConfirmOrder(me: any, id: number, ipAddress?: string) {
    const adminId = tenantId(me);
    const userId = me?.id;
    if (!adminId) throw new BadRequestException("Missing adminId");

    return this.dataSource.transaction(async (manager) => {
      // 1. Fetch Order and Confirmed Status
      const [order, confirmedStatus] = await Promise.all([
        manager.findOne(OrderEntity, {
          where: { id, adminId },
          select: ["id", "orderNumber", "statusId"],
        }),
        this.findStatusByCode(OrderStatus.CONFIRMED, adminId, manager),
      ]);

      await this.throwIfDelivered(order, "Cannot re-confirm a order that has been closed.");
      if (!order) throw new NotFoundException("Order not found");
      if (!confirmedStatus)
        throw new BadRequestException("Confirmed status not found");

      const oldStatusId = order.statusId;

      // 2. Update Order: Revert status and CLEAR rejection data
      await manager.update(OrderEntity, id, {
        statusId: confirmedStatus.id,
        rejectReason: null, // ✅ Clear the previous rejection reason
        rejectedAt: null, // ✅ Clear the rejection timestamp
        rejectedById: null,
        updatedByUserId: userId,
      });

      // 3. ✅ LOG OPERATIONAL ACTION (The Recovery)
      // We mark this as SUCCESS because the order is back in the active pipeline
      await this.logOrderAction({
        manager,
        adminId,
        userId,
        orderId: order.id,
        actionType: OrderActionType.CONFIRMED,
        result: OrderActionResult.SUCCESS,
        details: `Order re-confirmed and returned to workflow.`,
      });

      // 4. ✅ LOG STATUS CHANGE (The Timeline)
      await this.logStatusChange({
        adminId,
        orderId: order.id,
        fromStatusId: oldStatusId,
        toStatusId: confirmedStatus.id,
        userId,
        notes: "Re-confirmed after rejection",
        ipAddress,
        manager,
      });

      await this.notificationService.create({
        userId: Number(adminId),
        type: NotificationType.ORDER_RECONFIRMED,
        title: "Order Re-confirmed",
        message: `Order #${order.orderNumber} has been re-confirmed.`,
        relatedEntityType: "order",
        relatedEntityId: String(order.id),
      });

      return { success: true, orderId: id, status: OrderStatus.CONFIRMED };
    });
  }

  // ========================================
  // ✅ CONFIRMATION TEAM: CHANGE ORDER STATUS
  // ========================================
  async changeConfirmationStatus(
    me: any,
    id: number,
    dto: ChangeOrderStatusDto,
    ipAddress?: string,
  ) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");
    const employeeId = me?.id;

    return this.dataSource.transaction(async (manager) => {
      // 1. Fetch Order and its Active Assignment for this employee
      const order = await manager.findOne(OrderEntity, {
        where: { id, adminId } as any,
        relations: ["status", "items", "items.variant", "assignments"],
      });

      if (!order) throw new BadRequestException("Order not found");

      const oldStatus = order?.status;
      // Validate Active Assignment
      const activeAssignment = order.assignments.find(
        (a) => a.isAssignmentActive && a.employeeId === employeeId,
      );
      if (!activeAssignment) {
        throw new BadRequestException(
          "You do not have an active assignment for this order.",
        );
      }

      // 2. Fetch Statuses & Settings
      let newStatus = await this.findStatusById(dto.statusId, adminId);
      const oldStatusId = order.statusId;

      if (oldStatusId === newStatus.id) return order;

      const settings = await this.getSettings(me);
      const allowed = settings.confirmationStatuses;

      if (
        newStatus.system &&
        !allowed.includes(newStatus.code as OrderStatus)
      ) {
        throw new BadRequestException(
          `Confirmation team is not allowed to set status to ${newStatus.code}`,
        );
      }

      // Fetch Retry Settings

      const now = new Date();
      activeAssignment.lastActionAt = now;

      // 3. Handle Retry & Assignment Logic
      const isRetryStatus = settings.retryStatuses.includes(newStatus.code);
      let actionResult = OrderActionResult.SUCCESS;

      if (isRetryStatus && settings.enabled) {
        activeAssignment.retriesUsed += 1;

        if (
          activeAssignment.retriesUsed >=
          activeAssignment.maxRetriesAtAssignment
        ) {
          newStatus = await this.findStatusByCode(
            settings.autoMoveStatus,
            adminId,
            manager,
          );

          if (!newStatus)
            throw new BadRequestException(
              "Auto-move status is not configured correctly.",
            );

          activeAssignment.isAssignmentActive = false;
          activeAssignment.finishedAt = now;
          activeAssignment.lockedUntil = null;
          actionResult = OrderActionResult.FAILED;
        } else {
          // Lock for the retry interval
          activeAssignment.lockedUntil = new Date(
            now.getTime() + settings.retryInterval * 60000,
          );
        }
      } else {
        // Success or Terminal Failure (Not a retry state): Finish assignment
        activeAssignment.isAssignmentActive = false;
        activeAssignment.finishedAt = now;
        activeAssignment.lockedUntil = null;
      }
      activeAssignment.lastStatusId = newStatus.id;

      // 4. Update Order (Stock logic included for terminal states)
      if (
        newStatus.code === OrderStatus.CANCELLED ||
        newStatus.code === OrderStatus.RETURNED
      ) {
        for (const item of order.items) {
          if (item.stockDeducted) {
            // If it was already deducted from stock, add it back
            item.variant.stockOnHand = (item.variant.stockOnHand || 0) + item.quantity;
            item.stockDeducted = false;
          } else {
            // Otherwise just release the reservation
            item.variant.reserved = Math.max(
              0,
              (item.variant.reserved || 0) - item.quantity,
            );
          }
          await manager.save(ProductVariantEntity, item.variant);
          await manager.save(OrderItemEntity, item);
        }
      } else if (
        !allowed.includes(oldStatus.code as OrderStatus) &&
        allowed.includes(newStatus.code as OrderStatus) &&
        settings.stockDeductionStrategy === StockDeductionStrategy.ON_CONFIRMATION
      ) {
        // Deduct stock on confirmation
        await this.deductStockForOrder(manager, order);
      }

      order.status = newStatus;
      order.updatedByUserId = employeeId;

      // Save Entities
      await manager.save(OrderAssignmentEntity, activeAssignment);
      const savedOrder = await manager.save(OrderEntity, order);

      if (settings.notifyAdmin) {
        console.log("notify admin here");
      }

      if (settings.notifyEmployee) {
        console.log("notify employee here");
      }

      await this.logOrderAction({
        manager,
        adminId,
        userId: employeeId,
        orderId: savedOrder.id,
        shippingCompanyId: order?.shippingCompanyId,
        actionType: OrderActionType.CONFIRMED,
        result: actionResult,
        details: `Confirmation process: Moved from ${oldStatus?.name} to ${newStatus.name}. Retries: ${activeAssignment.retriesUsed} of ${activeAssignment.maxRetriesAtAssignment}`,
      });

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

      const notificationPromises = [];

      // 1. Notify Admin (The tenant owner/manager)
      if (settings.notifyAdmin) {
        notificationPromises.push(
          this.notificationService.create({
            userId: Number(adminId),
            type: NotificationType.ORDER_STATUS_UPDATE,
            title: `Order #${savedOrder.orderNumber} Updated`,
            message: `Status changed to "${newStatus.name}" by ${me.name || "Staff"}.`,
            relatedEntityType: "order",
            relatedEntityId: String(savedOrder.id),
          }),
        );
      }

      // 2. Notify Employee (The one assigned to the order)
      notificationPromises.push(
        this.notificationService.create({
          userId: Number(activeAssignment.employeeId),
          type: NotificationType.ORDER_STATUS_UPDATE,
          title: `Assignment Updated`,
          message: `Your assigned order #${savedOrder.orderNumber} is now "${newStatus.name}".`,
          relatedEntityType: "order",
          relatedEntityId: String(savedOrder.id),
        }),
      );

      await Promise.all(notificationPromises);

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
    await this.throwIfDelivered(order, "Cannot update a order that has been closed.");
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
      { isRead: true },
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
    if (
      ![OrderStatus.NEW, OrderStatus.CANCELLED].includes(
        order.status.code as OrderStatus,
      )
    ) {
      throw new BadRequestException("Can only delete new or cancelled orders");
    }

    // Release reserved stock
    for (const item of order.items) {
      const variant = await this.variantRepo.findOne({
        where: { id: item.variantId } as any,
      });
      if (variant) {
        variant.reserved = Math.max(0, (variant.reserved || 0) - item.quantity);
        await this.variantRepo.save(variant);
      }
    }

    await this.orderRepo.delete({ id, adminId } as any);

    await this.notificationService.create({
      userId: Number(adminId),
      type: NotificationType.ORDER_DELETED,
      title: "Order Deleted",
      message: `Order #${order.orderNumber} has been deleted.`,
    });

    return { ok: true };
  }

  async findByExternalId(externalId: string): Promise<OrderEntity | null> {
    return this.orderRepo.findOne({
      where: { externalId },
      relations: ["status", "items", "items.variant"],
    });
  }

  async updateExternalId(orderId: number, externalId: string) {
    await this.orderRepo.update(orderId, { externalId });
  }

  async findStatusByCode(
    code: string,
    adminId: string,
    manager?: EntityManager,
  ): Promise<OrderStatusEntity> {
    // [2025-12-24] Trim input and ensure case-insensitive matching if needed
    const repo = manager
      ? manager.getRepository(OrderStatusEntity)
      : this.statusRepo;
    const trimmedCode = code;

    const status = await repo.findOne({
      where: [
        { code: trimmedCode, adminId: adminId },
        { code: trimmedCode, system: true },
      ],
    });

    if (!status) {
      throw new NotFoundException(
        `Status "${trimmedCode}" not found for this account.`,
      );
    }

    return status;
  }
  async findStatusById(
    id: number,
    adminId: string,
  ): Promise<OrderStatusEntity> {
    // [2025-12-24] Trim input and ensure case-insensitive matching if needed

    const status = await this.statusRepo.findOne({
      where: [
        { id: id, system: true }, // Condition 1: Global System Status
        { id: id, adminId: adminId }, // Condition 2: Admin-specific Status
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
        { isDefault: true, system: true }, // System-wide default
        { isDefault: true, adminId: adminId }, // Admin-specific default
      ],
      order: { system: "DESC" }, // Prioritize system default if both exist
    });

    if (!status) {
      throw new Error("Critical: No order statuses found in system.");
    }

    return status;
  }

  async createStatus(me: any, dto: CreateStatusDto) {
    const adminId = tenantId(me);
    const name = dto.name.trim(); // [2025-12-24] Trim

    const code = slugify(name);
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

    const saved = await this.statusRepo.save(status);

    await this.notificationService.create({
      userId: Number(adminId),
      type: NotificationType.ORDER_STATUS_CREATED,
      title: "New Status Created",
      message: `A new order status "${saved.name}" has been created.`,
    });

    return saved;
  }

  async updateStatus(me: any, id: number, dto: UpdateStatusDto) {
    const adminId = tenantId(me);
    const status = await this.statusRepo.findOneBy({ id, adminId: adminId });

    if (!status)
      throw new NotFoundException(
        "Status not found or is a protected System Status.",
      );

    // Extra safety: even if adminId matches, block if system is true
    if (status.system)
      throw new ForbiddenException("Cannot edit system statuses.");
    const newName = dto.name?.trim() ?? status.name;

    const code = slugify(newName);
    await this.validateStatusUniqueness(newName, code, adminId, id);

    Object.assign(status, {
      ...dto,
      name: dto.name?.trim() ?? status.name,
      description: dto.description?.trim(),
      color: dto.color.trim(),
      sortOrder: dto.sortOrder,
    });

    const saved = await this.statusRepo.save(status);

    await this.notificationService.create({
      userId: Number(adminId),
      type: NotificationType.ORDER_STATUS_SETTINGS_UPDATED,
      title: "Status Updated",
      message: `The status "${saved.name}" has been updated.`,
    });

    return saved;
  }

  private async validateStatusUniqueness(
    name: string,
    code: string,
    adminId: string,
    excludeId?: number,
  ): Promise<void> {
    const queryBuilder = this.statusRepo
      .createQueryBuilder("status")
      .where(
        new Brackets((qb) => {
          qb.where("status.name = :name", { name }).orWhere(
            "status.code = :code",
            { code },
          );
        }),
      )
      .andWhere(
        new Brackets((qb) => {
          qb.where("status.adminId = :adminId", { adminId }).orWhere(
            "status.system = :system",
            { system: true },
          );
        }),
      );

    if (excludeId) {
      queryBuilder.andWhere("status.id != :excludeId", { excludeId });
    }

    const existing = await queryBuilder.getOne();

    if (existing) {
      const conflictType = existing.code === code ? "code" : "name";
      throw new BadRequestException(
        `Status ${conflictType} already exists. Please choose another name.`,
      );
    }
  }

  async removeStatus(me: any, id: number) {
    const adminId = tenantId(me);
    const status = await this.statusRepo.findOneBy({ id, adminId: adminId });

    if (!status) throw new NotFoundException("Status not found.");
    if (status.system)
      throw new ForbiddenException("System statuses cannot be deleted.");

    // [2025-12-24] Trim Risk: Check if orders are using this status
    const usageCount = await this.orderRepo.countBy({ statusId: id });
    if (usageCount > 0) {
      throw new BadRequestException(
        `Cannot delete: ${usageCount} orders are currently in this status.`,
      );
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
      .leftJoinAndSelect(
        "order.assignments",
        "assignment",
        "assignment.isAssignmentActive = true",
      )
      .leftJoinAndSelect("assignment.employee", "employee");

    // Filter by assigned employee (userId)
    if (q?.userId) {
      qb.andWhere("assignment.employeeId = :userId", {
        userId: Number(q.userId),
      });
    }

    // Apply same filters as list method
    if (q?.status) {
      const statusParam = q.status;
      if (!isNaN(Number(statusParam))) {
        qb.andWhere("order.statusId = :statusId", {
          statusId: Number(statusParam),
        });
      } else {
        qb.andWhere("status.code = :statusCode", {
          statusCode: String(statusParam).trim(),
        });
      }
    }
    if (q?.paymentStatus)
      qb.andWhere("order.paymentStatus = :paymentStatus", {
        paymentStatus: q.paymentStatus,
      });
    if (q?.paymentMethod)
      qb.andWhere("order.paymentMethod = :paymentMethod", {
        paymentMethod: q.paymentMethod,
      });
    if (q?.shippingCompanyId)
      qb.andWhere("order.shippingCompanyId = :shippingCompanyId", {
        shippingCompanyId: Number(q.shippingCompanyId),
      });
    if (q?.storeId)
      qb.andWhere("order.storeId = :storeId", { storeId: Number(q.storeId) });

    // Date range
    if (q?.startDate)
      qb.andWhere("order.created_at >= :startDate", {
        startDate: `${q.startDate}T00:00:00.000Z`,
      });
    if (q?.endDate)
      qb.andWhere("order.created_at <= :endDate", {
        endDate: `${q.endDate}T23:59:59.999Z`,
      });

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
      const productsList =
        order.items
          ?.map(
            (item) =>
              `${item.variant?.product?.name || "N/A"} (x${item.quantity})`,
          )
          .join("; ") || "N/A";
      const activeAssignment = order.assignments?.find(
        (a) => a.isAssignmentActive,
      );
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
        status: order.status?.system
          ? order.status.code
          : order.status?.name || "N/A",
        paymentMethod: order.paymentMethod || "N/A",
        paymentStatus: order.paymentStatus || "N/A",
        shippingCompany: order.shippingCompany?.name || "N/A",
        shippingCost: order.shippingCost || 0,
        discount: order.discount || 0,
        deposit: order.deposit || 0,
        finalTotal:
          (order.items?.reduce(
            (sum, item) => sum + item.unitPrice * item.quantity,
            0,
          ) || 0) +
          (order.shippingCost || 0) -
          (order.discount || 0),
        notes: order.notes || "N/A",
        customerNotes: order.customerNotes || "N/A",
        createdAt: order.created_at
          ? new Date(order.created_at).toLocaleDateString()
          : "N/A",
        updatedAt: order.updated_at
          ? new Date(order.updated_at).toLocaleDateString()
          : "N/A",
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
    const sheet = workbook.addWorksheet("Orders", {
      views: [{ state: "frozen", ySplit: 1 }],
    });

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
      {
        header: "Shipping Company Name",
        key: "shippingCompanyName",
        width: 22,
      },
      { header: "Shipping Cost", key: "shippingCost", width: 14 },
      { header: "Discount", key: "discount", width: 12 },
      { header: "Deposit", key: "deposit", width: 12 },
      { header: "Notes", key: "notes", width: 24 },
      { header: "Customer Notes", key: "customerNotes", width: 24 },
      {
        header: "Product SKUs (comma-separated)",
        key: "productSkus",
        width: 30,
      },
      { header: "Quantities (comma-separated)", key: "quantities", width: 25 },
      { header: "Unit Prices (comma-separated)", key: "unitPrices", width: 28 },
    ];
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };
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

  private async getUsageTracker(adminId: number): Promise<BulkUploadUsage> {
    const currentMonth = new Date().toISOString().slice(0, 7); // "2026-02"

    let usage = await this.usageRepo.findOne({
      where: { adminId, month: currentMonth },
    });

    if (!usage) {
      usage = this.usageRepo.create({ adminId, month: currentMonth, count: 0 });
      await this.usageRepo.save(usage);
    }

    return usage;
  }

  // ========================================
  // ✅ BULK CREATE ORDERS FROM EXCEL
  // ========================================
  async bulkCreateOrders(
    me: any,
    file: Express.Multer.File,
  ): Promise<{
    created: number;
    failed: number;
    errors: { rowNumber: number; message: string }[];
  }> {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");
    if (!file?.buffer) throw new BadRequestException("No file uploaded");

    const admin = await this.userRepo
      .createQueryBuilder("user")
      .leftJoinAndSelect(
        "user.subscriptions",
        "subscription",
        "subscription.status = :status",
        { status: SubscriptionStatus.ACTIVE },
      )
      .leftJoinAndSelect("subscription.plan", "plan")
      .where("user.id = :id", { id: adminId })
      .getOne();

    if (!admin?.activeSubscription)
      throw new ForbiddenException("No active plan found");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);
    const sheet = workbook.worksheets[0];
    const rowCount = sheet.rowCount - 1; // Subtract header

    const usage = await this.getUsageTracker(adminId);
    const limit = admin.activeSubscription?.plan.bulkUploadPerMonth;

    if (usage.count + rowCount > limit) {
      throw new BadRequestException(
        `Plan limit exceeded. You have ${limit - usage.count} slots left this month, but the file has ${rowCount} rows.`,
      );
    }

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
    const num = (
      obj: Record<string, string | number>,
      key: string,
      def = 0,
    ) => {
      const k = key.replace(/\s+/g, "").toLowerCase();
      const v = obj[k];
      if (v === undefined || v === "") return def;
      const n = Number(v);
      return isNaN(n) ? def : n;
    };

    const shippingCompanies = await this.shippingRepo.find({
      where: { adminId } as any,
    });
    const shippingByName = new Map<string, number>();
    shippingCompanies.forEach((s) =>
      shippingByName.set(s.name.trim().toLowerCase(), s.id),
    );

    const paymentMethods = ["cash", "card", "bank_transfer", "cod"];
    const paymentStatuses = ["pending", "paid", "partial"];

    let created = 0;
    const errors: { rowNumber: number; message: string }[] = [];
    const orderDtos: { dto: CreateOrderDto; rowNumber: number }[] = [];

    // Build DTOs for all valid rows first
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      const rowNumber = rowIdx + 2; // +2 because excel rows start at 1 and data starts at row 2

      const customerName = col(row, "Customer Name", "customername");
      const phoneNumber = col(row, "Phone Number", "phonenumber");
      const address = col(row, "Address", "address");
      const city = col(row, "City", "city");
      if (!customerName || !phoneNumber || !address || !city) {
        errors.push({
          rowNumber,
          message:
            "Missing required: Customer Name, Phone Number, Address, or City",
        });
        continue;
      }

      // Parse comma-separated arrays
      const skusStr = col(row, "Product SKUs (comma-separated)", "productskus");
      const quantitiesStr = col(
        row,
        "Quantities (comma-separated)",
        "quantities",
      );
      const unitPricesStr = col(
        row,
        "Unit Prices (comma-separated)",
        "unitprices",
      );

      if (!skusStr || !quantitiesStr || !unitPricesStr) {
        errors.push({
          rowNumber,
          message: "Missing required: Product SKUs, Quantities, or Unit Prices",
        });
        continue;
      }

      const skus = skusStr
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s);
      const quantities = quantitiesStr.split(",").map((q) => {
        const num = Number(q.trim());
        return isNaN(num) ? null : num;
      });
      const unitPrices = unitPricesStr.split(",").map((p) => {
        const num = Number(p.trim());
        return isNaN(num) ? null : num;
      });

      // Validate array lengths match
      if (
        skus.length !== quantities.length ||
        skus.length !== unitPrices.length
      ) {
        errors.push({
          rowNumber,
          message: `Array length mismatch: ${skus.length} SKUs, ${quantities.length} quantities, ${unitPrices.length} prices. All must be equal.`,
        });
        continue;
      }

      // Validate no null values
      if (quantities.includes(null) || unitPrices.includes(null)) {
        errors.push({
          rowNumber,
          message: "Invalid quantities or unit prices (must be numbers)",
        });
        continue;
      }

      // Collect unique SKUs for targeted fetch
      const uniqueSkus = [...new Set(skus.map((s) => s))];
      const variants = await this.variantRepo.find({
        where: {
          adminId,
          sku: In(uniqueSkus),
        } as any,
        relations: ["product"],
      });
      const variantBySku = new Map<string, { id: number; price: number }>();
      variants.forEach((v) => {
        if (v.sku)
          variantBySku.set(String(v.sku).trim().toLowerCase(), {
            id: v.id,
            price: v.price ?? 0,
          });
      });

      const paymentMethodRaw =
        col(row, "Payment Method", "paymentmethod") || "cod";
      const paymentMethod = paymentMethods.includes(paymentMethodRaw)
        ? paymentMethodRaw
        : "cod";
      const paymentStatusRaw =
        col(row, "Payment Status", "paymentstatus") || "pending";
      const paymentStatus = paymentStatuses.includes(paymentStatusRaw)
        ? paymentStatusRaw
        : "pending";

      let shippingCompanyId: string | undefined;
      const shippingName = col(
        row,
        "Shipping Company Name",
        "shippingcompanyname",
      );
      if (shippingName) {
        const sid = shippingByName.get(shippingName.toLowerCase());
        if (sid != null) shippingCompanyId = String(sid);
      }

      // Build items array
      const items: {
        variantId: number;
        quantity: number;
        unitPrice: number;
        unitCost?: number;
      }[] = [];
      for (let i = 0; i < skus.length; i++) {
        const sku = skus[i];
        const qty = quantities[i] as number;
        const unitPrice = unitPrices[i] as number;

        if (qty < 1) {
          errors.push({
            rowNumber,
            message: `Invalid quantity for SKU ${sku}: must be >= 1`,
          });
          continue;
        }

        const variant = variantBySku.get(sku.toLowerCase());
        if (!variant) {
          errors.push({ rowNumber, message: `Product SKU not found: ${sku}` });
          break;
        }
        items.push({
          variantId: variant.id,
          quantity: qty,
          unitPrice,
          unitCost: variant.price,
        });
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
        storeId: null,
      };

      orderDtos.push({ dto, rowNumber });
    }

    if (orderDtos.length === 0) {
      return { created: 0, failed: errors.length, errors };
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        for (const { dto, rowNumber } of orderDtos) {
          try {
            await this.createWithManager(manager, adminId, me, dto, undefined);
            created++;
          } catch (err: any) {
            errors.push({
              rowNumber,
              message: err?.message || "Create failed",
            });
            // Re-throw to ensure the whole batch is rolled back
            throw err;
          }
        }
      });
    } catch {
      // If transaction fails, ensure no orders are reported as created
      created = 0;
    }

    if (created > 0) {
      await this.notificationService.create({
        userId: Number(adminId),
        type: NotificationType.BULK_ORDERS_CREATED,
        title: "Bulk Orders Created",
        message: `${created} orders have been successfully created from Excel.`,
      });
    }

    return { created, failed: errors.length, errors };
  }

  private async deductStockForOrder(
    manager: EntityManager,
    order: OrderEntity,
  ) {
    const variantsMap = new Map<number, ProductVariantEntity>();
    const itemsToUpdate: OrderItemEntity[] = [];

    for (const item of order.items) {
      if (item.stockDeducted || !item.variant) continue;

      // Get variant from map if already processed in this loop, otherwise use item.variant
      const variant = variantsMap.get(item.variant.id) || item.variant;

      // Logic: Deduct from stockOnHand and release reservation
      variant.stockOnHand = Math.max(0, (variant.stockOnHand || 0) - item.quantity);
      variant.reserved = Math.max(0, (variant.reserved || 0) - item.quantity);

      item.stockDeducted = true;

      variantsMap.set(variant.id, variant);
      itemsToUpdate.push(item);
    }

    if (itemsToUpdate.length > 0) {
      // Bulk save: TypeORM handles these in optimized chunks
      await Promise.all([
        manager.save(ProductVariantEntity, Array.from(variantsMap.values())),
        manager.save(OrderItemEntity, itemsToUpdate),
      ]);
    }
  }

  private async deductStockForMultipleOrders(
    manager: EntityManager,
    orders: OrderEntity[],
  ) {
    const variantsMap = new Map<number, ProductVariantEntity>();
    const itemsToUpdate: OrderItemEntity[] = [];

    for (const order of orders) {
      for (const item of order.items) {
        if (item.stockDeducted || !item.variant) continue;

        // Use the map to ensure we are cumulative across different orders
        const variant = variantsMap.get(item.variant.id) || item.variant;

        variant.stockOnHand = Math.max(0, (variant.stockOnHand || 0) - item.quantity);
        variant.reserved = Math.max(0, (variant.reserved || 0) - item.quantity);

        item.stockDeducted = true;

        variantsMap.set(variant.id, variant);
        itemsToUpdate.push(item);
      }
    }

    if (itemsToUpdate.length > 0) {
      // Save all unique variants and all modified items in parallel
      await Promise.all([
        manager.save(ProductVariantEntity, Array.from(variantsMap.values())),
        manager.save(OrderItemEntity, itemsToUpdate),
      ]);
    }
  }


  async getSettings(me: any): Promise<OrderRetrySettingsEntity> {
    const adminId = tenantId(me);
    let settings = await this.retryRepo.findOneBy({ adminId: adminId });

    if (!settings) {
      settings = await this.retryRepo.create({
        adminId,
        confirmationStatuses: [
          OrderStatus.CANCELLED,
          OrderStatus.CONFIRMED,
          OrderStatus.NO_ANSWER,
          OrderStatus.OUT_OF_DELIVERY_AREA,
          OrderStatus.POSTPONED,
          OrderStatus.WRONG_NUMBER,
          OrderStatus.UNDER_REVIEW,
        ],
        autoMoveStatus: OrderStatus.CANCELLED,
        retryStatuses: [
          OrderStatus.OUT_OF_DELIVERY_AREA,
          OrderStatus.UNDER_REVIEW,
        ],
      });
    }

    // Return existing or a default object to keep frontend stable
    return settings;
  }

  async upsertSettings(
    me: any,
    dto: UpsertOrderRetrySettingsDto,
  ): Promise<OrderRetrySettingsEntity> {
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

    const saved = await this.retryRepo.save(settings);

    // Invalidate cache
    const cacheKey = `admin_notification_settings:${adminId}`;
    await this.redisService.del(cacheKey);

    return saved;
  }

  async getAllowedConfirmationStatuses(me: any): Promise<OrderStatusEntity[]> {
    const adminId = tenantId(me);

    // 1. Get the codes from settings
    const settings = await this.getSettings(me);
    const codes = settings.confirmationStatuses || [];

    if (codes.length === 0) return [];

    // 2. Fetch full objects for these codes
    return this.statusRepo.find({
      where: [
        { code: In(codes), adminId: adminId }, // Custom statuses
        { code: In(codes), system: true }, // System statuses
      ],
      order: { sortOrder: "ASC" },
    });
  }

  async getConfirmationStatusCounts(me: any) {
    const adminId = tenantId(me);
    const employeeId = me?.id;

    // 2. Query statuses and count active assignments
    const results = await this.statusRepo
      .createQueryBuilder("status")
      .leftJoin("status.orders", "order", "order.adminId = :adminId", {
        adminId,
      })
      .leftJoin(
        "order.assignments",
        "assignment",
        "assignment.employeeId = :employeeId AND assignment.isAssignmentActive = true",
        { employeeId },
      )
      .select([
        "status.id",
        "status.name",
        "status.code",
        "status.color",
        "status.system",
      ])
      .addSelect("COUNT(assignment.id)", "count")
      .where(
        new Brackets((qb) => {
          qb.where("status.adminId = :adminId", { adminId }).orWhere(
            "status.system = true",
          );
        }),
      )
      .groupBy("status.id")
      .orderBy("status.sortOrder", "ASC")
      .getRawMany();

    // Map raw results to clean objects
    return results.map((r) => ({
      id: r.status_id,
      name: r.status_name,
      code: r.status_code,
      color: r.status_color,
      system: r.status_system,
      count: Number(r.count),
    }));
  }

  async getFreeOrders(me: any, q: GetFreeOrdersDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const fetchLimit = Number(q.limit) || 20;

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

    // ✅ Multiple statuses filter
    if (q.statusIds?.length) {
      qb.andWhere("status.id IN (:...statusIds)", {
        statusIds: q.statusIds,
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

    qb.orderBy("order.created_at", "DESC").limit(fetchLimit + 1); // fetch one extra to check hasMore

    const orders = await qb.getMany();

    const hasMore = orders.length > fetchLimit;
    if (hasMore) orders.pop();

    const nextCursor =
      hasMore && orders.length > 0
        ? orders[orders.length - 1].created_at
        : null;

    return {
      data: orders,
      nextCursor,
      hasMore,
    };
  }

  /** Get count of free (unassigned) orders by status and optional date range. */
  async getFreeOrdersCount(
    me: any,
    q: { statusIds: number[]; startDate?: string; endDate?: string },
  ) {
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
        statusIds: q.statusIds,
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

  async getEmployeesByLoad(me: any, limit: number = 20, cursor: number | null, role?: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const fetchLimit = Number(limit) || 20;

    const qb = this.userRepo
      .createQueryBuilder("user")
      .leftJoin("user.role", "role") // لتمكين الفلترة بالـ role
      .leftJoin(
        "user.assignments",
        "assignment",
        "assignment.isAssignmentActive = true",
      )
      .where("user.adminId = :adminId", { adminId })
      .select([
        "user.id",
        "user.name",
        "user.email",
        "user.avatarUrl",
        "user.employeeType",
        "user.isActive",
      ])
      .addSelect("COUNT(assignment.id)", "activeCount")
      .groupBy("user.id")
      .addGroupBy("role.id");

    if (role) {
      qb.andWhere("role.name = :role", { role });
    }

    if (cursor !== null && cursor !== undefined) {
      qb.having("COUNT(assignment.id) >= :cursor", { cursor });
    }

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

    const nextCursor =
      hasMore && result.length > 0
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
    const employeeIds = [...new Set(dto.assignments.map((a) => a.userId))];
    const allOrderIds = [
      ...new Set(dto.assignments.flatMap((a) => a.orderIds)),
    ];

    // validate no duplicate order across different employees (already deduped above, but check in payload)
    const payloadOrderCount = dto.assignments.reduce(
      (sum, a) => sum + a.orderIds.length,
      0,
    );
    if (allOrderIds.length !== payloadOrderCount) {
      throw new BadRequestException(
        "Each order may only be assigned to a single employee in the same request",
      );
    }

    return this.dataSource.transaction(async (manager) => {
      // 1) verify employees exist & belong to admin
      const employees = await manager.find(User, {
        where: { id: In(employeeIds), adminId } as any,
      });

      if (employees.length !== employeeIds.length) {
        throw new NotFoundException(
          `Employees not found or not belonging to admin`,
        );
      }

      // 2) verify orders exist & belong to admin
      const freeOrders = await manager
        .createQueryBuilder(OrderEntity, "order")
        .leftJoin(
          "order.assignments",
          "assignment",
          "assignment.isAssignmentActive = :isActive",
          { isActive: true },
        )
        .where("order.id IN (:...allOrderIds)", { allOrderIds })
        .andWhere("order.adminId = :adminId", { adminId })
        .andWhere("assignment.id IS NULL") // This ensures the order is "free"
        .select(["order.id", "order.orderNumber"])
        .getMany();

      if (freeOrders.length !== allOrderIds.length) {
        throw new BadRequestException(
          `Some orders are either invalid, restricted, or already actively assigned.`,
        );
      }

      freeOrders.forEach(async o => await this.throwIfDelivered(o, "Cannot assign a order that has been closed."));
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
            assignedByAdminId: Number(adminId),
            maxRetriesAtAssignment: maxRetries,
            isAssignmentActive: true,
          });
          assignmentsToSave.push(assignment);
        }
      }

      // 6) save all assignments
      const saved = await manager.save(
        OrderAssignmentEntity,
        assignmentsToSave,
      );

      // return helpful summary
      const summary = {
        success: true,
        totalAssigned: saved.length,
        byEmployee: employees.map((emp) => {
          const count = saved.filter((s) => s.employeeId === emp.id).length;
          return {
            userId: emp.id,
            name: emp.name || null,
            assignedCount: count,
          };
        }),
      };

      return summary;
    });
  }

  async autoAssign(me: any, dto: AutoAssignDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    return this.dataSource.transaction(async (manager) => {
      // 1. Find 'Free' Orders (No active assignments)
      const q = manager
        .createQueryBuilder(OrderEntity, "order")
        .leftJoin(
          "order.assignments",
          "assignment",
          "assignment.isAssignmentActive = :isActive",
          { isActive: true },
        )
        .where("order.adminId = :adminId", { adminId })
        .andWhere("order.statusId IN (:...statusIds)", {
          statusIds: dto.statusIds,
        })
        .andWhere("assignment.id IS NULL") // Only orders with NO active assignments
        .select(["order.id", "order.orderNumber"]);

      if (dto?.startDate)
        q.andWhere("order.created_at >= :startDate", {
          startDate: `${dto.startDate}T00:00:00.000Z`,
        });
      if (dto?.endDate)
        q.andWhere("order.created_at <= :endDate", {
          endDate: `${dto.endDate}T23:59:59.999Z`,
        });

      const freeOrders = await q.limit(dto.orderCount).getMany();

      if (freeOrders.length === 0) {
        throw new NotFoundException(
          "No free orders found matching these criteria",
        );
      }
      if (freeOrders.length !== dto.orderCount) {
        throw new BadRequestException(
          `Cannot fulfill request. You requested ${dto.orderCount} orders, but only ${freeOrders.length} unassigned orders were found for the selected statuses.`,
        );
      }
      freeOrders.forEach(async o => await this.throwIfDelivered(o, "Cannot assign a order that has been closed."));

      // 2. Find 'Least Busy' Employees
      // We count active assignments for each employee and sort ASC
      const employees = await manager
        .createQueryBuilder(User, "user")
        .leftJoin(
          "order_assignments",
          "oa",
          "oa.employeeId = user.id AND oa.isAssignmentActive = true",
        )
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
          `Insufficient employees. You requested assignment to ${dto.employeeCount} employees, but only ${employees.length} are available.`,
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
          assignedByAdminId: Number(adminId),
          maxRetriesAtAssignment: maxRetries,
          isAssignmentActive: true,
        });
        assignmentsToSave.push(assignment);
      });

      // 5. Save and Summary
      const saved = await manager.save(
        OrderAssignmentEntity,
        assignmentsToSave,
      );

      return {
        success: true,
        totalAssigned: saved.length,
        employeesParticipating: employees.length,
        byEmployee: employees.map((emp) => ({
          userId: emp.id,
          name: emp.name,
          previouslyActive: parseInt(emp.activeCount),
          newlyAssigned: saved.filter((s) => s.employeeId === emp.id).length,
        })),
      };
    });
  }

  async getAutoPreview(me: any, dto: AutoPreviewDto) {
    const adminId = tenantId(me);

    // 1. Fetch TOTAL Max Limits (Ceilings) in Parallel
    const orderCountQuery = this.orderRepo
      .createQueryBuilder("order")
      .leftJoin("order.assignments", "oa", "oa.isAssignmentActive = true")
      .where("order.adminId = :adminId", { adminId })
      .andWhere("order.statusId IN (:...statusIds)", {
        statusIds: dto.statusIds,
      })
      .andWhere("oa.id IS NULL");

    if (dto?.startDate) {
      orderCountQuery.andWhere("order.created_at >= :startDate", {
        startDate: `${dto.startDate}T00:00:00.000Z`,
      });
    }
    if (dto?.endDate) {
      orderCountQuery.andWhere("order.created_at <= :endDate", {
        endDate: `${dto.endDate}T23:59:59.999Z`,
      });
    }

    const [maxOrdersCount, maxEmployeesCount] = await Promise.all([
      orderCountQuery.getCount(),
      this.userRepo.count({ where: { adminId } as any }),
    ]);

    // 2. Cap the requested counts to the Max Limits
    const effectiveOrderCount = Math.min(
      dto.requestedOrderCount || maxOrdersCount,
      maxOrdersCount,
    );
    const effectiveEmployeeCount = Math.min(
      dto.requestedEmployeeCount || maxEmployeesCount,
      maxEmployeesCount,
    );

    // If there's nothing to assign, return early
    if (effectiveOrderCount === 0 || effectiveEmployeeCount === 0) {
      return {
        maxOrders: maxOrdersCount,
        maxEmployees: maxEmployeesCount,
        assignments: [],
      };
    }
    // 3. Fetch specific Orders and Employees for the preview
    const [freeOrders, leastBusyEmployees] = await Promise.all([
      this.orderRepo
        .createQueryBuilder("order")
        .leftJoin("order.assignments", "oa", "oa.isAssignmentActive = true")
        .where("order.adminId = :adminId", { adminId })
        .andWhere("order.statusId IN (:...statusIds)", {
          statusIds: dto.statusIds,
        })
        .andWhere("oa.id IS NULL")
        .select(["order.id", "order.orderNumber"])
        .limit(effectiveOrderCount)
        .getMany(),

      this.userRepo
        .createQueryBuilder("user")
        .leftJoin(
          "order_assignments",
          "oa",
          "oa.employeeId = user.id AND oa.isAssignmentActive = true",
        )
        .where("user.adminId = :adminId", { adminId })
        .select(["user.id", "user.name"])
        .addSelect("COUNT(oa.id)", "activeCount")
        .groupBy("user.id")
        .orderBy("COUNT(oa.id)", "ASC")
        .limit(effectiveEmployeeCount)
        .getMany(),
    ]);
    // 4. In-Memory Round-Robin Assignment
    const assignmentMap = new Map<
      number,
      { name: string; orderNumbers: string[] }
    >();

    // Initialize map with selected employees
    leastBusyEmployees.forEach((emp) => {
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
      effectiveEmployeeCount,
      effectiveOrderCount,
      assignments: Array.from(assignmentMap.values()),
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
        { userId: me?.id },
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
      .addOrderBy("order.id", "ASC")
      .getOne();

    return orders;
  }

  /**
   * Single Order Log Helper
   */
  async logOrderAction(params: {
    manager?: EntityManager;
    adminId: string;
    userId: number;
    orderId: number;
    actionType: OrderActionType;
    shippingCompanyId?: number;
    result?: OrderActionResult;
    details?: string;
  }) {
    const repo = params.manager
      ? params.manager.getRepository(OrderActionLogEntity)
      : this.orderActionLogRepo;

    const dateStr = new Date().toISOString().split("T")[0].replace(/-/g, "");
    const count = await repo.count({
      where: { adminId: params.adminId },
    });
    const operationNumber = `OP-${dateStr}-${(count + 1).toString().padStart(5, "0")}`;

    const log = repo.create({
      operationNumber,
      adminId: params.adminId,
      orderId: params.orderId,
      actionType: params.actionType,
      userId: params.userId,
      shippingCompanyId: params.shippingCompanyId,
      result: params.result || OrderActionResult.SUCCESS,
      details: params.details,
    });

    return await repo.save(log);
  }

  /**
   * Bulk Orders Log Helper
   */
  async logBulkOrderActions(params: {
    manager: EntityManager;
    adminId: string;
    userId: number;
    orderIds: number[];
    actionType: OrderActionType;
    shippingCompanyId?: number;
    result?: OrderActionResult;
    details?: string;
  }) {
    const dateStr = new Date().toISOString().split("T")[0].replace(/-/g, "");
    const currentCount = await params.manager.count(OrderActionLogEntity, {
      where: { adminId: params.adminId },
    });

    const logs = params.orderIds.map((orderId, index) => {
      return params.manager.create(OrderActionLogEntity, {
        operationNumber: `OP-${dateStr}-${(currentCount + index + 1).toString().padStart(5, "0")}`,
        adminId: params.adminId,
        orderId,
        actionType: params.actionType,
        userId: params.userId,
        shippingCompanyId: params.shippingCompanyId,
        result: params.result || OrderActionResult.SUCCESS,
        details: params.details,
      });
    });

    // Performs a single database round-trip
    return await params.manager.insert(OrderActionLogEntity, logs);
  }
}
