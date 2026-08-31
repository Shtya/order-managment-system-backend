// orders/orders.service.ts
import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { isEmail } from "class-validator";
import { InjectRepository } from "@nestjs/typeorm";
import {
  DataSource,
  Repository,
  In,
  EntityManager,
  Brackets,
  IsNull,
  Not,
  MoreThan,
  MoreThanOrEqual,
  SelectQueryBuilder,
} from "typeorm";
import axios from "axios";
import * as ExcelJS from "exceljs";
import { getMissingDeductionQuantity } from "../utils/stock-deduction";
import { isPartiallyReturnedForManifest } from "../utils/return-manifest-status";
import {
  OrderEntity,
  OrderItemEntity,
  OrderStatusHistoryEntity,
  OrderMessageEntity,
  PaymentStatus,
  OrderStatusEntity,
  OrderStatus,
  OrderStatusPercentFrom,
  OrderConfirmationSource,
  slugify,
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
  ReturnRequestStatus,
  DamageResponsibility,
} from "entities/order.entity";
import { OrderAssignmentEntity } from "entities/assignment.entity";
import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";
import {
  CreateOrderDto,
  UpdateOrderDto,
  ChangeOrderStatusDto,
  UpdatePaymentStatusDto,
  AddOrderMessageDto,
  MarkMessagesReadDto,
  UpdateStatusDto,
  CreateStatusDto,
  CreateManifestDto,
  BulkUpdateShippingFieldsDto,
  OrderItemDto,
  CellErrorMap,
  SkuErrorRow,
} from "dto/order.dto";
import { User } from "entities/user.entity";
import OpenAI from "openai";
import { NotificationType } from "entities/notifications.entity";
import { StoreEntity } from "entities/stores.entity";
import {
  ShipmentEntity,
  ShipmentStatus,
  ShippingCompanyEntity,
  ShippingIntegrationEntity,
  UnifiedShippingStatus,
} from "entities/shipping.entity";
import { BulkUploadUsage, SubscriptionStatus } from "entities/plans.entity";
import { DateFilterUtil } from "common/date-filter.util";
import { RedisService } from "common/redis/RedisService";
import { WalletService } from "src/wallet/wallet.service";
import { NotificationService } from "src/notifications/notification.service";
import { StoresService } from "src/stores/stores.service";
import { ShippingService } from "src/shipping/shipping.service";
import { OrderSyncQueueService } from "src/queue/queues/order-sync.queue";

import { CRUD } from "common/crud.service";
import { OrderAssignmentService } from "src/order-assignment/order-assignment.service";
import { randomBytes } from "crypto";
import { generateRandomAlphanumeric, isSuperAdmin } from "common/healpers";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";
import { CityEntity } from "entities/cities.entity";
import { IssueEntity, IssueStatus } from "entities/issue.entity";
import { AutoAssignmentQueueService } from "src/queue/queues/auto-assignment.queue";
import { TriggerDispatcherService } from "src/automation/engine/triggerDispatcher.service";
import { TriggerEntityType, TriggerType } from "entities/automation.entity";
import {
  ClientSettingsEntity,
  StockDeductionStrategy,
} from "entities/clientSettings.entity";
import { ClientSettingsService } from "src/client-settings/client-settings.service";
import {
  RequestTranslationService,
  TranslationService,
} from "common/translation.service";
import { OnboardingAchievementService } from "src/queue/queues/onboarding-achievement.queue";
import { GettingStartedAchievementType } from "entities/getting-started.entity";
import { CancelCausesService } from "src/cancel-causes/cancel-causes.service";
import { TagAutomationEvaluator } from "src/tags/tag-automation.evaluator";

export function tenantId(me: any): any | null {
  if (!me) return null;
  const roleName = me.role?.name;
  if (roleName === "super_admin") return null;
  if (roleName === "admin") return me.id;
  return me.adminId;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(
    private dataSource: DataSource,
    protected readonly orderSyncQueueService: OrderSyncQueueService,

    @InjectRepository(OrderEntity)
    private orderRepo: Repository<OrderEntity>,

    @InjectRepository(OrderStatusEntity)
    private statusRepo: Repository<OrderStatusEntity>,
    @InjectRepository(User)
    private userRepo: Repository<User>,

    @InjectRepository(BulkUploadUsage)
    private usageRepo: Repository<BulkUploadUsage>,

    @InjectRepository(ClientSettingsEntity)
    private clientSettingsRepo: Repository<ClientSettingsEntity>,

    private clientSettingsService: ClientSettingsService,

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

    @InjectRepository(ProductEntity)
    private productRepo: Repository<ProductEntity>,

    @InjectRepository(OrderScanLogEntity)
    private scanLogRepo: Repository<OrderScanLogEntity>,

    @InjectRepository(ShipmentManifestEntity)
    private manifestRepo: Repository<ShipmentManifestEntity>,

    @InjectRepository(OrderActionLogEntity)
    private orderActionLogRepo: Repository<OrderActionLogEntity>,

    @Inject(forwardRef(() => WalletService))
    private walletService: WalletService,

    private notificationService: NotificationService,
    private redisService: RedisService,
    @Inject(forwardRef(() => StoresService))
    private storesService: StoresService,
    @Inject(forwardRef(() => ShippingService))
    private shippingService: ShippingService,
    @Inject(forwardRef(() => AutoAssignmentQueueService))
    private autoAssignmentQueueService: AutoAssignmentQueueService,
    @Inject(forwardRef(() => TriggerDispatcherService))
    private readonly triggerDispatcher: TriggerDispatcherService,
    private readonly translations: TranslationService,
    private requestTranslations: RequestTranslationService,
    private readonly onboardingAchievementService: OnboardingAchievementService,
    @Inject(forwardRef(() => CancelCausesService))
    private readonly cancelCausesService: CancelCausesService,
    @Inject(forwardRef(() => TagAutomationEvaluator))
    private readonly tagAutomationEvaluator: TagAutomationEvaluator,
  ) { }

  //private function to lock order if he delivered and has monthly closign id
  public async throwIfDelivered(order: OrderEntity, message?: string) {
    const deliveryStatus = await this.statusRepo.findOne({
      where: {
        code: OrderStatus.DELIVERED,
      },
    });
    if (!deliveryStatus) {
      throw new NotFoundException(
        this.translations.t("domains.orders.delivery_status_not_found"),
      );
    }

    if (order.statusId === deliveryStatus.id && order.monthlyClosingId) {
      throw new BadRequestException(
        message ||
        this.translations.t("domains.orders.cannot_update_or_delete_closed"),
      );
    }
  }

  /**
   * Check if a status code belongs to warehouse operations
   */
  public isWarehouseStatus(statusCode: string): boolean {
    const warehouseStatuses: string[] = [
      OrderStatus.RETURNED,
      OrderStatus.PARTIALLY_RETURNED,
      OrderStatus.DELIVERED,
      OrderStatus.DISTRIBUTED,
      OrderStatus.PRINTED,
      OrderStatus.PREPARING,
      OrderStatus.READY,
      OrderStatus.SHIPPED,
      OrderStatus.RETURN_PREPARING,
    ];
    return warehouseStatuses.includes(statusCode);
  }

  // ✅ Generate unique order number

  private async generateOrderNumber(adminId: string): Promise<string> {
    const prefix = "ORD"; // 3 fixed chars
    const totalLength = 10;
    const randomPartLength = totalLength - prefix.length;

    for (let attempt = 0; attempt < 10; attempt++) {
      const orderNumber = `${prefix}${generateRandomAlphanumeric(randomPartLength)}`;

      const existingOrder = await this.orderRepo.findOne({
        where: {
          adminId,
          orderNumber,
        },
      });

      if (!existingOrder) {
        return orderNumber;
      }
    }

    throw new Error(
      this.translations.t("domains.orders.failed_generate_order_number"),
    );
  }

  // ✅ Calculate totals
  public calculateTotals(
    items: any[],
    shippingCost = 0,
    discount = 0,
    additionalFees = 0,
  ) {
    const productsTotal = items.reduce((sum, item) => {
      return sum + Number(item.unitPrice) * Number(item.quantity);
    }, 0);

    const finalTotal =
      Number(productsTotal) +
      Number(shippingCost) +
      Number(additionalFees) -
      Number(discount);

    const profit = items.reduce((sum, item) => {
      return (
        sum +
        (Number(item.unitPrice) - Number(item.unitCost)) * Number(item.quantity)
      );
    }, 0);

    const round = (value: number) => Number(value.toFixed(2));

    return {
      productsTotal: round(productsTotal),
      finalTotal: round(finalTotal),
      profit: round(profit),
    };
  }

  // ✅ Generate items signature (sku:quantity|sku:quantity|...)
  private generateItemsSignature(
    items: OrderItemEntity[],
    variantMap?: Map<string, ProductVariantEntity>,
  ): string {
    if (!items || items.length === 0) return "";
    return items
      .map((item) => {
        const sku =
          item.variant?.sku || variantMap?.get(item.variantId)?.sku || "N/A";
        return `${sku}:${item.quantity}`;
      })
      .join("|");
  }

  // ✅ Log status change
  public async logStatusChange(params: {
    adminId: string;
    orderId: string;
    fromStatusId: string | null; // Changed from Enum to ID
    toStatusId: string; // Changed from Enum to ID
    userId?: string;
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
    await this.handleOrderStatusChange({
      orderId: params.orderId,
      manager: params.manager,
      oldStatusId: params.fromStatusId,
      newStatusId: params.toStatusId,
    });
    return log;
  }

  // ✅ Handle order status change (logs, triggers, sync)
  public async handleOrderStatusChange(params: {
    orderId: string;
    manager: EntityManager;
    oldStatusId?: string | null;
    newStatusId?: string;
  }) {
    // Load full order with necessary relations

    // Function to run after commit
    const runAfterCommit = async () => {
      try {
        const order = await this.orderRepo.findOne({
          where: { id: params.orderId },
          select: ["id", "adminId", "oldStatusId", "statusId", "externalId"],
        });

        if (!order || order.oldStatusId === order.statusId) {
          return;
        }

        await this.triggerDispatcher.dispatch({
          type: TriggerType.ORDER_UPDATED,
          entityType: TriggerEntityType.ORDER,
          entityId: order.id,
          adminId: order.adminId,
          payload: null,
          orderId: order.id,
        });
        await this.tagAutomationEvaluator.evaluateOrder(
          order.id,
          order.adminId,
        );

        if (order.externalId) {
          await this.storesService.syncOrderStatus(
            order.id,
            order.statusId,
            order.oldStatusId || null,
          );
        }
      } catch (error) {
        console.error("Error in handleOrderStatusChange:", error);
      }
    };

    // Check if we're in a transaction
    const queryRunner = params.manager.queryRunner;

    if (queryRunner) {
      if (!queryRunner.data.postCommitTasks) {
        queryRunner.data.postCommitTasks = [];
      }
      queryRunner.data.postCommitTasks.push(runAfterCommit);
    } else {
      // No active transaction, run immediately
      await runAfterCommit();
    }
  }

  // ✅ Bulk log status changes
  public async bulkLogStatusChange(params: {
    adminId: string;
    orderStatusChanges: Array<{
      orderId: string;
      fromStatusId: string | null;
      toStatusId: string;
    }>;
    userId?: string;
    notes?: string;
    ipAddress?: string;
    manager: EntityManager;
  }) {
    const historyRepo = params.manager.getRepository(OrderStatusHistoryEntity);
    const logs = params.orderStatusChanges.map((change) => {
      return historyRepo.create({
        adminId: params.adminId,
        orderId: change.orderId,
        fromStatusId: change.fromStatusId,
        toStatusId: change.toStatusId,
        changedByUserId: params.userId || null,
        notes: params.notes,
        ipAddress: params.ipAddress,
      });
    });

    // Bulk insert status history
    await historyRepo.insert(logs);

    // Now handle each order's status change (post‑commit tasks, etc.) using Promise.allSettled
    const promises = params.orderStatusChanges.map(async (change) => {
      try {
        await this.handleOrderStatusChange({
          orderId: change.orderId,
          manager: params.manager,
          oldStatusId: change.fromStatusId,
          newStatusId: change.toStatusId,
        });
      } catch (error) {
        console.error(
          `Failed to handle status change for order ${change.orderId}:`,
          error,
        );
      }
    });

    await Promise.allSettled(promises);
  }

  // ========================================
  // ✅ STATS
  // ========================================
  private resolvePercentFrom(
    system: boolean,
    percentFrom?: string,
  ): OrderStatusPercentFrom {
    if (system) {
      return OrderStatusPercentFrom.TOTAL;
    }

    const values = Object.values(OrderStatusPercentFrom) as string[];
    if (percentFrom && values.includes(percentFrom)) {
      return percentFrom as OrderStatusPercentFrom;
    }

    return OrderStatusPercentFrom.TOTAL;
  }

  private buildStatusCountsByCode(
    stats: Array<{
      code?: string;
      status_code?: string;
      count?: string | number;
    }>,
  ): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const stat of stats) {
      const code = stat.code ?? stat.status_code;
      if (!code) continue;
      counts[code] = Number(stat.count) || 0;
    }
    return counts;
  }

  private computeStatusPercent(
    count: number,
    percentFrom: OrderStatusPercentFrom,
    totalOrders: number,
    countsByCode: Record<string, number>,
    previouslyConfirmedCount: number,
  ): number {
    let denominator = totalOrders;
    if (percentFrom === OrderStatusPercentFrom.PREVIOUSLY_CONFIRMED) {
      denominator = previouslyConfirmedCount;
    } else if (percentFrom !== OrderStatusPercentFrom.TOTAL) {
      denominator = countsByCode[percentFrom] || 0;
    }
    return denominator > 0 ? Math.round((count / denominator) * 100) : 0;
  }

  async getStats(me: any, q?: any) {
    const superAdmin = isSuperAdmin(me);
    let adminId = tenantId(me);

    if (superAdmin && q?.adminId) {
      adminId = q.adminId;
    }

    if (!superAdmin && !adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const qb = this.statusRepo.createQueryBuilder("status");
    // use relation path only (no join condition)
    if (superAdmin && !q?.adminId) {
      qb.leftJoin("status.orders", "o");
    } else {
      qb.leftJoin("status.orders", "o", "o.adminId = :adminId", { adminId });
    }
    qb.select([
      "status.id AS id",
      "status.name AS name",
      "status.code AS code",
      "status.color  AS color",
      "status.system AS system",
      "status.sortOrder AS sortOrder",
      "status.percentFrom AS \"percentFrom\"",
    ])
      .addSelect("COUNT(o.id)", "count")
      .addSelect(
        "COUNT(CASE WHEN o.isConfirmed = true THEN o.id END)",
        "previouslyConfirmedCount",
      )
      .where(
        new Brackets((qb) => {
          if (superAdmin && !q?.adminId) {
            qb.where("status.system = :system", { system: true });
          } else {
            qb.where("status.adminId = :adminId", { adminId }).orWhere(
              "status.system = :system",
              { system: true },
            );
          }
        }),
      )
      .andWhere("status.isActive = :isActive", { isActive: true });

    DateFilterUtil.applyToQueryBuilder(
      qb,
      "o.created_at",
      q?.startDate,
      q?.endDate,
    );

    // GROUP BY every non-aggregated selected column (Postgres requires this)
    qb.groupBy("status.id")
      .addGroupBy("status.name")
      .addGroupBy("status.code")
      .addGroupBy("status.color")
      .addGroupBy("status.system")
      .addGroupBy("status.sortOrder")
      .addGroupBy("status.percentFrom")
      .orderBy("status.sortOrder", "ASC");

    const stats = await qb.getRawMany();
    const totalOrders = stats.reduce(
      (sum, stat) => sum + (Number(stat.count) || 0),
      0,
    );
    const countsByCode = this.buildStatusCountsByCode(stats);
    const previouslyConfirmedCount = stats.reduce(
      (sum, stat) =>
        sum +
        (Number(
          stat.previouslyConfirmedCount ?? stat.previouslyconfirmedcount,
        ) || 0),
      0,
    );

    return stats.map((stat) => {
      const count = Number(stat.count) || 0;
      const system = !!stat.system;
      const percentFrom = this.resolvePercentFrom(
        system,
        stat.percentFrom  ?? stat.percent_from,
      );
      return {
        id: stat.id,
        name: stat.name,
        code: stat.code,
        color: stat.color,
        system,
        sortOrder: stat.sortOrder ?? stat.sort_order ?? stat.sortorder ?? 0,
        percentFrom,
        count,
        percent: this.computeStatusPercent(
          count,
          percentFrom,
          totalOrders,
          countsByCode,
          previouslyConfirmedCount,
        ),
      };
    });
  }

  async getStatuses(me: any, q?: any) {
    const superAdmin = isSuperAdmin(me);
    let adminId = tenantId(me);

    if (superAdmin && q?.adminId) {
      adminId = q.adminId;
    }

    if (!superAdmin && !adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const statuses = await this.statusRepo
      .createQueryBuilder("status")
      .select([
        "status.id AS id",
        "status.name AS name",
        "status.code AS code",
        "status.color  AS color",
        "status.system AS system",
        "status.sortOrder AS sortOrder",
        "status.percentFrom AS percentFrom",
      ])
      .where(
        new Brackets((qb) => {
          if (superAdmin && !q?.adminId) {
            qb.where("status.system = :system", { system: true });
          } else {
            qb.where("status.adminId = :adminId", { adminId }).orWhere(
              "status.system = :system",
              { system: true },
            );
          }
        }),
      )
      .andWhere("status.isActive = :isActive", { isActive: true })
      .orderBy("status.sortOrder", "ASC")
      .getRawMany();

    return statuses.map((stat) => ({
      id: stat.id,
      name: stat.name,
      code: stat.code,
      color: stat.color,
      system: !!stat.system,
      sortOrder: stat.sortOrder ?? stat.sort_order ?? stat.sortorder ?? 0,
      percentFrom: this.resolvePercentFrom(
        !!stat.system,
        stat.percentFrom ?? stat.percent_from,
      ),
    }));
  }

  async getStatus(me: any, id: string) {
    const adminId = tenantId(me);
    const superAdmin = isSuperAdmin(me);
    if (!superAdmin && !adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const status = await this.findStatusById(id, adminId);
    if (!status) {
      throw new NotFoundException(
        this.translations.t("domains.orders.status_not_found"),
      );
    }

    return status;
  }

  // ========================================
  // ✅ LIST ORDERS
  // ========================================
  async list(me: any, q?: any) {
    const superAdmin = isSuperAdmin(me);
    let adminId = tenantId(me);

    if (superAdmin && q?.adminId) {
      adminId = q.adminId;
    }

    if (!superAdmin && !adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const sortBy = String(q?.sortBy ?? "createdAt");
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
    // Nested query params: cursor[value]/cursor[id] (axios / Nest) or { value, id }
    const cursor = this.parseListCursor(q?.cursor);
    const useCursorPagination =
      q?.useCursor === "true" ||
      q?.useCursor === true ||
      !!(cursor?.value && cursor?.id);
    const hasCursorValue = !!(cursor?.value && cursor?.id);

    const qb = this.orderRepo.createQueryBuilder("order");

    if (adminId) qb.where("order.adminId = :adminId", { adminId });

    qb.leftJoinAndSelect("order.rejectedBy", "rejectedBy")
      .leftJoinAndSelect("order.items", "items")
      .leftJoinAndSelect("items.variant", "variant")
      .leftJoinAndSelect("items.bundle", "bundle")
      .leftJoinAndSelect("variant.product", "product")

    if (q?.includeProductLocation === "true" || q?.includeProductLocation === true) {
      qb.leftJoinAndSelect("product.warehouse", "productWarehouse")
        .leftJoinAndSelect("product.storageLocation", "productStorageLocation");
    }

    qb.leftJoinAndSelect("order.replacementResult", "replacementResult")
      .leftJoinAndSelect("replacementResult.originalOrder", "repOrder")
      .leftJoinAndSelect("replacementResult.items", "bridgeItems")
      .leftJoinAndSelect("bridgeItems.originalOrderItem", "origItem")
      .leftJoinAndSelect("origItem.variant", "bridgeVar")
      .leftJoinAndSelect("bridgeVar.product", "bridgeNewProd")

      .leftJoinAndSelect("order.replacementRequest", "replacementRequest")
      .leftJoinAndSelect(
        "replacementRequest.replacementOrder",
        "replacementOrder",
      )
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("order.orderTags", "orderTags")
      .leftJoinAndSelect("orderTags.tag", "orderTag")
      .leftJoinAndSelect("order.shippingCompany", "shipping")
      .leftJoinAndSelect("order.store", "store")
      .leftJoinAndSelect(
        "order.assignments",
        "assignment",
        `assignment.id = (SELECT sub.id FROM order_assignments sub WHERE sub."orderId" = order.id ORDER BY sub."assignedAt" DESC LIMIT 1)`,
      )
      .leftJoinAndSelect(
        "order.shipments", // افترضنا وجود علاقة (Relation) باسم shipments في Entity الطلب
        "shipment",
        `shipment.id = (SELECT s.id FROM shipments s WHERE s."trackingNumber" = "order"."trackingNumber" ORDER BY s."created_at" DESC LIMIT 1)`,
      )
      .leftJoinAndSelect("order.cityDetails", "cityDetails")
      .leftJoinAndSelect(
        "cityDetails.tenantConfigs",
        "cityTenantConfig",
        `cityTenantConfig.adminId = order.adminId`,
      )
      .leftJoinAndSelect("assignment.employee", "employee")
      .leftJoinAndSelect("order.lastInternalNote", "lastInternalNote")
      .leftJoinAndSelect("lastInternalNote.author", "lastInternalNoteAuthor");

    qb.addSelect(
      `(SELECT COUNT(*) FROM "automation_runs" ar WHERE ar."triggerEntityId" = "order".id::text AND ar."triggerEntityType" = 'order')`,
      "automationRunCount",
    );

    // ✅ Subquery for Upsell History Count
    qb.addSelect(
      `(SELECT COUNT(*) FROM "upsell_history" uh WHERE uh."orderId" = "order".id)`,
      "upsellHistoryCount",
    );

    qb.addSelect(
      `(SELECT COUNT(*) FROM "order_cancel_causes" occ WHERE occ."orderId" = "order".id)`,
      "cancelCauseCount",
    );
    if (me?.id) {
      qb.addSelect(
        `COALESCE(("order"."internalNotesUnreadCounts" ->> :meUnreadId)::int, 0)`,
        "myUnreadCount",
      );
      qb.setParameter("meUnreadId", String(me.id));
    }
    if (superAdmin) {
      qb.leftJoinAndSelect("order.admin", "admin");
    }

    // Allowed columns mapping
    const sortColumns: Record<string, string> = {
      createdAt: "order.created_at",
      orderNumber: "order.orderNumber",
    };

    // ✅ Shared order filters (same as listGroupedByDate)
    this.applyOrdersListFilters(qb, q, me);

    if (q?.excludeStatus) {
      const statusParam = q.excludeStatus;
      if (typeof statusParam === "string" && statusParam.includes(",")) {
        const statusCodes = statusParam.split(",").map((s) => s.trim());
        qb.andWhere("status.code NOT IN (:...statusCodes)", { statusCodes });
      } else if (!isNaN(Number(statusParam))) {
        qb.andWhere("order.statusId NOT :statusId", {
          statusId: Number(statusParam),
        });
      } else {
        qb.andWhere("status.code NOT LIKE :statusCode", {
          statusCode: `${String(statusParam).trim()}`,
        });
      }
    }

    if (q?.onlyReturned) {
      qb.innerJoinAndSelect("order.lastReturn", "lastReturn")
        .leftJoinAndSelect("lastReturn.items", "returnItems")
        .leftJoinAndSelect("returnItems.returnedVariant", "returnedVariant")
        .andWhere(`status.code = :statusCode`, {
          statusCode: OrderStatus.RETURN_PREPARING,
        })
        .andWhere("lastReturn.status = :returnStatus", {
          returnStatus: ReturnRequestStatus.PENDING,
        });
    }
    // do not select
    // if (q?.activeIntegration) {
    //   qb.leftJoin("shipping.integrations", "integrations")
    //     .andWhere(`integrations."isActive" = true`)
    //     .andWhere(`integrations."adminId" = :adminId`, { adminId })
    //     .andWhere("shipment.id IS NOT NULL")
    //     .andWhere("shipment.unifiedStatus NOT IN (:...shipmentExcluded)", {
    //       shipmentExcluded: [UnifiedShippingStatus.DELIVERED, UnifiedShippingStatus.CANCELLED],
    //     });
    // }

    if (q?.tagIds) {
      const tagIds = Array.isArray(q.tagIds)
        ? q.tagIds
        : String(q.tagIds)
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
      if (tagIds.length) {
        qb.andWhere(
          `EXISTS (
            SELECT 1 FROM order_tags ot
            WHERE ot."orderId" = "order".id
              AND ot."tagId" IN (:...tagIds)
          )`,
          { tagIds },
        );
      }
    }

    // Product Filter
    if (q?.productId && q.productId !== "all") {
      qb.andWhere("variant.productId = :productId", {
        productId: q.productId,
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

    // If status is distributed/printed/preparing/ready/packed (like DistributionTab), filter by shipment.status
    const statusParam = q?.status;
    const isDistributionStatus =
      q?.isDistributionStatus === "true" || q?.isDistributionStatus === true;

    if (
      isDistributionStatus ||
      (q?.shipmentStatus && q.shipmentStatus !== "all")
    ) {
      if (q?.shipmentStatus && q.shipmentStatus !== "all") {
        qb.andWhere("shipment.status = :status", {
          status: q.shipmentStatus,
        });
      } else {
        qb.andWhere("shipment.status IN (:...statuses)", {
          statuses: [
            ShipmentStatus.PENDING_ACTION,
            ShipmentStatus.PREPARING,
            ShipmentStatus.READY_TO_SHIP,
          ],
        });
      }
    }

    DateFilterUtil.applyToQueryBuilder(
      qb,
      "order.shippedAt",
      q?.shippedStartDate,
      q?.shippedEndDate,
    );

    if (q?.minShippingDays !== undefined && q?.minShippingDays !== "") {
      qb.andWhere('"order"."shippedAt" IS NOT NULL');
      qb.andWhere(
        `(CURRENT_DATE - DATE("order"."shippedAt") + 1) >= :minShippingDays`,
        { minShippingDays: Number(q.minShippingDays) },
      );
    }

    if (q?.lateShipping === "true" || q?.lateShipping === true) {
      qb.andWhere('"order"."shippedAt" IS NOT NULL');
      qb.andWhere('"cityTenantConfig"."maxShippingDays" IS NOT NULL');
      qb.andWhere(
        `(CURRENT_DATE - DATE("order"."shippedAt") + 1) > "cityTenantConfig"."maxShippingDays"`,
      );
    }

    if (q?.hasReplacement !== undefined) {
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
    // Deterministic tie-breaker (required for stable keyset/cursor pagination)
    qb.addOrderBy("order.id", sortDir);

    // ✅ Keyset (cursor) pagination — used only when useCursor=true (grouped date expand)
    // Normal list callers keep skip/take + total_records unchanged.
    if (useCursorPagination && hasCursorValue) {
      const operator = sortDir === "DESC" ? "<" : ">";
      qb.andWhere(
        `("order"."created_at", "order"."id") ${operator} (:cursorValue, :cursorId)`,
        {
          cursorValue: cursor.value,
          cursorId: cursor.id,
        },
      );
    }

    // First cursor page still returns total; subsequent cursor pages skip count
    const total =
      useCursorPagination && hasCursorValue ? 0 : await qb.getCount();
    const { entities, raw } = await qb
      .skip(useCursorPagination ? 0 : (page - 1) * limit)
      .take(useCursorPagination ? limit + 1 : limit)
      .getRawAndEntities();

    const hasMore = useCursorPagination
      ? entities.length > limit
      : undefined;
    if (hasMore) {
      entities.length = limit;
      raw.length = Math.min(raw.length, limit);
    }

    // 3. دمج حقول الـ Count المخصصة من الـ Raw داخل الـ Entities
    const records = entities.map((order) => {
      // البحث عن السطر الخام المقابل للطلب الحالي لمطابقة المعرف
      const rawData = raw.find(
        (r) => r.order_id === order.id || r.id === order.id,
      );

      return {
        ...order,
        // عمل parseInt لأن قيم COUNT
        automationRunCount: rawData?.automationRunCount
          ? parseInt(rawData.automationRunCount, 10)
          : 0,
        upsellHistoryCount: rawData?.upsellHistoryCount
          ? parseInt(rawData.upsellHistoryCount, 10)
          : 0,
        cancelCauseCount: rawData?.cancelCauseCount
          ? parseInt(rawData.cancelCauseCount, 10)
          : 0,
        myUnreadCount: rawData?.myUnreadCount
          ? parseInt(rawData.myUnreadCount, 10)
          : Number(order.internalNotesUnreadCounts?.[me?.id] || 0),
      };
    });

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
      ...(useCursorPagination
        ? {
            hasMore,
            nextCursor:
              hasMore && records.length
                ? {
                    value: records[records.length - 1]?.created_at,
                    id: records[records.length - 1]?.id,
                  }
                : undefined,
          }
        : {}),
    };
  }

  /** Parse cursor from nested query (`cursor[value]`) or plain object / JSON string. */
  private parseListCursor(
    cursor: any,
  ): { value: string; id: string } | null {
    if (!cursor) return null;
    let parsed = cursor;
    if (typeof cursor === "string") {
      try {
        parsed = JSON.parse(cursor);
      } catch {
        return null;
      }
    }
    if (parsed?.value != null && parsed?.id != null) {
      return { value: String(parsed.value), id: String(parsed.id) };
    }
    return null;
  }

  // ========================================
  // ✅ SHARED ORDER LIST FILTERS
  // Used by list() and listGroupedByDate().
  // Requires caller to have joined: "status" (always),
  // "assignment" (when userId / hasActiveAssignment used),
  // "shipment" (when shippingStatus is used).
  // ========================================
  private applyOrdersListFilters(
    qb: SelectQueryBuilder<OrderEntity>,
    q?: any,
    me?: any,
  ) {
    if (q?.userId) {
      qb.andWhere("assignment.employeeId = :userId", {
        userId: q.userId,
      });
    }

    if (q?.tagId) {
      qb.andWhere(
        `EXISTS (
      SELECT 1
      FROM order_tags ot
      WHERE ot."orderId" = "order".id
        AND ot."tagId" = :tagId
    )`,
        { tagId: q.tagId },
      );
    }

    if (
      q?.hasActiveAssignment !== undefined &&
      q.hasActiveAssignment !== "all"
    ) {
      if (q.hasActiveAssignment === "true" || q.hasActiveAssignment === true) {
        qb.andWhere("assignment.isAssignmentActive = :isActive", {
          isActive: true,
        });
      } else if (
        q.hasActiveAssignment === "false" ||
        q.hasActiveAssignment === false
      ) {
        qb.andWhere(
          "assignment.isAssignmentActive IS NULL OR assignment.isAssignmentActive = :isActive",
          { isActive: false },
        );
      }
    }

    if (q?.statusId) {
      qb.andWhere("order.statusId = :statusId", {
        statusId: q.statusId,
      });
    } else if (q?.status) {
      const statusFilter = q.status;
      if (typeof statusFilter === "string" && statusFilter.includes(",")) {
        const statusCodes = statusFilter.split(",").map((s) => s.trim());
        qb.andWhere("status.code IN (:...statusCodes)", { statusCodes });
      } else if (!isNaN(Number(statusFilter))) {
        qb.andWhere("order.statusId = :statusId", {
          statusId: Number(statusFilter),
        });
      } else {
        qb.andWhere("status.code = :statusCode", {
          statusCode: String(statusFilter).trim(),
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

    if (q?.shippingCompanyId && q.shippingCompanyId !== "all") {
      if (q.shippingCompanyId === "none") {
        qb.andWhere("order.shippingCompanyId IS NULL");
      } else if (q.shippingCompanyId !== "all") {
        qb.andWhere("order.shippingCompanyId = :shippingCompanyId", {
          shippingCompanyId: q.shippingCompanyId,
        });
      }
    }

    if (q?.storeId) {
      if (q.storeId === "none") {
        qb.andWhere("order.storeId IS NULL");
      } else if (q.storeId !== "all") {
        qb.andWhere("order.storeId = :storeId", {
          storeId: q.storeId,
        });
      }
    }

    if (q?.lastCancelCauseId && q.lastCancelCauseId !== "all") {
      if (q.lastCancelCauseId === "none") {
        qb.andWhere("order.lastCancelCauseId IS NULL");
      } else {
        qb.andWhere("order.lastCancelCauseId = :lastCancelCauseId", {
          lastCancelCauseId: q.lastCancelCauseId,
        });
      }
    }

    if (q?.shippingStatus && q.shippingStatus !== "all") {
      qb.andWhere("shipment.status = :shippingStatus", {
        shippingStatus: q.shippingStatus,
      });
    }

    // Exact calendar day used by listGroupedByDate (DB DATE), so expand matches the group
    if (q?.groupDate) {
      qb.andWhere(`DATE(order.created_at)::text = :groupDate`, {
        groupDate: String(q.groupDate).trim(),
      });
    } else {
      DateFilterUtil.applyToQueryBuilder(
        qb,
        "order.created_at",
        q?.startDate,
        q?.endDate,
      );
    }

    if (q?.postponedStartDate || q?.postponedEndDate) {
      DateFilterUtil.applyToQueryBuilder(
        qb,
        "order.postponedDate",
        q?.postponedStartDate,
        q?.postponedEndDate,
      );
    }

    const search = String(q?.search ?? "").trim();
    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("order.orderNumber ILIKE :s", { s: `%${search}%` })
            .orWhere("order.customerName ILIKE :s", { s: `%${search}%` })
            .orWhere("order.phoneNumber ILIKE :s", { s: `%${search}%` });
        }),
      );
    }

    if (
      me?.id &&
      (q?.unreadInternalNotes === "true" || q?.unreadInternalNotes === true)
    ) {
      qb.andWhere(
        `COALESCE(("order"."internalNotesUnreadCounts" ->> :meUnreadFilterId)::int, 0) > 0`,
        { meUnreadFilterId: String(me.id) },
      );
    }
  }

  // ========================================
  // ✅ LIST ORDERS GROUPED BY DATE (daily statistics)
  // Days = UNION of:
  //   - order.created_at days (filtered orders)
  //   - shipment.shippedAt days (outbound shipments; independent of orders)
  // so a day with shipments but no created orders still appears.
  // ========================================
  async listGroupedByDate(me: any, q?: any) {
    const superAdmin = isSuperAdmin(me);
    let adminId = tenantId(me);

    if (superAdmin && q?.adminId) {
      adminId = q.adminId;
    }

    if (!superAdmin && !adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const page = Math.max(1, Number(q?.page ?? 1));
    const limit = Math.max(1, Number(q?.limit ?? 10));
    const orderDayExpr = `DATE(order.created_at)::text`;
    const shipDayExpr = `DATE(s."shippedAt")::text`;

    const delayedCondition = `
      "order"."shippedAt" IS NOT NULL
      AND "cityTenantConfig"."maxShippingDays" IS NOT NULL
      AND (
        (
          status.code = :delayedShippedCode
          AND (CURRENT_DATE - DATE("order"."shippedAt") + 1)
            > "cityTenantConfig"."maxShippingDays"
        )
        OR (
          status.code = :delayedDeliveredCode
          AND "order"."deliveredAt" IS NOT NULL
          AND (DATE("order"."deliveredAt") - DATE("order"."shippedAt") + 1)
            > "cityTenantConfig"."maxShippingDays"
        )
      )
    `;

    // ── Distinct days via SQL UNION + DB pagination (no full scan into memory) ─
    const orderDaysQb = this.buildGroupedByDateOrdersQb(adminId, q, me)
      .select(orderDayExpr, "day")
      .groupBy(orderDayExpr);

    const shipDaysQb = this.buildGroupedByDateShipmentsQb(adminId, q)
      .select(shipDayExpr, "day")
      .groupBy(shipDayExpr);

    const daysUnionSql = `(${orderDaysQb.getQuery()} UNION ${shipDaysQb.getQuery()})`;
    const daysParams = {
      ...orderDaysQb.getParameters(),
      ...shipDaysQb.getParameters(),
    };

    const [pageDayRows, totalGroupsRaw] = await Promise.all([
      this.dataSource
        .createQueryBuilder()
        .select("days.day", "day")
        .from(daysUnionSql, "days")
        .orderBy("days.day", "DESC")
        .offset((page - 1) * limit)
        .limit(limit)
        .setParameters(daysParams)
        .getRawMany(),
      this.dataSource
        .createQueryBuilder()
        .select("COUNT(*)", "count")
        .from(daysUnionSql, "days")
        .setParameters(daysParams)
        .getRawOne(),
    ]);

    const totalGroups = Number(totalGroupsRaw?.count) || 0;
    const pageDays = pageDayRows.map((r) => r.day).filter(Boolean);

    if (!pageDays.length) {
      return {
        total_records: totalGroups,
        current_page: page,
        per_page: limit,
        records: [],
      };
    }

    // ── Page stats (order aggregates + shipment counts) in parallel ─
    const orderStatsQb = this.buildGroupedByDateOrdersQb(adminId, q, me);
    orderStatsQb
      .select(orderDayExpr, "day")
      .addSelect("COUNT(order.id)", "totalOrders")
      .addSelect(
        `COUNT(CASE WHEN status.code = :deliveredCode THEN 1 END)`,
        "delivered",
      )
      .addSelect(
        `COUNT(CASE WHEN status.code = :postponedCode THEN 1 END)`,
        "postponed",
      )
      .addSelect(
        `COUNT(CASE WHEN status.code = :confirmedCode THEN 1 END)`,
        "confirmed",
      )
      .addSelect(
        `COUNT(CASE WHEN status.code = :cancelledCode THEN 1 END)`,
        "cancelled",
      )
      .addSelect(
        `COUNT(CASE WHEN ${delayedCondition} THEN 1 END)`,
        "delayed",
      )
      .addSelect("COALESCE(SUM(order.finalTotal), 0)", "totalAmount")
      .andWhere(`${orderDayExpr} IN (:...pageDays)`, { pageDays })
      .setParameter("deliveredCode", OrderStatus.DELIVERED)
      .setParameter("postponedCode", OrderStatus.POSTPONED)
      .setParameter("confirmedCode", OrderStatus.CONFIRMED)
      .setParameter("cancelledCode", OrderStatus.CANCELLED)
      .setParameter("delayedShippedCode", OrderStatus.SHIPPED)
      .setParameter("delayedDeliveredCode", OrderStatus.DELIVERED)
      .groupBy(orderDayExpr);

    const shipStatsQb = this.buildGroupedByDateShipmentsQb(adminId, q);
    shipStatsQb
      .select(shipDayExpr, "day")
      .addSelect("COUNT(*)::int", "shipped")
      .andWhere(`${shipDayExpr} IN (:...pageDays)`, { pageDays })
      .groupBy(shipDayExpr);

    const [orderStatsRows, shipStatsRows, tagStatsRows] = await Promise.all([
      orderStatsQb.getRawMany(),
      shipStatsQb.getRawMany(),
      this.buildGroupedByDateTagStatsQb(adminId, q, me, pageDays).getRawMany(),
    ]);

    const orderStatsByDay = new Map(
      orderStatsRows.map((row) => [
        row.day,
        {
          totalOrders: Number(row.totalOrders) || 0,
          delivered: Number(row.delivered) || 0,
          postponed: Number(row.postponed) || 0,
          confirmed: Number(row.confirmed) || 0,
          cancelled: Number(row.cancelled) || 0,
          delayed: Number(row.delayed) || 0,
          totalAmount: Number(row.totalAmount) || 0,
        },
      ]),
    );

    const shippedByDay = new Map(
      shipStatsRows.map((row) => [row.day, Number(row.shipped) || 0]),
    );

    const tagsByDay = new Map();
    for (const row of tagStatsRows) {
      const day = row.day;
      if (!day) continue;
      const list = tagsByDay.get(day) || [];
      list.push({
        id: row.tagId,
        name: row.tagName,
        color: row.tagColor || "#6C5CE7",
        count: Number(row.count) || 0,
      });
      tagsByDay.set(day, list);
    }

    const emptyOrderStats = {
      totalOrders: 0,
      delivered: 0,
      postponed: 0,
      confirmed: 0,
      cancelled: 0,
      delayed: 0,
      totalAmount: 0,
    };

    const records = pageDays.map((day) => {
      const orderStats = orderStatsByDay.get(day) || emptyOrderStats;
      return {
        date: day,
        statistics: {
          ...orderStats,
          shipped: shippedByDay.get(day) || 0,
          tags: tagsByDay.get(day) || [],
        },
      };
    });

    return {
      total_records: totalGroups,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  /** Filtered orders QB (joins + shared filters) for grouped-by-date stats. */
  private buildGroupedByDateOrdersQb(
    adminId: string | null,
    q?: any,
    me?: any,
  ) {
    const qb = this.orderRepo.createQueryBuilder("order");

    if (adminId) {
      qb.where("order.adminId = :adminId", { adminId });
    }

    qb.leftJoin("order.status", "status");
    qb.leftJoin("order.cityDetails", "cityDetails").leftJoin(
      "cityDetails.tenantConfigs",
      "cityTenantConfig",
      `cityTenantConfig.adminId = order.adminId`,
    );

    const needsAssignmentJoin =
      !!q?.userId ||
      (q?.hasActiveAssignment !== undefined &&
        q.hasActiveAssignment !== "all");

    if (needsAssignmentJoin) {
      qb.leftJoin(
        "order.assignments",
        "assignment",
        `assignment.id = (
        SELECT sub.id
        FROM order_assignments sub
        WHERE sub."orderId" = order.id
        ORDER BY sub."assignedAt" DESC
        LIMIT 1
      )`,
      );
    }

    const needsShipmentJoin =
      !!q?.shippingStatus && q.shippingStatus !== "all";

    if (needsShipmentJoin) {
      qb.leftJoin(
        "order.shipments",
        "shipment",
        `shipment.id = (
        SELECT s.id
        FROM shipments s
        WHERE s."trackingNumber" = "order"."trackingNumber"
        ORDER BY s."created_at" DESC
        LIMIT 1
      )`,
      );
    }

    this.applyOrdersListFilters(qb, q, me);
    return qb;
  }

  /** Tag counts per calendar day for filtered orders in grouped-by-date view. */
  private buildGroupedByDateTagStatsQb(
    adminId: string | null,
    q: any,
    me: any,
    pageDays: string[],
  ) {
    const orderDayExpr = `DATE(order.created_at)::text`;
    const qb = this.buildGroupedByDateOrdersQb(adminId, q, me);
    qb.innerJoin("order.orderTags", "groupOrderTag")
      .innerJoin("groupOrderTag.tag", "groupTag")
      .select(orderDayExpr, "day")
      .addSelect("groupTag.id", "tagId")
      .addSelect("groupTag.name", "tagName")
      .addSelect("groupTag.color", "tagColor")
      .addSelect("COUNT(DISTINCT order.id)", "count")
      .andWhere(`${orderDayExpr} IN (:...pageDays)`, { pageDays })
      .groupBy(orderDayExpr)
      .addGroupBy("groupTag.id")
      .addGroupBy("groupTag.name")
      .addGroupBy("groupTag.color")
      .orderBy(orderDayExpr, "DESC")
      .addOrderBy("count", "DESC")
      .addOrderBy("groupTag.name", "ASC");
    return qb;
  }

  /** Shipments with shippedAt set — day axis for outbound stats (not order-filtered). */
  private buildGroupedByDateShipmentsQb(adminId: string | null, q?: any) {
    const qb = this.dataSource
      .createQueryBuilder()
      .from("shipments", "s")
      .where(`s."shippedAt" IS NOT NULL`);

    if (adminId) {
      qb.andWhere(`s."adminId" = :shipAdminId`, { shipAdminId: adminId });
    }

    // Same period filter as orders, applied on shipment.shippedAt
    DateFilterUtil.applyToQueryBuilder(
      qb as any,
      `s."shippedAt"`,
      q?.startDate,
      q?.endDate,
    );

    return qb;
  }

  // ========================================
  // ✅ EXPORT ORDERS GROUPED BY CREATION DATE (daily statistics)
  // ========================================
  async exportGroupedByDate(me: any, q?: any) {
    const t = (
      key: Parameters<TranslationService["t"]>[0],
      options?: Parameters<TranslationService["t"]>[1],
    ) => this.translations.t(key, options);

    const { records: groups } = await this.listGroupedByDate(me, {
      ...q,
      page: 1,
      limit: 100000,
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      t("domains.orders.export_grouped_by_date_sheet"),
    );

    worksheet.columns = [
      { header: t("domains.orders.export_grouped_date"), key: "date", width: 18 },
      {
        header: t("domains.orders.export_grouped_total_orders"),
        key: "totalOrders",
        width: 15,
      },
      {
        header: t("domains.orders.export_grouped_confirmed"),
        key: "confirmed",
        width: 14,
      },
      {
        header: t("domains.orders.export_grouped_postponed"),
        key: "postponed",
        width: 14,
      },
      {
        header: t("domains.orders.export_grouped_cancelled"),
        key: "cancelled",
        width: 14,
      },
      {
        header: t("domains.orders.export_grouped_shipped"),
        key: "shipped",
        width: 14,
      },
      {
        header: t("domains.orders.export_grouped_delivered"),
        key: "delivered",
        width: 14,
      },
      {
        header: t("domains.orders.export_grouped_delayed"),
        key: "delayed",
        width: 14,
      },
      {
        header: t("domains.orders.export_grouped_total_amount"),
        key: "totalAmount",
        width: 18,
      },
      {
        header: t("domains.orders.export_grouped_tags"),
        key: "tags",
        width: 48,
      },
    ];

    groups.forEach((group) => {
      const tagStats = Array.isArray(group.statistics?.tags)
        ? group.statistics.tags
        : [];
      const tagsText = tagStats
        .map((tag) => `${tag.name}: ${tag.count ?? 0}`)
        .join(", ");

      worksheet.addRow({
        date: group.date,
        totalOrders: group.statistics.totalOrders,
        shipped: group.statistics.shipped,
        delivered: group.statistics.delivered,
        postponed: group.statistics.postponed,
        confirmed: group.statistics.confirmed,
        cancelled: group.statistics.cancelled,
        delayed: group.statistics.delayed,
        totalAmount: group.statistics.totalAmount,
        tags: tagsText,
      });
    });

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };

    return workbook.xlsx.writeBuffer();
  }

  // ========================================
  // ✅ LIST SHIPMENTS GROUPED BY shippedAt DATE (shipping tab groups view)
  // ========================================
  async listShipmentsGroupedByShippedDate(me: any, q?: any) {
    const superAdmin = isSuperAdmin(me);
    let adminId = tenantId(me);

    if (superAdmin && q?.adminId) {
      adminId = q.adminId;
    }

    if (!superAdmin && !adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const page = Math.max(1, Number(q?.page ?? 1));
    const limit = Math.max(1, Number(q?.limit ?? 10));
    const dayExpr = `DATE(shipment."shippedAt")::text`;

    const lateCondition = `
      "cityTenantConfig"."maxShippingDays" IS NOT NULL
      AND (CURRENT_DATE - DATE(shipment."shippedAt") + 1) > "cityTenantConfig"."maxShippingDays"
    `;

    const daysQb = this.buildShippedGroupsBaseQb(adminId, q);
    const [pageDayRows, totalGroupsRaw] = await Promise.all([
      daysQb
        .clone()
        .select(dayExpr, "day")
        .groupBy(dayExpr)
        .orderBy("day", "DESC")
        .offset((page - 1) * limit)
        .limit(limit)
        .getRawMany(),
      daysQb
        .clone()
        .select(`COUNT(DISTINCT ${dayExpr})`, "count")
        .getRawOne(),
    ]);

    const totalGroups = Number(totalGroupsRaw?.count) || 0;
    const pageDays = pageDayRows.map((r) => r.day).filter(Boolean);

    if (!pageDays.length) {
      return {
        total_records: totalGroups,
        current_page: page,
        per_page: limit,
        records: [],
      };
    }

    const statsQb = this.buildShippedGroupsBaseQb(adminId, q);
    statsQb
      .select(dayExpr, "day")
      .addSelect("COUNT(shipment.id)", "totalShipments")
      .addSelect(
        `COUNT(CASE WHEN shipment.status = :shippedDeliveredStatus THEN 1 END)`,
        "delivered",
      )
      .addSelect(
        `COUNT(CASE WHEN shipment.status = :shippedReturnedStatus THEN 1 END)`,
        "returned",
      )
      .addSelect(
        `COUNT(CASE WHEN ${lateCondition} THEN 1 END)`,
        "late",
      )
      .addSelect(
        `COUNT(CASE WHEN shipment.status = :shippedOutForDeliveryStatus THEN 1 END)`,
        "outForDelivery",
      )
      .andWhere(`${dayExpr} IN (:...pageDays)`, { pageDays })
      .setParameter("shippedDeliveredStatus", ShipmentStatus.DELIVERED)
      .setParameter("shippedReturnedStatus", ShipmentStatus.RETURNED_TO_WAREHOUSE)
      .setParameter("shippedOutForDeliveryStatus", ShipmentStatus.OUT_FOR_DELIVERY)
      .groupBy(dayExpr);

    const salesQb = this.buildShippedGroupsBaseQb(adminId, q);
    salesQb
      .select(dayExpr, "day")
      .addSelect(`"order".id`, "orderId")
      .addSelect(`MAX("order"."finalTotal")`, "finalTotal")
      .andWhere(`${dayExpr} IN (:...pageDays)`, { pageDays })
      .groupBy(dayExpr)
      .addGroupBy(`"order".id`);

    const companyQb = this.buildShippedGroupsBaseQb(adminId, q);
    companyQb
      .select(dayExpr, "day")
      .addSelect(`shipment."shippingCompanyId"`, "companyId")
      .addSelect("shippingCompany.name", "companyName")
      .addSelect("COUNT(shipment.id)", "count")
      .addSelect(
        `COUNT(CASE WHEN shipment.status = :companyOutForDeliveryStatus THEN 1 END)`,
        "current",
      )
      .andWhere(`${dayExpr} IN (:...pageDays)`, { pageDays })
      .setParameter("companyOutForDeliveryStatus", ShipmentStatus.OUT_FOR_DELIVERY)
      .groupBy(dayExpr)
      .addGroupBy(`shipment."shippingCompanyId"`)
      .addGroupBy("shippingCompany.name")
      .orderBy(dayExpr, "DESC")
      .addOrderBy("count", "DESC");

    const ticketQb = this.buildShippedGroupsOpenTicketsQb(adminId, q, pageDays);
    const tagQb = this.buildShippedGroupsTagStatsQb(adminId, q, pageDays);

    const [statsRows, salesRows, companyRows, ticketRows, tagRows] = await Promise.all([
      statsQb.getRawMany(),
      salesQb.getRawMany(),
      companyQb.getRawMany(),
      ticketQb.getRawMany(),
      tagQb.getRawMany(),
    ]);

    const salesByDay = new Map<string, number>();
    salesRows.forEach((row) => {
      const prev = salesByDay.get(row.day) || 0;
      salesByDay.set(row.day, prev + (Number(row.finalTotal) || 0));
    });

    const statsByDay = new Map(
      statsRows.map((row) => [
        row.day,
        {
          totalShipments: Number(row.totalShipments) || 0,
          delivered: Number(row.delivered) || 0,
          returned: Number(row.returned) || 0,
          late: Number(row.late) || 0,
          outForDelivery: Number(row.outForDelivery) || 0,
          openTickets: 0,
          totalAmount: salesByDay.get(row.day) || 0,
          companies: [] as Array<{
            companyId: string | null;
            companyName: string | null;
            count: number;
            current: number;
          }>,
          tags: [] as Array<{
            id: string;
            name: string;
            color: string | null;
            count: number;
          }>,
        },
      ]),
    );

    companyRows.forEach((row) => {
      const entry = statsByDay.get(row.day);
      if (!entry) return;
      entry.companies.push({
        companyId: row.companyId ?? null,
        companyName: row.companyName ?? null,
        count: Number(row.count) || 0,
        current: Number(row.current) || 0,
      });
    });

    ticketRows.forEach((row) => {
      const entry = statsByDay.get(row.day);
      if (!entry) return;
      entry.openTickets = Number(row.openTickets) || 0;
    });

    tagRows.forEach((row) => {
      const entry = statsByDay.get(row.day);
      if (!entry) return;
      entry.tags.push({
        id: row.tagId,
        name: row.tagName,
        color: row.tagColor ?? null,
        count: Number(row.count) || 0,
      });
    });

    const emptyStats = {
      totalShipments: 0,
      delivered: 0,
      returned: 0,
      late: 0,
      outForDelivery: 0,
      openTickets: 0,
      totalAmount: 0,
      companies: [],
      tags: [],
    };

    const records = pageDays.map((day) => ({
      date: day,
      statistics: statsByDay.get(day) || emptyStats,
    }));

    return {
      total_records: totalGroups,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  /**
   * Expand a shipped-date group: one row per ShipmentEntity (with its order),
   * not the orders list.
   */
  async listShipmentsForShippedGroupDate(me: any, q?: any) {
    const superAdmin = isSuperAdmin(me);
    let adminId = tenantId(me);

    if (superAdmin && q?.adminId) {
      adminId = q.adminId;
    }

    if (!superAdmin && !adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const groupDate = String(q?.shipmentGroupDate ?? "").trim();
    if (!groupDate) {
      throw new BadRequestException("shipmentGroupDate is required");
    }

    const cursor = this.parseListCursor(q?.cursor);
    const useCursorPagination =
      q?.useCursor === "true" ||
      q?.useCursor === true ||
      !!(cursor?.value && cursor?.id);
    const hasCursorValue = !!(cursor?.value && cursor?.id);
    const limit = Math.max(1, Number(q?.limit ?? 20));
    const sortDir: "ASC" | "DESC" = "DESC";

    const qb = this.buildShippedGroupsBaseQb(adminId, q);
    qb.andWhere(`DATE(shipment."shippedAt")::text = :shipmentGroupDate`, {
      shipmentGroupDate: groupDate,
    });

    this.applyShipmentGroupExpandFilters(qb, q);

    qb.orderBy(`shipment."shippedAt"`, sortDir).addOrderBy(
      "shipment.id",
      sortDir,
    );

    if (useCursorPagination && hasCursorValue) {
      const operator = sortDir === "DESC" ? "<" : ">";
      qb.andWhere(
        `(shipment."shippedAt", shipment.id) ${operator} (:cursorValue, :cursorId)`,
        {
          cursorValue: cursor.value,
          cursorId: cursor.id,
        },
      );
    }

    const skipTotal = useCursorPagination && hasCursorValue;
    const [totalRow, idRows] = await Promise.all([
      skipTotal
        ? Promise.resolve(null)
        : qb
            .clone()
            .select("COUNT(DISTINCT shipment.id)", "count")
            .orderBy()
            .getRawOne(),
      qb
        .clone()
        .select("shipment.id", "id")
        .addSelect("shipment.shippedAt", "shippedAt")
        .take(useCursorPagination ? limit + 1 : limit)
        .getRawMany(),
    ]);
    const total = skipTotal ? 0 : Number(totalRow?.count) || 0;

    const hasMore = useCursorPagination ? idRows.length > limit : undefined;
    if (hasMore) {
      idRows.length = limit;
    }

    const shipmentIds = idRows.map((row) => row.id).filter(Boolean);
    const shipments = shipmentIds.length
      ? await this.buildShippedGroupRowsQb(adminId, q)
          .andWhere("shipment.id IN (:...shipmentIds)", { shipmentIds })
          .getMany()
      : [];

    const shipmentById = new Map(shipments.map((s) => [s.id, s]));
    const ordered = shipmentIds
      .map((id) => shipmentById.get(id))
      .filter(Boolean) as ShipmentEntity[];

    const records = ordered.map((shipment) => {
      const order = shipment.order;
      return {
        ...order,
        id: order?.id,
        shipmentId: shipment.id,
        openTicketsCount: Number((order as any)?.openTicketsCount) || 0,
        shippedAt: shipment.shippedAt ?? order?.shippedAt,
        shippingCompany: shipment.shippingCompany ?? order?.shippingCompany,
        shipments: [
          {
            id: shipment.id,
            status: shipment.status,
            unifiedStatus: shipment.unifiedStatus,
            trackingNumber: shipment.trackingNumber,
            created_at: shipment.created_at,
            shippedAt: shipment.shippedAt,
            shippingCompanyId: shipment.shippingCompanyId,
          },
        ],
      };
    });

    const lastIdRow = idRows[idRows.length - 1];

    return {
      total_records: total,
      current_page: 1,
      per_page: limit,
      records,
      ...(useCursorPagination
        ? {
            hasMore,
            nextCursor:
              hasMore && lastIdRow
                ? {
                    value: lastIdRow.shippedAt,
                    id: lastIdRow.id,
                  }
                : undefined,
          }
        : {}),
    };
  }

  async exportShipmentsGroupedByShippedDate(me: any, q?: any) {
    const t = (
      key: Parameters<TranslationService["t"]>[0],
      options?: Parameters<TranslationService["t"]>[1],
    ) => this.translations.t(key, options);

    const { records: groups } = await this.listShipmentsGroupedByShippedDate(
      me,
      {
        ...q,
        page: 1,
        limit: 100000,
      },
    );

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      t("domains.orders.export_shipped_grouped_by_date_sheet"),
    );

    worksheet.columns = [
      { header: t("domains.orders.export_grouped_date"), key: "date", width: 18 },
      {
        header: t("domains.orders.export_shipped_grouped_total_shipments"),
        key: "totalShipments",
        width: 16,
      },
      {
        header: t("domains.orders.export_shipped_grouped_companies"),
        key: "companies",
        width: 40,
      },
      {
        header: t("domains.orders.export_grouped_delivered"),
        key: "delivered",
        width: 14,
      },
      {
        header: t("domains.orders.export_shipped_grouped_returned"),
        key: "returned",
        width: 14,
      },
      {
        header: t("domains.orders.export_grouped_delayed"),
        key: "late",
        width: 14,
      },
      {
        header: t("domains.orders.export_shipped_grouped_out_for_delivery"),
        key: "outForDelivery",
        width: 18,
      },
      {
        header: t("domains.orders.export_shipped_grouped_open_tickets"),
        key: "openTickets",
        width: 16,
      },
      {
        header: t("domains.orders.export_grouped_total_amount"),
        key: "totalAmount",
        width: 18,
      },
      {
        header: t("domains.orders.export_grouped_tags"),
        key: "tags",
        width: 48,
      },
    ];

    groups.forEach((group) => {
      const companies = Array.isArray(group.statistics?.companies)
        ? group.statistics.companies
        : [];
      const tagStats = Array.isArray(group.statistics?.tags)
        ? group.statistics.tags
        : [];

      worksheet.addRow({
        date: group.date,
        totalShipments: group.statistics?.totalShipments ?? 0,
        companies: companies
          .map((c) => {
            const name = c.companyName || t("common.not_applicable");
            return `${name}: ${c.count ?? 0} (${t("domains.orders.export_shipped_grouped_current")}: ${c.current ?? 0})`;
          })
          .join(", "),
        delivered: group.statistics?.delivered ?? 0,
        returned: group.statistics?.returned ?? 0,
        late: group.statistics?.late ?? 0,
        outForDelivery: group.statistics?.outForDelivery ?? 0,
        openTickets: group.statistics?.openTickets ?? 0,
        totalAmount: group.statistics?.totalAmount ?? 0,
        tags: tagStats
          .map((tag) => `${tag.name}: ${tag.count ?? 0}`)
          .join(", "),
      });
    });

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };

    return workbook.xlsx.writeBuffer();
  }

  async exportShipmentsForShippedGroupDate(me: any, q?: any) {
    const na = this.translations.t("common.not_applicable");
    const t = (
      key: Parameters<TranslationService["t"]>[0],
      options?: Parameters<TranslationService["t"]>[1],
    ) => this.translations.t(key, options);

    const { records } = await this.listShipmentsForShippedGroupDate(me, {
      ...q,
      useCursor: false,
      limit: 100000,
    });

    const exportData = records.map((order: any) => {
      const productsList =
        order.items
          ?.map(
            (item: any) =>
              `${item.variant?.product?.name || na} - ${item.variant?.sku || na} (x${item.quantity})`,
          )
          .join("; ") || na;
      const shipment = order.shipments?.[0];
      const assignment = order.assignments?.[0];
      const shippingDays = this.calcShippingDaysElapsed(
        order.shippedAt,
        order.status?.code === OrderStatus.DELIVERED ? order.deliveredAt : null,
      );

      return {
        createdAt: order.created_at
          ? new Date(order.created_at).toLocaleDateString()
          : na,
        orderNumber: order.orderNumber,
        trackingNumber:
          shipment?.trackingNumber || order.trackingNumber || na,
        customerName: order.customerName,
        products: productsList,
        finalTotal: order.finalTotal || 0,
        city: order.city || na,
        address: order.address || na,
        phoneNumber: order.phoneNumber || na,
        shippingCost: order.shippingCost || 0,
        shippingDays: shippingDays ?? na,
        status: order.status?.system
          ? order.status.code
          : order.status?.name || na,
        shipmentStatus: shipment?.status || na,
        shipmentDate: shipment?.created_at
          ? new Date(shipment.created_at).toLocaleDateString()
          : shipment?.shippedAt
            ? new Date(shipment.shippedAt).toLocaleDateString()
            : order.shippedAt
              ? new Date(order.shippedAt).toLocaleDateString()
              : na,
        shippingCompany:
          order.shippingCompany?.name || shipment?.shippingCompanyId || na,
        assignedEmployee: assignment?.employee?.name || na,
        openTicketsCount: order.openTicketsCount ?? 0,
      };
    });

    const groupDate = String(q?.shipmentGroupDate ?? "").trim();
    const sheetTitle = t("domains.orders.export_shipped_grouped_rows_sheet");
    const sheetName = (groupDate ? `${groupDate} - ${sheetTitle}` : sheetTitle).slice(
      0,
      31,
    );

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(sheetName);

    worksheet.columns = [
      {
        header: t("domains.orders.export_created_at"),
        key: "createdAt",
        width: 18,
      },
      {
        header: t("common.export_order_number"),
        key: "orderNumber",
        width: 18,
      },
      {
        header: t("domains.orders.export_tracking_number"),
        key: "trackingNumber",
        width: 22,
      },
      {
        header: t("domains.orders.export_customer_name"),
        key: "customerName",
        width: 25,
      },
      {
        header: t("domains.orders.export_products"),
        key: "products",
        width: 40,
      },
      {
        header: t("domains.orders.export_final_total"),
        key: "finalTotal",
        width: 15,
      },
      { header: t("domains.orders.export_city"), key: "city", width: 15 },
      {
        header: t("domains.orders.export_address"),
        key: "address",
        width: 35,
      },
      {
        header: t("domains.orders.export_phone_number"),
        key: "phoneNumber",
        width: 18,
      },
      {
        header: t("domains.orders.export_shipping_cost"),
        key: "shippingCost",
        width: 15,
      },
      {
        header: t("domains.orders.export_shipping_days"),
        key: "shippingDays",
        width: 15,
      },
      {
        header: t("domains.orders.export_order_status"),
        key: "status",
        width: 20,
      },
      {
        header: t("domains.orders.export_shipment_status"),
        key: "shipmentStatus",
        width: 20,
      },
      {
        header: t("domains.orders.export_shipment_date"),
        key: "shipmentDate",
        width: 18,
      },
      {
        header: t("common.export_shipping_company"),
        key: "shippingCompany",
        width: 20,
      },
      {
        header: t("domains.orders.export_assigned_employee"),
        key: "assignedEmployee",
        width: 22,
      },
      {
        header: t("domains.orders.export_shipped_grouped_open_tickets"),
        key: "openTicketsCount",
        width: 16,
      },
    ];

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };

    exportData.forEach((row) => {
      worksheet.addRow(row);
    });

    return workbook.xlsx.writeBuffer();
  }

  /** Rows QB for shipment group expand — loads shipment.order and display relations. */
  private buildShippedGroupRowsQb(adminId: string | null, q?: any) {
    const qb = this.dataSource
      .getRepository(ShipmentEntity)
      .createQueryBuilder("shipment")
      .innerJoinAndSelect("shipment.order", "order")
      .leftJoinAndSelect("shipment.shippingCompany", "shippingCompany")
      .leftJoinAndSelect("order.items", "items")
      .leftJoinAndSelect("items.variant", "variant")
      .leftJoinAndSelect("items.bundle", "bundle")
      .leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("order.cityDetails", "cityDetails")
      .leftJoinAndSelect(
        "cityDetails.tenantConfigs",
        "cityTenantConfig",
        `"cityTenantConfig"."adminId" = "order"."adminId"`,
      )
      .leftJoinAndSelect(
        "order.assignments",
        "assignment",
        `assignment.id = (
          SELECT sub.id
          FROM order_assignments sub
          WHERE sub."orderId" = "order"."id"
          ORDER BY sub."assignedAt" DESC
          LIMIT 1
        )`,
      )
      .leftJoinAndSelect("assignment.employee", "employee")
      .loadRelationCountAndMap(
        "order.openTicketsCount",
        "order.issues",
        "openIssue",
        (issueQb) =>
          issueQb
            .innerJoin("openIssue.status", "openIssueStatus")
            .andWhere(`"openIssueStatus".code NOT IN (:...closedIssueStatuses)`, {
              closedIssueStatuses: [IssueStatus.SOLVED, IssueStatus.CANCELLED],
            }),
      );

    this.applyShippedGroupsFilters(qb, adminId, q, { assignmentJoined: true });
    return qb;
  }

  /** Base QB for shipment groups — filters on shipment.shippedAt. */
  private buildShippedGroupsBaseQb(adminId: string | null, q?: any) {
    const qb = this.dataSource
      .getRepository(ShipmentEntity)
      .createQueryBuilder("shipment")
      .innerJoin("shipment.order", "order")
      .leftJoin("shipment.shippingCompany", "shippingCompany")
      .leftJoin("order.cityDetails", "cityDetails")
      .leftJoin(
        "cityDetails.tenantConfigs",
        "cityTenantConfig",
        `"cityTenantConfig"."adminId" = "order"."adminId"`,
      );

    this.applyShippedGroupsFilters(qb, adminId, q);
    return qb;
  }

  private applyShippedGroupsFilters(
    qb: SelectQueryBuilder<ShipmentEntity>,
    adminId: string | null,
    q?: any,
    opts?: { assignmentJoined?: boolean },
  ) {
    qb.andWhere(`shipment."shippedAt" IS NOT NULL`);

    if (adminId) {
      qb.andWhere(`shipment."adminId" = :adminId`, { adminId });
    }

    DateFilterUtil.applyToQueryBuilder(
      qb,
      `shipment."shippedAt"`,
      q?.shippedStartDate,
      q?.shippedEndDate,
    );

    if (q?.shippingCompanyId && q.shippingCompanyId !== "all") {
      if (q.shippingCompanyId === "none") {
        qb.andWhere(`shipment."shippingCompanyId" IS NULL`);
      } else {
        qb.andWhere(`shipment."shippingCompanyId" = :shippingCompanyId`, {
          shippingCompanyId: q.shippingCompanyId,
        });
      }
    }

    if (q?.userId) {
      if (!opts?.assignmentJoined) {
        qb.leftJoin(
          "order.assignments",
          "assignment",
          `assignment.id = (
            SELECT sub.id
            FROM order_assignments sub
            WHERE sub."orderId" = "order"."id"
            ORDER BY sub."assignedAt" DESC
            LIMIT 1
          )`,
        );
      }
      qb.andWhere(`assignment."employeeId" = :userId`, { userId: q.userId });
    }

    if (q?.lateShipping === "true" || q?.lateShipping === true) {
      qb.andWhere(`"cityTenantConfig"."maxShippingDays" IS NOT NULL`);
      qb.andWhere(
        `(CURRENT_DATE - DATE(shipment."shippedAt") + 1) > "cityTenantConfig"."maxShippingDays"`,
      );
    }

    const search = String(q?.search ?? "").trim();
    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where(`"order"."orderNumber" ILIKE :s`, { s: `%${search}%` })
            .orWhere(`"order"."customerName" ILIKE :s`, { s: `%${search}%` })
            .orWhere(`"order"."phoneNumber" ILIKE :s`, { s: `%${search}%` })
            .orWhere(`shipment."trackingNumber" ILIKE :s`, { s: `%${search}%` });
        }),
      );
    }
  }

  private parseShipmentGroupStatFilters(q?: any): string[] {
    const raw = q?.shipmentGroupStatFilters;
    if (!raw) return [];

    const values = Array.isArray(raw)
      ? raw
      : String(raw)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);

    const allowed = new Set([
      "delivered",
      "returned",
      "openTickets",
      "late",
    ]);

    return values.filter((value) => allowed.has(value));
  }

  /** Filters for expanded shipment group rows (company + stat pills). */
  private applyShipmentGroupExpandFilters(
    qb: SelectQueryBuilder<ShipmentEntity>,
    q?: any,
  ) {
    if (q?.shipmentGroupCompanyId === "none") {
      qb.andWhere(`shipment."shippingCompanyId" IS NULL`);
    } else if (q?.shipmentGroupCompanyId) {
      qb.andWhere(`shipment."shippingCompanyId" = :shipmentGroupCompanyId`, {
        shipmentGroupCompanyId: String(q.shipmentGroupCompanyId),
      });
    }

    const statFilters = this.parseShipmentGroupStatFilters(q);
    if (!statFilters.length) return;

    const lateCondition = `
      "cityTenantConfig"."maxShippingDays" IS NOT NULL
      AND (CURRENT_DATE - DATE(shipment."shippedAt") + 1) > "cityTenantConfig"."maxShippingDays"
    `;

    if (statFilters.includes("delivered")) {
      qb.andWhere(`shipment.status = :shipmentGroupDeliveredStatus`, {
        shipmentGroupDeliveredStatus: ShipmentStatus.DELIVERED,
      });
    }

    if (statFilters.includes("returned")) {
      qb.andWhere(`shipment.status = :shipmentGroupReturnedStatus`, {
        shipmentGroupReturnedStatus: ShipmentStatus.RETURNED_TO_WAREHOUSE,
      });
    }

    if (statFilters.includes("late")) {
      qb.andWhere(lateCondition);
    }

    if (statFilters.includes("openTickets")) {
      qb.andWhere(
        `EXISTS (
          SELECT 1
          FROM issues group_open_issue
          INNER JOIN issue_statuses group_open_issue_status
            ON group_open_issue_status.id = group_open_issue."statusId"
          WHERE group_open_issue."orderId" = "order".id
            AND group_open_issue."adminId" = shipment."adminId"
            AND group_open_issue."deleted_at" IS NULL
            AND group_open_issue_status.code NOT IN (:...groupOpenIssueClosedStatuses)
        )`,
        {
          groupOpenIssueClosedStatuses: [
            IssueStatus.SOLVED,
            IssueStatus.CANCELLED,
          ],
        },
      );
    }
  }

  /** Open tickets for shipment-group orders (status not SOLVED/CANCELLED). */
  private buildShippedGroupsOpenTicketsQb(
    adminId: string | null,
    q: any,
    pageDays: string[],
  ) {
    const dayExpr = `DATE(shipment."shippedAt")::text`;
    const qb = this.buildShippedGroupsBaseQb(adminId, q);
    qb.innerJoin(
      IssueEntity,
      "group_issue",
      `"group_issue"."orderId" = "order".id
        AND "group_issue"."adminId" = shipment."adminId"
        AND "group_issue"."deleted_at" IS NULL`,
    )
      .innerJoin(
        "issue_statuses",
        "group_issue_status",
        `"group_issue_status".id = "group_issue"."statusId"`,
      )
      .andWhere(`"group_issue_status".code NOT IN (:...closedIssueStatuses)`, {
        closedIssueStatuses: [IssueStatus.SOLVED, IssueStatus.CANCELLED],
      })
      .select(dayExpr, "day")
      .addSelect(`COUNT(DISTINCT "group_issue".id)`, "openTickets")
      .andWhere(`${dayExpr} IN (:...pageDays)`, { pageDays })
      .groupBy(dayExpr);
    return qb;
  }

  /** Tag counts per shipment-shipped day for grouped shipping view. */
  private buildShippedGroupsTagStatsQb(
    adminId: string | null,
    q: any,
    pageDays: string[],
  ) {
    const dayExpr = `DATE(shipment."shippedAt")::text`;
    const qb = this.buildShippedGroupsBaseQb(adminId, q);
    qb.innerJoin("order.orderTags", "groupOrderTag")
      .innerJoin("groupOrderTag.tag", "groupTag")
      .select(dayExpr, "day")
      .addSelect("groupTag.id", "tagId")
      .addSelect("groupTag.name", "tagName")
      .addSelect("groupTag.color", "tagColor")
      .addSelect("COUNT(DISTINCT shipment.id)", "count")
      .andWhere(`${dayExpr} IN (:...pageDays)`, { pageDays })
      .groupBy(dayExpr)
      .addGroupBy("groupTag.id")
      .addGroupBy("groupTag.name")
      .addGroupBy("groupTag.color")
      .orderBy(dayExpr, "DESC")
      .addOrderBy("count", "DESC")
      .addOrderBy("groupTag.name", "ASC");
    return qb;
  }

  async getShippedStatsByCompany(me: any, q?: any) {
    const superAdmin = isSuperAdmin(me);
    let adminId = tenantId(me);

    if (superAdmin && q?.adminId) {
      adminId = q.adminId;
    }

    if (!superAdmin && !adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    // Fetch shipping companies and order stats in parallel using Promise.all
    const [shippingResponse, rows] = await Promise.all([
      this.shippingService.activeIntegrations(me),
      (async () => {
        const qb = this.orderRepo
          .createQueryBuilder("order")
          .leftJoin("order.status", "status")
          .leftJoin("order.shippingCompany", "shipping")
          .leftJoin(
            "order.shipments",
            "shipment",
            `shipment.id = (SELECT s.id FROM shipments s WHERE s."trackingNumber" = "order"."trackingNumber" ORDER BY s."created_at" DESC LIMIT 1)`,
          )
          .leftJoin("order.cityDetails", "cityDetails")
          .leftJoin(
            "cityDetails.tenantConfigs",
            "cityTenantConfig",
            `cityTenantConfig.adminId = order.adminId`,
          )
          .select("shipping.id", "companyId")
          .addSelect("shipping.name", "companyName")
          .addSelect("COUNT(order.id)", "count")
          .addSelect("COALESCE(SUM(order.finalTotal), 0)", "totalFinalTotal")
          .where("status.code = :shippedCode", {
            shippedCode: OrderStatus.SHIPPED,
          });

        if (adminId) {
          qb.andWhere("order.adminId = :adminId", { adminId });
        }

        if (q?.lateShipping === "true" || q?.lateShipping === true) {
          qb.andWhere('"order"."shippedAt" IS NOT NULL');
          qb.andWhere('"cityTenantConfig"."maxShippingDays" IS NOT NULL');
          qb.andWhere(
            `(CURRENT_DATE - DATE("order"."shippedAt") + 1) > "cityTenantConfig"."maxShippingDays"`,
          );
        }

        qb.groupBy("shipping.id")
          .addGroupBy("shipping.name")
          .orderBy("COUNT(order.id)", "DESC");

        return qb.getRawMany();
      })(),
    ]);

    // Create a map to quickly look up order count and name by company ID
    const companyDataMap = new Map<
      string | null,
      { count: number; name: string | null; totalFinalTotal: number }
    >();
    rows.forEach((row) => {
      companyDataMap.set(row.companyId ?? null, {
        count: Number(row.count) || 0,
        name: row.companyName ?? null,
        totalFinalTotal: Number(row.totalFinalTotal) || 0,
      });
    });

    // Set to track which companies we've already added (for deduplication)
    const addedCompanyIds = new Set<string | null>();

    // Start with all active shipping companies
    const result = shippingResponse.integrations.map((company) => {
      const companyId = company.providerId ?? null;
      addedCompanyIds.add(companyId);
      const data = companyDataMap.get(companyId);
      return {
        companyId: companyId,
        companyName: company.name ?? null,
        count: data?.count || 0,
        totalFinalTotal: data?.totalFinalTotal || 0,
      };
    });

    // Add companies from query results not already in the list
    rows.forEach((row) => {
      const companyId = row.companyId ?? null;
      if (!addedCompanyIds.has(companyId)) {
        addedCompanyIds.add(companyId);
        const data = companyDataMap.get(companyId);
        result.push({
          companyId: companyId,
          companyName: companyId ? (data?.name ?? null) : "None",
          count: data?.count || 0,
          totalFinalTotal: data?.totalFinalTotal || 0,
        });
      }
    });

    // Ensure "None" entry is present
    if (!addedCompanyIds.has(null)) {
      addedCompanyIds.add(null);
      result.push({
        companyId: null,
        companyName: "None",
        count: 0,
        totalFinalTotal: 0,
      });
    }

    return result;
  }

  async getReturnPreparingStatsByCompany(me: any, q?: any) {
    const superAdmin = isSuperAdmin(me);
    let adminId = tenantId(me);

    if (superAdmin && q?.adminId) {
      adminId = q.adminId;
    }

    if (!superAdmin && !adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    // Fetch shipping companies and order stats in parallel using Promise.all
    const [shippingResponse, rows] = await Promise.all([
      this.shippingService.activeIntegrations(me),
      (async () => {
        const qb = this.orderRepo
          .createQueryBuilder("order")
          .leftJoin("order.status", "status")
          .leftJoin("order.shippingCompany", "shipping")
          .innerJoin("order.lastReturn", "lastReturn")
          .select("shipping.id", "companyId")
          .addSelect("shipping.name", "companyName")
          .addSelect("COUNT(order.id)", "count")
          .where("status.code = :returnPreparingCode", {
            returnPreparingCode: OrderStatus.RETURN_PREPARING,
          })
          .andWhere("lastReturn.status = :pendingStatus", {
            pendingStatus: ReturnRequestStatus.PENDING,
          });

        if (adminId) {
          qb.andWhere("order.adminId = :adminId", { adminId });
        }

        qb.groupBy("shipping.id")
          .addGroupBy("shipping.name")
          .orderBy("COUNT(order.id)", "DESC");

        return qb.getRawMany();
      })(),
    ]);

    // Create a map to quickly look up order count and name by company ID
    const companyDataMap = new Map<
      string | null,
      { count: number; name: string | null }
    >();
    rows.forEach((row) => {
      companyDataMap.set(row.companyId ?? null, {
        count: Number(row.count) || 0,
        name: row.companyName ?? null,
      });
    });

    // Set to track which companies we've already added (for deduplication)
    const addedCompanyIds = new Set<string | null>();

    // Start with all active shipping companies
    const result = shippingResponse.integrations.map((company) => {
      const companyId = company.providerId ?? null;
      addedCompanyIds.add(companyId);
      const data = companyDataMap.get(companyId);
      return {
        companyId: companyId,
        companyName: company.name ?? null,
        count: data?.count || 0,
      };
    });

    // Add companies from query results not already in the list
    rows.forEach((row) => {
      const companyId = row.companyId ?? null;
      if (!addedCompanyIds.has(companyId)) {
        addedCompanyIds.add(companyId);
        const data = companyDataMap.get(companyId);
        result.push({
          companyId: companyId,
          companyName: companyId ? (data?.name ?? null) : "None",
          count: data?.count || 0,
        });
      }
    });

    // Ensure "None" entry is present
    if (!addedCompanyIds.has(null)) {
      addedCompanyIds.add(null);
      result.push({
        companyId: null,
        companyName: "None",
        count: 0,
      });
    }

    return result;
  }

  async getOrderHistory(orderId: string, me: any) {
    const adminId = tenantId(me);
    const superAdmin = isSuperAdmin(me);
    if (!adminId && !superAdmin) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    return await this.historyRepo.find({
      where: {
        orderId,
        adminId,
      },
      relations: {
        changedByUser: true, // The user who performed the action
        fromStatus: true, // Previous status relation
        toStatus: true, // New status relation
        shippingCompany: true, // Optional: shipping company context
      },
      order: {
        created_at: "DESC", // Newest logs first
      },
    });
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
      .leftJoin("variant.product", "product")
      .leftJoinAndSelect("orders.lastReturn", "lastReturn")
      .leftJoinAndSelect("lastReturn.items", "returnItems")
      .leftJoin("returnItems.returnedVariant", "returnVariant")
      .leftJoin("returnVariant.product", "returnProduct")
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
        "returnVariant",
        "returnProduct",
      ])
      .where("manifest.adminId = :adminId", { adminId });

    if (q?.shippingCompanyId && q.shippingCompanyId !== "all") {
      if (q.shippingCompanyId === "none") {
        qb.andWhere("manifest.shippingCompanyId IS NULL");
      } else {
        qb.andWhere("manifest.shippingCompanyId = :coId", {
          coId: q.shippingCompanyId,
        });
      }
    }
    if (type && type !== "all") {
      qb.andWhere("manifest.type = :manifestType", {
        manifestType: type.trim(), // تذكر دائماً عمل trim للقيم النصية كما طلبت
      });
    }
    // Filter: Is Printed
    if (q?.isPrinted !== undefined && q.isPrinted !== "all") {
      if (q.isPrinted === "true") {
        qb.andWhere("manifest.lastPrintedAt IS NOT NULL");
      } else qb.andWhere("manifest.lastPrintedAt IS NULL");
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

  async markAsPrinted(id: string, me: any) {
    const adminId = tenantId(me);
    const userId = me.id;

    // Wrap everything in a transaction to ensure manifest update and status logs are atomic
    return await this.dataSource.transaction(async (manager) => {
      // 1. Get repositories scoped to this manager
      const manifestRepo = manager.getRepository(ShipmentManifestEntity);
      // 2. Check if manifest exists
      const manifest = await manifestRepo.findOne({
        where: { id, adminId },
        relations: ["orders"], // Assuming you need the orders tied to this manifest
      });

      if (!manifest) {
        throw new NotFoundException(
          this.translations.t("domains.orders.manifest_with_id_not_found", {
            args: { id },
          }),
        );
      }
      const orderIds = manifest.orders.map((o) => o.id);
      const isReturn = manifest.type === ShipmentManifestType.RETURN;
      const manifestLabel = isReturn ? "Return Manifest" : "Shipping Waybill";
      // [2025-12-24] Trim applied to manifest number for notes
      const manifestNumber = manifest.manifestNumber?.trim();

      if (!manifest.lastPrintedAt) {
        await this.logBulkOrderActions({
          manager,
          adminId,
          userId,
          orderIds,
          actionType: OrderActionType.MANIFEST_PRINTED,
          result: OrderActionResult.SUCCESS,
          details: await this.requestTranslations.tAsync(
            "domains.orders.log_initial_manifest_printed",
            adminId,
            { args: { manifestLabel, manifestNumber } },
          ), // ✅ Dynamic
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
          details: await this.requestTranslations.tAsync(
            "domains.orders.log_manifest_reprinted",
            adminId,
            { args: { manifestLabel } },
          ), // ✅ Dynamic
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

  async listLogs(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

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
        shippingCompanyId: q.shippingCompanyId,
      });
    }

    // 4. Filter by Employee (User)
    if (q?.userId) {
      qb.andWhere("log.userId = :userId", { userId: q.userId });
    }

    // 5. Date Range Filter
    DateFilterUtil.applyToQueryBuilder(
      qb,
      "log.createdAt",
      q?.startDate,
      q?.endDate,
    );

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
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

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
        shippingCompanyId: q.shippingCompanyId,
      });
    }

    if (q?.userId) {
      qb.andWhere("log.userId = :userId", { userId: q.userId });
    }

    DateFilterUtil.applyToQueryBuilder(
      qb,
      "log.createdAt",
      q?.startDate,
      q?.endDate,
    );

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

    const actionTypeKeys: Record<string, any> = {
      CONFIRMED: "domains.orders.actions.confirmed",
      COURIER_ASSIGNED: "domains.orders.actions.courier_assigned",
      WAYBILL_PRINTED: "domains.orders.actions.waybill_printed",
      WAYBILL_REPRINTED: "domains.orders.actions.waybill_reprinted",
      PREPARATION_STARTED: "domains.orders.actions.preparation_started",
      OUTGOING_DISPATCHED: "domains.orders.actions.outgoing_dispatched",
      REJECTED: "domains.orders.actions.rejected",
      RETURN_RECEIVED: "domains.orders.actions.return_received",
      RETRY_ATTEMPT: "domains.orders.actions.retry_attempt",
    };

    const resultKeys: Record<string, any> = {
      SUCCESS: "domains.orders.results.success",
      FAILED: "domains.orders.results.failed",
      WARNING: "domains.orders.results.warning",
      PENDING: "domains.orders.results.pending",
    };

    // 5. Prepare Data
    const exportData = logs.map((log) => {
      return {
        operationNumber: log.operationNumber || "N/A",
        orderNumber: log.order?.orderNumber || "N/A",
        actionType: log.actionType
          ? this.translations.t(actionTypeKeys[log.actionType]) ||
          log.actionType
          : "N/A",
        result: log.result
          ? this.translations.t(resultKeys[log.result]) || log.result
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
    const worksheet = workbook.addWorksheet(
      this.translations.t("domains.orders.export_operational_logs_sheet"),
    );

    const columns = [
      {
        header: this.translations.t("domains.orders.export_operation_id"),
        key: "operationNumber",
        width: 25,
      },
      {
        header: this.translations.t("domains.orders.export_order_number"),
        key: "orderNumber",
        width: 18,
      },
      {
        header: this.translations.t("domains.orders.export_action"),
        key: "actionType",
        width: 25,
      },
      {
        header: this.translations.t("domains.orders.export_result"),
        key: "result",
        width: 15,
      },
      {
        header: this.translations.t("domains.orders.export_performed_by"),
        key: "employee",
        width: 25,
      },
      {
        header: this.translations.t("domains.orders.export_shipping_company"),
        key: "shippingCompany",
        width: 20,
      },
      {
        header: this.translations.t("domains.orders.export_order_status"),
        key: "currentOrderStatus",
        width: 15,
      },
      {
        header: this.translations.t("domains.orders.export_details"),
        key: "details",
        width: 45,
      },
      {
        header: this.translations.t("domains.orders.export_created_at"),
        key: "createdAt",
        width: 20,
      },
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
      //   manager.findOneBy(OrderStatusEntity, { code: OrderStatus.SHIPPED }),
      // ]);
      const orderRepo = manager.getRepository(OrderEntity);
      // 1. Validate Orders (Status must be PACKED and match Shipping Company)
      const orders = await manager.find(OrderEntity, {
        where: { id: In(dto.orderIds), adminId },
        relations: ["status", "items", "items.variant"],
      });

      if (orders.length !== dto.orderIds.length) {
        throw new BadRequestException(
          this.translations.t("domains.orders.some_orders_not_found"),
        );
      }

      // Map to aggregate quantities per variant across all orders
      const variantDeductions = new Map<
        string,
        { qty: number; variant: ProductVariantEntity }
      >();

      for (const order of orders) {
        if (order.status.code !== OrderStatus.READY) {
          throw new BadRequestException(
            this.translations.t("domains.orders.order_cannot_ship_not_packed", {
              args: {
                orderNumber: order.orderNumber,
                statusName: order.status.name,
              },
            }),
          );
        }

        if (order.shippingCompanyId !== dto.shippingCompanyId) {
          throw new BadRequestException(
            this.translations.t("domains.orders.order_different_courier", {
              args: { orderNumber: order.orderNumber },
            }),
          );
        }

        // Collect items for stock validation
        for (const item of order.items) {
          if (!item.variant) continue;

          const variantId = item.variant.id;
          const qty = getMissingDeductionQuantity(item);
          if (qty <= 0) continue;

          const existing = variantDeductions.get(variantId) || {
            qty: 0,
            variant: item.variant,
          };
          variantDeductions.set(variantId, {
            qty: existing.qty + qty,
            variant: item.variant,
          });
        }
      }

      // 1.1 Perform stock validation for all orders in the manifest
      if (variantDeductions.size > 0) {
        const stockCheckItems = Array.from(variantDeductions.entries()).map(
          ([variantId, data]) => ({
            variantId,
            quantity: data.qty,
            variant: data.variant,
            sku: data.variant.sku,
          }),
        );

        await this.validateStockAvailability(adminId, stockCheckItems, {
          isDeduction: true,
          errorMessagePrefix: this.translations.t(
            "domains.orders.manifest_insufficient_stock_prefix",
          ),
        });
      }

      // 2. Generate Manifest Number (e.g., MAN-20260316-001)
      const dateStr = Date.now(); // YYYYMMDD
      const count = await manager.count(ShipmentManifestEntity, {
        where: { adminId },
      });
      const manifestNumber = `MAN-${dateStr}-${(count + 1).toString().padStart(3, "0")}`;

      // 1.2 Update statuses and deduct stock
      const readyStatus = await this.findStatusByCode(
        OrderStatus.READY,
        adminId,
        manager,
      );
      const shippedStatus = await this.findStatusByCode(
        OrderStatus.SHIPPED,
        adminId,
        manager,
      );

      // Only update orders that are currently in READY status
      const ordersToUpdate = orders.filter(
        (o) => o.statusId === readyStatus.id,
      );
      const orderIdsToUpdate = ordersToUpdate.map((o) => o.id);

      if (orderIdsToUpdate.length > 0) {
        await orderRepo.update(
          {
            id: In(orderIdsToUpdate),
            statusId: readyStatus.id,
          },
          {
            statusId: shippedStatus.id,
            shippedAt: new Date(),
          },
        );

        // Update active shipments status to OUT_FOR_DELIVERY
        const orderIds = ordersToUpdate.map((order) => order.id);

        if (orderIds.length > 0) {
          // 1. Fetch the latest matching shipment ID for each order
          const latestShipments = await manager
            .getRepository(ShipmentEntity)
            .createQueryBuilder("shipment")
            .innerJoin(
              "orders",
              "order",
              "order.id = shipment.orderId AND order.trackingNumber = shipment.trackingNumber",
            )
            .where("shipment.orderId IN (:...orderIds)", { orderIds })
            // Distinguish latest per order using database DISTINCT ON (Postgres)
            // OR fetch all and filter in memory if order list is small
            .orderBy("shipment.orderId")
            .addOrderBy("shipment.created_at", "DESC")
            .getMany();

          // Deduplicate in Node.js to guarantee only the latest per order ID
          const uniqueShipments = Array.from(
            new Map(latestShipments.map((s) => [s.orderId, s])).values(),
          );

          // 2. Perform one batch update
          if (uniqueShipments.length > 0) {
            const shippedAt = new Date();
            uniqueShipments.forEach((s) => {
              s.status = ShipmentStatus.OUT_FOR_DELIVERY;
              if (!s.shippedAt) {
                s.shippedAt = shippedAt;
              }
            });
            await manager.save(uniqueShipments);
          }
        }

        await this.bulkLogStatusChange({
          adminId,
          manager,
          userId,
          notes: `Assigned to Manifest: ${manifestNumber}`,
          orderStatusChanges: orderIdsToUpdate.map((orderId) => ({
            orderId,
            fromStatusId: readyStatus.id,
            toStatusId: shippedStatus.id,
          })),
        });

        await this.deductStockForMultipleOrders(
          manager,
          orderIdsToUpdate,
          adminId,
        );
      }

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
        details: await this.requestTranslations.tAsync(
          "domains.orders.log_order_dispatched",
          adminId,
          { args: { manifestNumber, driverName: dto.driverName || "N/A" } },
        ),
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
      const orders = await orderRepo.find({
        where: {
          adminId,
          id: In(dto.orderIds),
        },
        relations: ["lastReturn", "lastReturn.items", "items", "status"],
      });

      const returns = orders.map((order) => order.lastReturn).filter(Boolean);

      if (returns.length !== dto.orderIds.length) {
        throw new BadRequestException(
          this.translations.t(
            "domains.orders.not_all_orders_have_return_requests",
          ),
        );
      }

      if (returns.length === 0) {
        throw new BadRequestException(
          this.translations.t("domains.orders.no_valid_return_requests"),
        );
      }

      const invalidOrders = orders.filter(
        (o) => o.status.code !== OrderStatus.RETURN_PREPARING,
      );

      if (invalidOrders.length > 0) {
        // ✅ 3. LOG ACTION FAIL for every invalid order
        await Promise.all(
          invalidOrders.map(async (o) =>
            this.logOrderAction({
              manager,
              adminId,
              userId,
              orderId: o.id,
              actionType: OrderActionType.MANIFEST_PRINTED, // Tracking manifest attempt
              result: OrderActionResult.FAILED,
              details: await this.requestTranslations.tAsync(
                "domains.orders.log_failed_add_to_manifest",
                adminId,
                { args: { statusCode: o.status.code } },
              ),
            }),
          ),
        );

        const nums = invalidOrders.map((o) => o.orderNumber).join(", ");
        throw new BadRequestException(
          this.translations.t("domains.orders.orders_not_return_preparing", {
            args: { orderNumbers: nums },
          }),
        );
      }

      for (const ret of returns) {
        const order = orders.find((o) => o.id === ret.orderId);

        // التحقق من شركة الشحن
        if (order.shippingCompanyId !== dto.shippingCompanyId) {
          throw new BadRequestException(
            this.translations.t("domains.orders.order_different_courier", {
              args: { orderNumber: order.orderNumber },
            }),
          );
        }
      }

      // [2025-12-24] Generate a clean, trimmed manifest number
      const dateStr = Date.now();
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

      // 1.2 Update statuses for returns
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
      const partiallyReturnedStatus = await this.findStatusByCode(
        OrderStatus.PARTIALLY_RETURNED,
        adminId,
        manager,
      );

      if (orderIds.length > 0) {
        const fullReturnOrderIds: string[] = [];
        const partialReturnOrderIds: string[] = [];

        for (const order of orders) {
          if (!orderIds.includes(order.id)) continue;
          const isPartial = isPartiallyReturnedForManifest(
            order.items || [],
            order.lastReturn?.items || [],
          );
          if (isPartial) partialReturnOrderIds.push(order.id);
          else fullReturnOrderIds.push(order.id);
        }

        const updatePayload = {
          returnedAt: new Date(),
          returnedById: userId,
          updatedByUserId: userId,
          manifestId: manifest.id,
        };

        if (fullReturnOrderIds.length > 0) {
          await orderRepo.update(
            {
              id: In(fullReturnOrderIds),
              statusId: preparingStatus.id,
            },
            {
              statusId: returnedStatus.id,
              ...updatePayload,
            },
          );
        }

        if (partialReturnOrderIds.length > 0) {
          await orderRepo.update(
            {
              id: In(partialReturnOrderIds),
              statusId: preparingStatus.id,
            },
            {
              statusId: partiallyReturnedStatus?.id || returnedStatus.id,
              ...updatePayload,
            },
          );
        }

        // Update active shipments status to RETURNED_TO_WAREHOUSE

        if (orderIds.length > 0) {
          const shipmentRepo = manager.getRepository(ShipmentEntity);

          // 1. Fetch the latest matching shipment ID for each order
          const latestShipments = await shipmentRepo
            .createQueryBuilder("shipment")
            .innerJoin(
              "orders",
              "order",
              "order.id = shipment.orderId AND order.trackingNumber = shipment.trackingNumber",
            )
            .where("shipment.orderId IN (:...orderIds)", { orderIds })
            .orderBy("shipment.orderId")
            .addOrderBy("shipment.created_at", "DESC")
            .getMany();

          // Deduplicate in memory to guarantee only the single latest shipment per order ID
          const uniqueShipmentIds = Array.from(
            new Map(latestShipments.map((s) => [s.orderId, s.id])).values(),
          );

          // 2. Perform one batch update
          if (uniqueShipmentIds.length > 0) {
            latestShipments.forEach(
              (s) => (s.status = ShipmentStatus.RETURNED_TO_WAREHOUSE),
            );
            await manager.save(latestShipments);
          }
        }

        const returnIds = orders
          .map((order) => order.lastReturnId)
          .filter(Boolean);

        if (returnIds.length) {
          await returnRepo.update(
            {
              id: In(returnIds),
            },
            {
              status: ReturnRequestStatus.APPROVED,
            },
          );
        }

        // Update variants with the received damaged quantities
        const variantDamagedMap = new Map<
          string,
          { customer: number; company: number }
        >();
        for (const ret of returns) {
          for (const item of ret.items || []) {
            const damagedQty = item.damagedQuantity || 0;
            if (damagedQty <= 0 || !item.returnedVariantId) continue;
            const entry = variantDamagedMap.get(item.returnedVariantId) || {
              customer: 0,
              company: 0,
            };
            if (item.damageResponsibility === DamageResponsibility.INTERNAL) {
              entry.customer += damagedQty;
            } else if (
              item.damageResponsibility === DamageResponsibility.COMPANY
            ) {
              entry.company += damagedQty;
            }
            variantDamagedMap.set(item.returnedVariantId, entry);
          }
        }

        for (const [variantId, { customer, company }] of variantDamagedMap) {
          if (customer <= 0 && company <= 0) continue;
          const updateSet: any = {};
          if (customer > 0) {
            updateSet.customerDamagedQuantity = () =>
              `"customerDamagedQuantity" + ${customer}`;
          }
          if (company > 0) {
            updateSet.companyDamagedQuantity = () =>
              `"companyDamagedQuantity" + ${company}`;
          }
          await manager
            .createQueryBuilder()
            .update(ProductVariantEntity)
            .set(updateSet)
            .where("id = :variantId", { variantId })
            .execute();
        }

        // Return restocked quantities back to stock (atomic updates)
        const variantRestockMap = new Map<string, number>();
        for (const ret of returns) {
          for (const item of ret.items || []) {
            const restockQty = item.restockQuantity || 0;
            if (restockQty <= 0 || !item.returnedVariantId) continue;
            variantRestockMap.set(
              item.returnedVariantId,
              (variantRestockMap.get(item.returnedVariantId) || 0) + restockQty,
            );
          }
        }

        for (const [variantId, qty] of variantRestockMap) {
          await manager
            .createQueryBuilder()
            .update(ProductVariantEntity)
            .set({ stockOnHand: () => `"stockOnHand" + ${qty}` })
            .where("id = :variantId", { variantId })
            .execute();
        }

        await this.bulkLogStatusChange({
          adminId,
          manager,
          userId,
          notes: this.translations.t(
            "domains.orders.log_added_to_return_manifest",
            { args: { manifestNumber } },
          ),
          orderStatusChanges: [
            ...fullReturnOrderIds.map((orderId) => ({
              orderId,
              fromStatusId: preparingStatus.id,
              toStatusId: returnedStatus.id,
            })),
            ...partialReturnOrderIds.map((orderId) => ({
              orderId,
              fromStatusId: preparingStatus.id,
              toStatusId: partiallyReturnedStatus?.id || returnedStatus.id,
            })),
          ],
        });
      }

      await this.logBulkOrderActions({
        manager,
        adminId,
        userId,
        orderIds,
        actionType: OrderActionType.MANIFEST_PRINTED,
        result: OrderActionResult.SUCCESS,
        details: await this.requestTranslations.tAsync(
          "domains.orders.log_order_in_return_manifest",
          adminId,
          { args: { manifestNumber } },
        ),
      });

      return {
        success: true,
        manifestId: manifest.id,
        manifestNumber,
        count: returns.length,
      };
    });
  }

  async getManifestDetail(id: string, me: any) {
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

    if (!manifest) {
      throw new NotFoundException(
        this.translations.t("domains.orders.manifest_not_found"),
      );
    }
    return manifest;
  }

  async getReturnsSummaryStats(me: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

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
    todayStart?.setHours(0, 0, 0, 0);

    //
    const [readyStatus, shippedStatus] = await Promise.all([
      this.findStatusByCode(OrderStatus.READY, adminId),
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

    const [distributedStatus, printedStatus] = await Promise.all([
      this.findStatusByCode(OrderStatus.DISTRIBUTED.trim(), adminId),
      this.findStatusByCode(OrderStatus.PRINTED.trim(), adminId),
    ]);

    const [notPrinted, printed] = await Promise.all([
      this.orderRepo.count({
        where: {
          adminId,
          statusId: distributedStatus?.id,
        },
      }),
      this.orderRepo.count({
        where: {
          adminId,
          statusId: printedStatus?.id,
        },
      }),
    ]);

    return {
      printed,
      notPrinted,
    };
  }

  async getRejectedOrdersStats(me: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

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
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

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

    return await this.dataSource.transaction(async (manager) => {
      // 1. Fetch orders to get IDs and current Status (needed for logs)
      const orders = await manager.find(OrderEntity, {
        where: { adminId, orderNumber: In(orderNumbers) },
        relations: ["items", "items.variant"],
        select: ["id", "statusId", "orderNumber"],
      });

      if (orders.length === 0) {
        return {
          success: false,
          message: this.translations.t("domains.orders.no_orders_found"),
        };
      }

      const orderIds = orders.map((o) => o.id);

      // 2. Fetch the PRINTED status entity
      const printedStatus = await this.findStatusByCode(
        OrderStatus.PRINTED,
        adminId,
        manager,
      );
      if (!printedStatus) {
        throw new Error(
          this.translations.t("domains.orders.printed_status_not_configured"),
        );
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

      if (orderIds.length > 0) {
        const shipmentRepo = manager.getRepository(ShipmentEntity);

        // 1. Fetch the latest matching shipment ID for each order
        const latestShipments = await shipmentRepo
          .createQueryBuilder("shipment")
          .innerJoin(
            "orders",
            "order",
            "order.id = shipment.orderId AND order.trackingNumber = shipment.trackingNumber",
          )
          .where("shipment.orderId IN (:...orderIds)", { orderIds })
          .orderBy("shipment.orderId")
          .addOrderBy("shipment.created_at", "DESC")
          .getMany();

        // Deduplicate in memory to guarantee only the single latest shipment per order ID
        const uniqueShipmentIds = Array.from(
          new Map(latestShipments.map((s) => [s.orderId, s.id])).values(),
        );

        // 2. Perform one batch update
        if (uniqueShipmentIds.length > 0) {
          latestShipments.forEach((s) => (s.status = ShipmentStatus.PREPARING));
          await manager.save(latestShipments);
        }
      }

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
          details: await this.requestTranslations.tAsync(
            "domains.orders.log_initial_waybill_printed",
            adminId,
          ),
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
          details: await this.requestTranslations.tAsync(
            "domains.orders.log_waybill_reprinted",
            adminId,
          ),
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

  async logError(
    orderId: string,
    sku: string,
    me: any,
    reason: ScanReason,
    phase: ScanLogType,
    notes: string,
  ) {
    const userId = me?.id;
    const adminId = tenantId(me);

    await this.logFailedScan(
      this.dataSource.manager,
      orderId,
      sku,
      userId,
      adminId,
      reason,
      phase,
      notes,
    );
  }

  async scanItem(orderId: string, sku: string, me: any, itemId: string) {
    const userId = me?.id;
    const adminId = tenantId(me);

    return await this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(OrderEntity, {
        where: { id: orderId, adminId },
        relations: ["items", "items.variant", "status"],
        select: ["id", "statusId", "adminId"],
      });

      if (!order) {
        throw new NotFoundException(
          this.translations.t("domains.orders.order_not_found"),
        );
      }
      const oldStatusId = order.statusId;
      const allowedStatuses = [OrderStatus.PRINTED, OrderStatus.PREPARING];

      if (!allowedStatuses.includes(order.status.code as OrderStatus)) {
        // await this.logFailedScan(
        //   manager,
        //   orderId,
        //   sku,
        //   userId,
        //   adminId,
        //   ScanReason.INVALID_STATUS,
        //   ScanLogType.PREPARATION,
        //   `Current: ${order.status.code}`,
        // );

        const currentStatusText = order.status.name || order.status.code;
        return {
          success: false,
          isOrderComplete: true,
          message: this.translations.t("domains.orders.scan_invalid_status", {
            args: { currentStatus: currentStatusText },
          }),
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

      const skuItems = order.items.filter(
        (i) => i.variant?.sku?.trim() === sku.trim(),
      );

      let item = skuItems[0];

      if (itemId && skuItems.length > 1) {
        item = skuItems.find((i) => i.id === itemId) ?? item;
      }

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
        return {
          success: false,
          code: ScanReason.SKU_NOT_IN_ORDER,
          message: this.translations.t("domains.orders.sku_not_in_order", {
            args: { sku },
          }),
        };
      }

      let newScannedQuantity = 0;
      if (item.scannedQuantity >= item.quantity) {
        newScannedQuantity = item.scannedQuantity;
      } else {
        const result = await manager
          .createQueryBuilder()

          .update(OrderItemEntity)
          .set({
            scannedQuantity: () => "COALESCE(scannedQuantity, 0) + 1",
          })
          .where("orderId = :orderId", { orderId })
          .where("id = :id", { id: item.id })
          .andWhere("COALESCE(scannedQuantity, 0) < quantity")
          .returning(["id", "scannedQuantity", "quantity"])
          .execute();

        if (result.affected === 0) {
          await this.logFailedScan(
            manager,
            orderId,
            sku,
            userId,
            adminId,
            ScanReason.ALREADY_FULLY_SCANNED,
            ScanLogType.PREPARATION,
          );
          return {
            success: false,
            code: ScanReason.ALREADY_FULLY_SCANNED,
            message: this.translations.t(
              "domains.orders.item_already_fully_scanned",
            ),
            scanned: item.scannedQuantity,
          };
        }
        newScannedQuantity = result.raw[0].scannedQuantity;
      }

      const remainingCount = await manager
        .createQueryBuilder()
        .select("COUNT(1)", "count")
        .from(OrderItemEntity, "oi")
        .where("oi.orderId = :orderId", { orderId })
        .andWhere("COALESCE(oi.scannedQuantity, 0) < oi.quantity")
        .getRawOne();

      const isOrderComplete = Number(remainingCount.count) === 0;

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

        // Update active shipment status to READY_TO_SHIP
        const shipmentRepo = manager.getRepository(ShipmentEntity);
        const shipment = await shipmentRepo
          .createQueryBuilder("shipment")
          .where("shipment.orderId = :orderId", { orderId: order.id })
          .andWhere(
            'shipment.trackingNumber = (SELECT "trackingNumber" FROM orders WHERE id = :orderId)',
            { orderId: order.id },
          )
          .orderBy("shipment.created_at", "DESC")
          .getOne();

        if (shipment) {
          // If you already have the shipment object in memory:
          shipment.status = ShipmentStatus.READY_TO_SHIP;
          await shipmentRepo.save(shipment);
        }

        await this.logStatusChange({
          adminId,
          orderId: order.id,
          fromStatusId: order.statusId, // Current status is now Preparing
          toStatusId: readyStatus.id,
          userId,
          notes: this.translations.t("domains.orders.log_all_items_scanned"),

          manager,
        });
        await this.logOrderAction({
          manager,
          adminId,
          userId,
          orderId: order.id,
          actionType: OrderActionType.PREPARATION_STARTED,
          result: OrderActionResult.SUCCESS,
          details: await this.requestTranslations.tAsync(
            "domains.orders.log_preparation_completed",
            adminId,
          ),
        });
      }

      return {
        success: true,
        code: "success",
        scanned: newScannedQuantity,
        isOrderComplete,
      };
    });
  }

  // async scanForShipping(orderId: string, sku: string, me: any) {
  //   const userId = me?.id;
  //   const adminId = tenantId(me);

  //   return await this.dataSource.transaction(async (manager) => {
  //     const order = await manager.findOne(OrderEntity, {
  //       where: { id: orderId, adminId },
  //       relations: ["items", "items.variant", "status"],
  //       select: ["id", "statusId", "adminId"],
  //     });

  //     if (!order) throw new NotFoundException(this.translations.t('domains.orders.order_not_found'));
  //     const oldStatusId = order.statusId;
  //     if (order.status.code !== OrderStatus.READY) {
  //       // await this.logFailedScan(
  //       //   manager,
  //       //   orderId,
  //       //   sku,
  //       //   userId,
  //       //   adminId,
  //       //   ScanReason.INVALID_STATUS,
  //       //   ScanLogType.SHIPPING,
  //       //   `Current: ${order.status.code}`,
  //       // );
  //       return {
  //         success: false,
  //         message: this.translations.t('domains.orders.order_must_be_ready_for_shipping_scan'),
  //       };
  //     }

  //     const item = order.items.find(
  //       (i) => i.variant?.sku?.trim() === sku.trim(),
  //     );

  //     if (!item) {
  //       await this.logFailedScan(
  //         manager,
  //         orderId,
  //         sku,
  //         userId,
  //         adminId,
  //         ScanReason.SKU_NOT_IN_ORDER,
  //         ScanLogType.SHIPPING,
  //       );
  //       return { success: false, message: this.translations.t('domains.orders.sku_not_in_order', { args: { sku } }) };
  //     }

  //     if (item.shippingScannedQuantity >= item.quantity) {
  //       await this.logFailedScan(
  //         manager,
  //         orderId,
  //         sku,
  //         userId,
  //         adminId,
  //         ScanReason.ALREADY_FULLY_SCANNED,
  //         ScanLogType.SHIPPING,
  //       );
  //       return {
  //         success: false,
  //         message: this.translations.t('domains.orders.item_already_fully_scanned_shipping'),
  //       };
  //     }

  //     const result = await manager
  //       .createQueryBuilder()
  //       .update(OrderItemEntity)
  //       .set({
  //         shippingScannedQuantity: () => "COALESCE(shippingScannedQuantity, 0) + 1",
  //       })
  //       .where("orderId = :orderId", { orderId })
  //       .andWhere(`"variantId" IN (SELECT v.id FROM product_variants v WHERE v.sku = :sku)`, { sku: sku.trim() })
  //       .andWhere("COALESCE(shippingScannedQuantity, 0) < quantity")
  //       .returning(["id", "shippingScannedQuantity", "quantity"])
  //       .execute();

  //     if (result.affected === 0) {
  //       await this.logFailedScan(
  //         manager, orderId, sku, userId, adminId, ScanReason.ALREADY_FULLY_SCANNED,
  //         ScanLogType.SHIPPING,
  //       );
  //       return { success: false, message: this.translations.t('domains.orders.item_already_fully_scanned_shipping') };
  //     }

  //     const remainingCount = await manager
  //       .createQueryBuilder()
  //       .select("COUNT(1)", "count")
  //       .from(OrderItemEntity, "oi")
  //       .where("oi.orderId = :orderId", { orderId })
  //       .andWhere("COALESCE(oi.shippingScannedQuantity, 0) < oi.quantity")
  //       .getRawOne();
  //     const newShippingScannedQuantity = result.raw[0].shippingScannedQuantity;
  //     const isShippingReady = Number(remainingCount.count) === 0;

  //     if (isShippingReady) {
  //       const packedStatus = await manager.findOneBy(OrderStatusEntity, {
  //         code: OrderStatus.PACKED,
  //       });

  //       const shippedStatus = await manager.findOneBy(OrderStatusEntity, {
  //         code: OrderStatus.PACKED,
  //       });
  //       await manager.update(OrderEntity, order.id, {
  //         statusId: shippedStatus.id,
  //       });
  //       // ✅ Log the transition: READY -> PACKED
  //       await this.logStatusChange({
  //         adminId,
  //         orderId: order.id,
  //         fromStatusId: oldStatusId,
  //         toStatusId: packedStatus.id,
  //         userId,
  //         notes: "Automatic: Shipping scan completed (All items packed)",
  //         manager,
  //       });
  //     }

  //     return {
  //       success: true,
  //       scanned: newShippingScannedQuantity,
  //       total: item.quantity,
  //       isShippingReady,
  //     };
  //   });
  // }

  private async logFailedScan(
    manager: EntityManager,
    orderId: string,
    sku: string,
    userId: string,
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

    // 2. Update the JSON column atomically in the database
    const fieldKey =
      phase === ScanLogType.PREPARATION ? "preparation" : "shipping";

    await manager
      .createQueryBuilder()
      .update(OrderEntity)
      .set({
        failedScanCounts: () => `jsonb_set(
          COALESCE("failedScanCounts", '{"preparation": 0, "shipping": 0}'::jsonb),
          '{${fieldKey}}',
          (COALESCE(("failedScanCounts"->>'${fieldKey}')::int, 0) + 1)::text::jsonb
        )`,
      })
      .where("id = :orderId", { orderId })
      .execute();
  }
  async getOrderScanLogs(orderId: string, phase: ScanLogType, me: any) {
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

  async getManifestScanLogs(manifestId: string, me: any) {
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

  async get(me: any, id: string, manager?: EntityManager) {
    const adminId = tenantId(me);
    const superAdmin = isSuperAdmin(me);

    const repo = manager ? manager.getRepository(OrderEntity) : this.orderRepo;
    if (!superAdmin && !adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      );

    const qb = repo
      .createQueryBuilder("order")
      .leftJoinAndSelect("order.returnRequests", "returnRequests")
      .leftJoinAndSelect("returnRequests.items", "returnItems")
      .leftJoinAndSelect("returnItems.returnedVariant", "retVariant")
      .leftJoinAndSelect("retVariant.product", "retProduct")
      .leftJoinAndSelect("returnItems.originalItem", "retOrigItem")
      .leftJoinAndSelect("retOrigItem.variant", "retOrigVariant")
      .leftJoinAndSelect("retOrigVariant.product", "retOrigProduct")
      .leftJoinAndSelect("order.items", "items")
      .leftJoinAndSelect("items.variant", "variant")
      .leftJoinAndSelect("items.bundle", "bundle")
      .leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("order.statusHistory", "statusHistory")
      .leftJoinAndSelect("statusHistory.fromStatus", "fromStatus")
      .leftJoinAndSelect("statusHistory.toStatus", "toStatus")
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("order.orderTags", "orderTags")
      .leftJoinAndSelect("orderTags.tag", "orderTag")
      .leftJoinAndSelect("order.shippingCompany", "shippingCompany")
      .leftJoinAndSelect("order.store", "store")
      .leftJoinAndSelect("order.lastCancelCause", "lastCancelCause")
      .leftJoinAndSelect("order.lastInternalNote", "lastInternalNote")
      .leftJoinAndSelect("lastInternalNote.author", "lastInternalNoteAuthor")
      .leftJoinAndSelect("order.cityDetails", "cityDetails")
      .leftJoinAndSelect(
        "cityDetails.tenantConfigs",
        "cityTenantConfig",
        "cityTenantConfig.adminId = order.adminId",
      )
      .leftJoinAndSelect("order.replacementResult", "replacementResult")
      .leftJoinAndSelect("replacementResult.originalOrder", "repOrder")
      .leftJoinAndSelect("replacementResult.items", "bridgeItems")
      .leftJoinAndSelect("bridgeItems.originalOrderItem", "origItem")
      .leftJoinAndSelect("origItem.variant", "bridgeVar")
      .leftJoinAndSelect("bridgeVar.product", "bridgeNewProd")
      .leftJoinAndSelect("bridgeItems.newVariant", "newBridgeVar")
      .leftJoinAndSelect("newBridgeVar.product", "newBridgeProd")
      // Filter assignments to only include the active one
      .leftJoinAndSelect(
        "order.assignments",
        "assignment",
        `assignment.id = (SELECT sub.id FROM order_assignments sub WHERE sub."orderId" = order.id ORDER BY sub."assignedAt" DESC LIMIT 1)`,
      )
      .leftJoinAndSelect("assignment.employee", "employee");

    if (superAdmin) {
      qb.leftJoinAndSelect("order.admin", "admin");
    }

    const order = await qb
      .leftJoinAndSelect(
        "order.shipments",
        "shipments",
        `shipments."trackingNumber" = "order"."trackingNumber"`,
      )
      .leftJoinAndSelect("shipments.shippingCompany", "shipmentShippingCompany")
      .where(
        new Brackets((qb) => {
          if (isUuid) {
            qb.where("order.id = :id", { id });
          } else {
            qb.where("order.orderNumber = :id", { id })
              .orWhere("order.trackingNumber = :id", { id })
              .orWhere("shipments.trackingNumber = :id", { id });
          }
        }),
      )
      .andWhere(
        new Brackets((qb) => {
          if (superAdmin) {
            qb.where("1=1");
          } else {
            qb.andWhere("order.adminId = :adminId", { adminId });
          }
        }),
      )
      .getOne();

    if (!order) {
      throw new BadRequestException(
        this.translations.t("domains.orders.order_not_found"),
      );
    }

    (order as any).myUnreadCount = Number(
      order.internalNotesUnreadCounts?.[me?.id] || 0,
    );
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

    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const order = await repo
      .createQueryBuilder("order")
      .leftJoinAndSelect("order.items", "items")
      .leftJoinAndSelect("items.variant", "variant")
      .leftJoinAndSelect("items.bundle", "bundle")
      .leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("order.statusHistory", "statusHistory")
      .leftJoinAndSelect("statusHistory.fromStatus", "fromStatus")
      .leftJoinAndSelect("statusHistory.toStatus", "toStatus")
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("order.shippingCompany", "shippingCompany")
      .leftJoinAndSelect("order.store", "store")
      .leftJoinAndSelect(
        "order.assignments",
        "assignment",
        `assignment.id = (SELECT sub.id FROM order_assignments sub WHERE sub."orderId" = order.id ORDER BY sub."assignedAt" DESC LIMIT 1)`,
      )
      .leftJoinAndSelect("assignment.employee", "employee")
      .leftJoinAndSelect("order.replacementResult", "replacementResult")
      .leftJoinAndSelect("replacementResult.originalOrder", "repOrder")
      .leftJoinAndSelect("replacementResult.items", "bridgeItems")
      .leftJoinAndSelect("bridgeItems.originalOrderItem", "origItem")
      .leftJoinAndSelect("origItem.variant", "bridgeVar")
      .leftJoinAndSelect("bridgeVar.product", "bridgeNewProd")
      .leftJoinAndSelect("bridgeItems.newVariant", "newBridgeVar")
      .leftJoinAndSelect("newBridgeVar.product", "newBridgeProd")
      // 🔥 Search by orderNumber instead of ID
      .where("order.orderNumber = :orderNumber", { orderNumber })
      .andWhere("order.adminId = :adminId", { adminId })
      .getOne();

    if (!order) {
      throw new BadRequestException(
        this.translations.t("domains.orders.order_not_found"),
      );
    }

    return order;
  }

  // ========================================
  // ✅ CREATE ORDER
  // ========================================
  async create(me: any, dto: CreateOrderDto, ipAddress?: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

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
    // Generate order number
    const orderNumber = await this.generateOrderNumber(adminId);
    const usageResult = await this.walletService.processOrderUsage(
      me,
      1,
      manager,
      orderNumber,
    );

    // Get variants
    const variantIds = dto.items.map((it) => it.variantId);
    const variants =
      variantIds.length === 0
        ? []
        : await manager
          .createQueryBuilder(ProductVariantEntity, "variant")
          .leftJoin("variant.product", "product")
          .addSelect(["variant", "product.id", "product.wholesalePrice"])
          .where("variant.adminId = :adminId", { adminId })
          .andWhere("variant.id IN (:...variantIds)", { variantIds })
          .getMany();

    const variantMap = new Map(variants.map((v) => [v.id, v]));

    // Check stock availability
    await this.validateStockAvailability(adminId, dto.items, { variantMap });

    // Create order items
    const items = dto.items.map((it) => {
      const variant = variantMap.get(it.variantId)!;
      const unitPrice = it.unitPrice;
      const unitCost = variant.unitCost ?? variant.product?.wholesalePrice ?? 0;
      const lineTotal = Number(unitPrice * it.quantity).toFixed(2);
      const lineProfit = Number((unitPrice - unitCost) * it.quantity).toFixed(
        2,
      );

      const item = manager.create(OrderItemEntity, {
        adminId,
        variantId: it.variantId,
        quantity: it.quantity,
        isAdditional: it.isAdditional !== undefined ? false : it.isAdditional,
        unitPrice,
        bundleId: it.bundleId ? it.bundleId : null,
        unitCost,
        lineTotal,
        lineProfit,
      } as any);

      return item;
    });

    // Calculate totals
    const { productsTotal, finalTotal, profit } = this.calculateTotals(
      items,
      dto.shippingCost ?? 0,
      dto.discount ?? 0,
      dto.additionalFees ?? 0,
    );

    const itemsSignature = this.generateItemsSignature(items, variantMap);
    const normalizedPhoneNumber = normalizeEgyptianPhoneNumber(dto.phoneNumber);

    // Get settings for duplicate window and auto-cancel
    const settings =
      await this.clientSettingsService.getCachedSettings(adminId);
    const windowHours = settings?.duplicateWindowHours ?? 24;
    const autoCancel = settings?.autoCancelDuplicates ?? false;

    // Check for duplicates within the configured window
    const previousOrders = await manager.find(OrderEntity, {
      where: {
        adminId,
        normalizedPhoneNumber,
        itemsSignature,
        created_at: MoreThan(
          new Date(Date.now() - windowHours * 60 * 60 * 1000),
        ),
      },
      order: { created_at: "ASC" },
      select: ["id", "orderNumber", "duplicateCount", "originalOrderNumber"],
    });

    const duplicateCount = previousOrders.length;
    let originalOrderNumber = null;

    if (duplicateCount > 0) {
      // The first order in the list is either the root or points to the root
      const rootOrder = previousOrders[0];
      originalOrderNumber =
        rootOrder.originalOrderNumber || rootOrder.orderNumber;
    }

    const defaultStatus = await this.getDefaultStatus(adminId);
    let initialStatusId = defaultStatus.id;

    // If auto-cancel is enabled and it's a duplicate, set status to CANCELLED
    if (autoCancel && duplicateCount > 0) {
      const duplicateStatus = await this.findStatusByCode(
        OrderStatus.DUPLICATE,
        adminId,
      );
      if (duplicateStatus) {
        initialStatusId = duplicateStatus.id;
      }
    }

    if (dto.shippingCompanyId && dto.shippingCompanyId !== "none") {
      const companyId = dto.shippingCompanyId;
      const company = await this.shippingRepo.findOne({
        where: { id: companyId },
      });
      if (!company) {
        throw new BadRequestException(
          this.translations.t("domains.orders.invalid_shipping_company"),
        );
      }

      const integration = await this.shippingIntegrationRepo.findOne({
        where: {
          shippingCompanyId: companyId,
          adminId,
        },
      });

      if (!integration || !integration.isActive) {
        throw new BadRequestException(
          this.translations.t("domains.orders.shipping_company_not_active", {
            args: { companyName: company.name },
          }),
        );
      }
    }

    if (dto.storeId) {
      const store = await manager.findOne(StoreEntity, {
        where: { id: dto.storeId, adminId },
      });

      if (!store) {
        throw new BadRequestException(
          this.translations.t("domains.orders.invalid_store"),
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
      cityId: dto.cityId,
      area: dto.area,
      landmark: dto.landmark,
      deposit: dto.deposit,
      paymentMethod: dto.paymentMethod,
      secondPhoneNumber: dto.secondPhoneNumber ?? null,
      allowOpenPackage: dto.allowOpenPackage ?? false,
      paymentStatus: dto.paymentStatus ?? PaymentStatus.PENDING,
      shippingCompanyId:
        dto.shippingCompanyId && dto.shippingCompanyId !== "none"
          ? dto.shippingCompanyId
          : null,
      storeId: dto.storeId ? dto.storeId : null,
      shippingCost: dto.shippingCost ?? 0,
      discount: dto.discount ?? 0,
      additionalFees: dto.additionalFees ?? 0,
      productsTotal,
      finalTotal,
      profit,
      itemsSignature,
      duplicateCount,
      originalOrderNumber,
      notes: dto.notes,
      customerNotes: dto.customerNotes,
      statusId: initialStatusId,
      items,
      createdByUserId: me?.id,
      shippingMetadata: dto.shippingMetadata,
    } as any);
    
    const saved = await manager.save(OrderEntity, order);

    // Update the transaction with the orderId if we have one
    if (usageResult.transaction) {
      usageResult.transaction.orderId = saved.id;
      await manager.save(usageResult.transaction);
    }

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
      fromStatusId: initialStatusId,
      toStatusId: initialStatusId,
      userId: me?.id,
      notes:
        duplicateCount > 0
          ? `Order created (Duplicate of ${originalOrderNumber})`
          : "Order created",
      ipAddress,
      manager,
    });

    // 🔥 Trigger Auto-Assignment Queue (after commit)
    const queryRunner = manager.queryRunner;
    if (queryRunner) {
      if (!queryRunner.data.postCommitTasks) {
        queryRunner.data.postCommitTasks = [];
      }
      queryRunner.data.postCommitTasks.push(async () => {
        try {
          await this.autoAssignmentQueueService.addAutoAssignmentJob({
            adminId,
            orderIds: [saved.id],
          });
        } catch (error) {
          console.error(
            "Error triggering auto-assignment after commit:",
            error,
          );
        }
      });
    } else {
      await this.autoAssignmentQueueService.addAutoAssignmentJob({
        adminId,
        orderIds: [saved.id],
      });
    }

    // 🔥 Trigger Achievement Queue (after commit)
    if (queryRunner) {
      queryRunner.data.postCommitTasks.push(async () => {
        try {
          this.onboardingAchievementService.enqueueAchievement(
            adminId,
            GettingStartedAchievementType.FIRST_ORDER_CREATED,
          );
        } catch (error) {
          console.error("Error triggering achievement after commit:", error);
        }
      });
    } else {
      this.onboardingAchievementService.enqueueAchievement(
        adminId,
        GettingStartedAchievementType.FIRST_ORDER_CREATED,
      );
    }

    return saved;
  }

  // ========================================
  // ✅ UPDATE ORDER
  // ========================================
  async update(
    me: any,
    id: string,
    dto: UpdateOrderDto,
    ipAddress?: string,
    options?: { skipStockValidation?: boolean },
  ) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const order = await manager
        .createQueryBuilder(OrderEntity, "order")
        .leftJoinAndSelect("order.items", "items")
        .leftJoinAndSelect("items.variant", "variant")
        .leftJoinAndSelect("items.bundle", "bundle")
        .leftJoinAndSelect("variant.product", "product")
        // .leftJoinAndSelect("order.statusHistory", "statusHistory")
        // .leftJoinAndSelect("statusHistory.fromStatus", "fromStatus")
        // .leftJoinAndSelect("statusHistory.toStatus", "toStatus")
        // .leftJoinAndSelect("order.shippingCompany", "shippingCompany")
        // .leftJoinAndSelect("order.store", "store")
        .leftJoinAndSelect("order.status", "status")
        .where("order.id = :id", { id })
        .andWhere("order.adminId = :adminId", { adminId })
        .getOne();

      await this.throwIfDelivered(
        order,
        this.translations.t("domains.orders.cannot_update_closed"),
      );
      const shippingRepo = manager.getRepository(ShippingCompanyEntity);
      const storeRepo = manager.getRepository(StoreEntity);
      const integrationRepo = manager.getRepository(ShippingIntegrationEntity);

      if (
        order.status?.system &&
        (order.status.code === OrderStatus.SHIPPED ||
          order.status.code === OrderStatus.DELIVERED)
      ) {
        throw new BadRequestException(
          this.translations.t("domains.orders.cannot_update_shipped_delivered"),
        );
      }
      if (dto.shippingCompanyId == "none") {
        order.shippingCompanyId = null;
      } else if (dto.shippingCompanyId) {
        const companyId = dto.shippingCompanyId;
        const company = await shippingRepo.findOne({
          where: { id: companyId },
        });
        if (!company) {
          throw new BadRequestException(
            this.translations.t("domains.orders.invalid_shipping_company"),
          );
        }

        const integration = await integrationRepo.findOne({
          where: {
            shippingCompanyId: companyId,
            adminId,
          },
        });

        if (!integration || !integration.isActive) {
          throw new BadRequestException(
            this.translations.t("domains.orders.shipping_company_not_active", {
              args: { companyName: company.name },
            }),
          );
        }
        order.shippingCompanyId = companyId;
      }

      if (dto.storeId) {
        const store = await storeRepo.findOne({
          where: { id: dto.storeId, adminId },
        });

        if (!store) {
          throw new BadRequestException(
            this.translations.t("domains.orders.invalid_store"),
          );
        }
      }
      let currentOrderItems = [...order.items];
      // --- 1. PROCESS REMOVED ITEMS ---
      if (dto.removedItems && dto.removedItems.length > 0) {
        const removedVariantIds = dto.removedItems.map((i) => i.variantId);

        // Helper to build a stable composite key that differentiates
        // standalone variant rows from bundle-variant rows.
        const key = (variantId: string, bundleId?: string) =>
          bundleId ? `${variantId}::${bundleId}` : `${variantId}::null`;

        // 1-a. Keep bundle-aware: an item is "actually removed" only if there
        // is no item in dto.items with the same (variantId, bundleId) pair.
        const dtoItemKeys = new Set(
          dto.items.map((i) => key(i.variantId, i.bundleId)),
        );
        const itemsToRemove = dto.removedItems.filter(
          (i) => !dtoItemKeys.has(key(i.variantId, i.bundleId)),
        );

        if (itemsToRemove.length > 0) {
          // 2. Fetch the exact OrderItem rows that match the removed items
          // split into bundle-aware queries so we never strip a variant from
          // the wrong bundle (or from a standalone order item).
          const standaloneVariantIds = itemsToRemove
            .filter((i) => !i.bundleId)
            .map((i) => i.variantId);
          const bundleItems = itemsToRemove.filter((i) => !!i.bundleId);

          const findConditions: any[] = [];
          if (standaloneVariantIds.length > 0) {
            findConditions.push({
              adminId,
              orderId: order.id,
              variantId: In(standaloneVariantIds),
              bundleId: IsNull(),
            });
          }
          for (const b of bundleItems) {
            findConditions.push({
              adminId,
              orderId: order.id,
              variantId: b.variantId,
              bundleId: b.bundleId,
            });
          }

          const RemovedOrderItems = await manager.find(OrderItemEntity, {
            where: findConditions.length ? findConditions : undefined,
            relations: {
              variant: true,
            },
          });

          const RemovedItemsMap = new Map(
            RemovedOrderItems.map((v) => [key(v.variantId, v.bundleId), v]),
          );
          const variantsToUpdate = new Map<string, ProductVariantEntity>();
          // 3. Release reserved stock based on the OrderItem's quantity
          for (const item of itemsToRemove) {
            const removedItem = RemovedItemsMap.get(
              key(item.variantId, item.bundleId),
            );
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
          const removedEntityIds = new Set(RemovedOrderItems.map((r) => r.id));
          if (RemovedOrderItems.length > 0) {
            await manager.remove(OrderItemEntity, RemovedOrderItems);
          }

          // Update the local array for subsequent total calculations
          currentOrderItems = currentOrderItems.filter(
            (i) => !removedEntityIds.has(i.id),
          );
        }
      }

      if (dto.items && dto.items.length > 0) {
        const newVariantIds = dto.items.map((i) => i.variantId);

        const variants = await manager.find(ProductVariantEntity, {
          where: { adminId, id: In(newVariantIds) } as any,
          relations: {
            product: true,
          },
        });
        const variantMap = new Map(variants.map((v) => [v.id, v]));

        const itemsToSave = [];
        const modifiedVariants = new Set<ProductVariantEntity>(); // Use a Set to avoid duplicate saves

        // Reuse the composite-key helper we declared above (re-declare in case this
        // ever moves outside the lexical scope, but currently inside same if-block
        // — just compute a local copy for cleanliness.)
        const dtoKey = (variantId: string, bundleId?: string) =>
          bundleId ? `${variantId}::${bundleId}` : `${variantId}::null`;
        const existingItemByKey = new Map(
          currentOrderItems.map((oi) => [
            dtoKey(oi.variantId, oi.bundleId),
            oi,
          ]),
        );

        for (const dtoItem of dto.items) {
          const variant = variantMap.get(dtoItem.variantId);
          if (!variant) {
            throw new BadRequestException(
              this.translations.t("domains.orders.variant_id_not_found", {
                args: { variantId: dtoItem.variantId },
              }),
            );
          }

          const k = dtoKey(dtoItem.variantId, dtoItem.bundleId);
          const existingItem = existingItemByKey.get(k) ?? null;

          const oldQty = existingItem ? existingItem.quantity : 0;
          const newQty = dtoItem.addQuantity
            ? oldQty + dtoItem.quantity
            : dtoItem.quantity;
          const qtyDiff = newQty - oldQty;

          // 1. Stock Validation
          if (qtyDiff > 0 && !options?.skipStockValidation) {
            await this.validateStockAvailability(
              adminId,
              [{ variantId: dtoItem.variantId, quantity: qtyDiff, variant }],
              {
                errorMessagePrefix: this.translations.t(
                  "domains.orders.insufficient_stock_prefix",
                ),
              },
            );
          }

          // 2. Update variant in memory
          if (qtyDiff !== 0) {
            variant.reserved = Math.max(0, (variant.reserved || 0) + qtyDiff);
            modifiedVariants.add(variant);
          }

          // 3. Prepare OrderItemEntity
          if (existingItem) {
            // Update existing — keep it matched by the exact composite key,
            // so updating bundle A's variant row never hits bundle B's row.
            existingItem.quantity = newQty;
            existingItem.unitPrice = dtoItem.unitPrice;
            if (dtoItem.isAdditional !== undefined) {
              existingItem.isAdditional = dtoItem.isAdditional;
            }

            existingItem.bundleId = dtoItem.bundleId ? dtoItem.bundleId : null;
            existingItem.lineTotal = Number(
              (newQty * dtoItem.unitPrice).toFixed(2),
            );
            existingItem.lineProfit = Number(
              ((dtoItem.unitPrice - existingItem.unitCost) * newQty).toFixed(2),
            );

            const idx = currentOrderItems.indexOf(existingItem);
            if (idx > -1) currentOrderItems[idx] = existingItem;
            itemsToSave.push(existingItem);
          } else {
            // Create new
            const unitCost =
              variant.unitCost ?? variant.product?.wholesalePrice ?? 0;
            const newItem = manager.create(OrderItemEntity, {
              adminId,
              orderId: order.id,
              variantId: dtoItem.variantId,
              quantity: newQty,
              unitPrice: dtoItem.unitPrice,
              unitCost: unitCost,
              bundleId: dtoItem.bundleId ? dtoItem.bundleId : null,
              isAdditional: dtoItem.isAdditional ?? false,
              lineTotal: Number((newQty * dtoItem.unitPrice).toFixed(2)),
              lineProfit: Number(
                ((dtoItem.unitPrice - unitCost) * newQty).toFixed(2),
              ),
            } as any);

            newItem.variant = variant; // Attach for signature generation
            currentOrderItems.push(newItem);
            itemsToSave.push(newItem);
            existingItemByKey.set(k, newItem); // keep map coherent if same key re-occurs
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
      order.itemsSignature = this.generateItemsSignature(order.items);

      // Update basic fields
      Object.assign(order, {
        customerName:
          dto.customerName !== undefined
            ? dto.customerName
            : order.customerName,
        phoneNumber:
          dto.phoneNumber !== undefined ? dto.phoneNumber : order.phoneNumber,
        secondPhoneNumber:
          dto.secondPhoneNumber !== undefined
            ? dto.secondPhoneNumber
            : order.secondPhoneNumber,
        allowOpenPackage:
          dto.allowOpenPackage !== undefined
            ? dto.allowOpenPackage
            : order.allowOpenPackage,
        email: dto.email !== undefined ? dto.email : order.email,
        address: dto.address !== undefined ? dto.address : order.address,
        city: dto.city !== undefined ? dto.city : order.city,
        cityId: !!dto.cityId ? dto.cityId : order.cityId,
        area: dto.area !== undefined ? dto.area : order.area,
        paymentMethod:
          dto.paymentMethod !== undefined
            ? dto.paymentMethod
            : order.paymentMethod,
        storeId: !!dto.storeId ? dto.storeId : order.storeId,
        shippingCost:
          dto.shippingCost !== undefined
            ? dto.shippingCost
            : order.shippingCost,
        discount: dto.discount !== undefined ? dto.discount : order.discount,
        additionalFees:
          dto.additionalFees !== undefined
            ? dto.additionalFees
            : order.additionalFees,
        notes: dto.notes !== undefined ? dto.notes : order.notes,
        customerNotes:
          dto.customerNotes !== undefined
            ? dto.customerNotes
            : order.customerNotes,
        trackingNumber:
          dto.trackingNumber !== undefined
            ? dto.trackingNumber
            : order.trackingNumber,
        updatedByUserId: me?.id,
        landmark: dto.landmark !== undefined ? dto.landmark : order.landmark,
        deposit: dto.deposit !== undefined ? dto.deposit : order.deposit,
        shippingMetadata: dto.shippingMetadata
          ? { ...order.shippingMetadata, ...dto.shippingMetadata }
          : order.shippingMetadata,
      });

      // Recalculate if needed

      const { productsTotal, finalTotal, profit } = this.calculateTotals(
        order.items.map((it: any) => ({
          unitPrice: it.unitPrice,
          unitCost: it.unitCost,
          quantity: it.quantity,
        })),
        order.shippingCost,
        order.discount,
        order.additionalFees,
      );
      order.productsTotal = productsTotal;
      order.finalTotal = finalTotal;
      order.profit = profit;

      const updatedOrder = await manager.save(OrderEntity, order);

      await this.notificationService.create({
        userId: adminId,
        type: NotificationType.ORDER_UPDATED,
        title: await this.requestTranslations.tAsync(
          "domains.orders.order_updated_title",
          adminId,
        ),
        message: await this.requestTranslations.tAsync(
          "domains.orders.order_updated_message",
          adminId,
          { args: { orderNumber: order.orderNumber } },
        ),

        relatedEntityType: "order",
        relatedEntityId: String(order.id),
      });

      return updatedOrder;
    });
  }

  // orders.service.ts
  // AI: idempotent shipping-location update used by the AI shipping tools.
  async updateOrderShippingLocation(
    me: any,
    orderId: string,
    dto: {
      cityId?: string;
      districtId?: string;
      zoneId?: string;
      locationId?: string;
      orderSize?: string;
    },
  ) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(OrderEntity);
      const order = await repo.findOne({
        where: { id: orderId, adminId },
      });

      if (!order) {
        throw new BadRequestException(
          this.translations.t("domains.orders.order_not_found"),
        );
      }

      const current = order.shippingMetadata ?? {};
      const nextMetadata = {
        ...current,
        cityId: dto.cityId ?? current.cityId,
        districtId: dto.districtId ?? current.districtId,
        zoneId: dto.zoneId ?? current.zoneId,
        locationId: dto.locationId ?? current.locationId,
        orderSize: dto.orderSize ?? current.orderSize,
      };

      order.shippingMetadata = nextMetadata;
      if (dto.cityId) order.cityId = dto.cityId;

      await repo.save(order);

      return {
        id: order.id,
        orderNumber: order.orderNumber,
        cityId: order.cityId,
        shippingMetadata: nextMetadata,
      };
    });
  }

  async bulkUpdateShippingFields(
    me: any,
    dto: BulkUpdateShippingFieldsDto,
    ipAddress?: string,
  ) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    if (!dto.items?.length) {
      throw new BadRequestException(
        this.translations.t("domains.orders.no_orders_provided"),
      );
    }

    return this.dataSource.transaction(async (manager) => {
      let integration: ShippingIntegrationEntity | null = null;
      if (dto.code && dto.code.toLocaleLowerCase() !== "none") {
        const integrationsRepo = manager.getRepository(
          ShippingIntegrationEntity,
        );

        integration = await integrationsRepo.findOne({
          where: {
            adminId,
            isActive: true,
            shippingCompany: {
              code: dto.code,
            },
          },
          relations: ["shippingCompany"],
        });

        if (!integration) {
          throw new BadRequestException(
            this.translations.t("domains.orders.active_integration_not_found", {
              args: { code: dto.code },
            }),
          );
        }
      }

      const ids = [...new Set(dto.items.map((i) => i.id).filter(Boolean))];

      const orders = await manager
        .createQueryBuilder(OrderEntity, "order")
        .leftJoinAndSelect("order.status", "status")
        .where("order.id IN (:...ids)", { ids })
        .andWhere("order.adminId = :adminId", { adminId })
        .getMany();

      const orderMap = new Map(orders.map((o) => [o.id, o]));

      // Fetch cities if any cityId is provided in items
      const cityIds = [
        ...new Set(dto.items.map((i) => i.cityId).filter(Boolean)),
      ];
      let cityMap = new Map<string, CityEntity>();
      if (cityIds.length > 0) {
        const cities = await manager.getRepository(CityEntity).find({
          where: { id: In(cityIds) },
          relations: ["providerLocations"],
        });
        cityMap = new Map(cities.map((c) => [c.id, c]));
      }

      const invalidResults: Array<{
        id: string;
        reason: string;
      }> = [];

      const toSave: OrderEntity[] = [];
      for (const item of dto.items) {
        const order = orderMap.get(item.id);

        if (!order) {
          invalidResults.push({
            id: item.id,
            reason: this.translations.t(
              "domains.orders.bulk_update_order_not_found",
            ),
          });
          continue;
        }

        if (
          order.status?.system &&
          (order.status.code === OrderStatus.SHIPPED ||
            order.status.code === OrderStatus.DELIVERED)
        ) {
          invalidResults.push({
            id: order.id,
            reason: this.translations.t(
              "domains.orders.bulk_update_cannot_update_shipped",
            ),
          });
          continue;
        }

        // Apply updates (only allowed fields)
        if (item.customerName !== undefined) {
          order.customerName = item.customerName;
        }

        if (item.phoneNumber !== undefined) {
          order.phoneNumber = item.phoneNumber;
        }

        if (item.address !== undefined) {
          order.address = item.address;
        }

        if (item.cityId !== undefined && item.cityId) {
          const city = cityMap.get(item.cityId);
          if (!city) {
            invalidResults.push({
              id: item.id,
              reason: this.translations.t(
                "domains.orders.bulk_update_city_not_found",
                { args: { cityId: item.cityId } },
              ),
            });
            continue;
          }

          // If a provider is selected, check if this city has a provider location
          if (dto.code && dto.code.toLowerCase() !== "none") {
            const providerLocation = city.providerLocations?.find(
              (pl) => pl.provider.toLowerCase() === dto.code.toLowerCase(),
            );

            if (!providerLocation) {
              invalidResults.push({
                id: item.id,
                reason: this.translations.t(
                  "domains.orders.bulk_update_city_not_supported",
                  { args: { cityName: city.nameEn, providerCode: dto.code } },
                ),
              });
              continue;
            }

            // Update shipping metadata with provider-specific city ID
            order.shippingMetadata = {
              ...(order.shippingMetadata ?? {}),
              cityId: providerLocation.providerCityId,
            };
          }

          order.cityId = city.id;
          order.city = city.nameAr; // Keep string city updated too
        }

        if (item.shippingMetadata !== undefined) {
          const cleanShippingMetadata = Object.fromEntries(
            Object.entries(item.shippingMetadata).filter(
              ([_, value]) =>
                value !== undefined && value !== null && value !== "",
            ),
          );

          order.shippingMetadata = {
            ...(order.shippingMetadata ?? {}),
            ...cleanShippingMetadata,
          };
        }

        // Always update company if code is provided
        if (integration) {
          order.shippingCompanyId = integration.shippingCompanyId;
        }

        order.updatedByUserId = me?.id;
        toSave.push(order);
      }

      // ❌ If ANY invalid → stop everything
      if (invalidResults.length > 0) {
        throw new BadRequestException({
          message: this.translations.t(
            "domains.orders.bulk_update_some_invalid",
          ),
          errors: invalidResults,
        });
      }

      // ✅ Only reached if ALL orders are valid
      if (toSave.length > 0) {
        await manager.save(OrderEntity, toSave);
      }

      return {
        success: true,
        updatedCount: toSave.length,
      };
    });
  }

  // ========================================
  // ✅ CHANGE ORDER STATUS
  // ========================================
  async changeStatus(
    me: any,
    id: string,
    dto: ChangeOrderStatusDto,
    ipAddress?: string,
    options?: { defaultConfirmationSource?: OrderConfirmationSource },
  ) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    const manager = queryRunner.manager;
    try {
      const order = await manager.findOne(OrderEntity, {
        where: { id, adminId } as any,
        relations: ["items", "items.variant", "status"],
      });

      if (!order) {
        throw new BadRequestException(
          this.translations.t("domains.orders.order_not_found"),
        );
      }
      await this.throwIfDelivered(
        order,
        this.translations.t("domains.orders.cannot_update_closed"),
      );

      const newStatus = await this.findStatusById(dto.statusId, order.adminId);

      const oldStatusId = order.statusId;
      const newStatusCode = newStatus.code;

      if (oldStatusId === dto.statusId) return order;

      // Handle stock changes
      // if (
      //   newStatusCode === OrderStatus.CANCELLED ||
      //   newStatusCode === OrderStatus.RETURNED
      // ) {
      //   // Release reserved stock
      //   for (const item of order.items) {
      //     const variant = item.variant;
      //     variant.reserved = Math.max(
      //       0,
      //       (variant.reserved || 0) - item.quantity,
      //     );
      //     await manager.save(ProductVariantEntity, variant);
      //   }
      // }

      if (newStatusCode === OrderStatus.SHIPPED && !order.shippedAt) {
        order.shippedAt = new Date();
      }

      if (newStatusCode === OrderStatus.CONFIRMED) {
        this.applyConfirmation(
          order,
          { confirmationSource: dto.confirmationSource },
          options?.defaultConfirmationSource ?? OrderConfirmationSource.MANUAL,
        );
      }

      if (newStatusCode === OrderStatus.POSTPONED && dto.postponedDate) {
        order.postponedDate = new Date(dto.postponedDate);
        order.reminderDaysBefore = dto.reminderDaysBefore;
        order.postponedNotificationSent = false;
        order.reminderNotificationSent = false;
        order.oneDayBeforeNotificationSent = false;
      }

      //only decrease stock when order hasn't shipping
      if (newStatusCode === OrderStatus.DELIVERED) {
        order.deliveredAt = new Date();
      }

      order.status = newStatus;
      order.statusId = newStatus?.id;
      order.updatedByUserId = me?.id;

      let resolvedCause = null;
      let historyNotes = dto.notes;
      if (newStatusCode === OrderStatus.CANCELLED) {
        resolvedCause =
          await this.cancelCausesService.resolveCancellationCause(manager, {
            adminId,
            employeeId: me?.id,
            dto,
            required: false,
          });
        if (resolvedCause) {
          historyNotes = this.cancelCausesService.composeHistoryNotes(
            resolvedCause.snapshotName,
            dto.notes,
          );
        }
      }

      const saved = await manager.save(OrderEntity, order);

      // Log status change
      const history = await this.logStatusChange({
        adminId,
        orderId: saved.id,
        fromStatusId: oldStatusId,
        toStatusId: newStatus.id,
        userId: me?.id,
        notes: historyNotes,
        ipAddress,
        manager,
      });

      if (resolvedCause) {
        await this.cancelCausesService.applyCancellationCause(manager, {
          adminId,
          order: saved,
          employeeId: me?.id,
          resolved: resolvedCause,
          historyId: history.id,
          toStatusId: newStatus.id,
        });
      }

      await this.notificationService.create({
        userId: adminId,
        type: NotificationType.ORDER_STATUS_UPDATE,
        title: await this.requestTranslations.tAsync(
          "domains.orders.order_status_updated_title",
          adminId,
        ),
        message: await this.requestTranslations.tAsync(
          "domains.orders.order_status_updated_message",
          adminId,
          {
            args: {
              orderNumber: order.orderNumber,
              statusName: newStatus.name,
            },
          },
        ),
        relatedEntityType: "order",
        relatedEntityId: String(order.id),
      });

      if (
        newStatusCode === OrderStatus.SHIPPED ||
        newStatusCode === OrderStatus.CONFIRMED
      ) {
        await this.deductStockForOrder(manager, order?.id, adminId);
      }

      await queryRunner.commitTransaction(); // Manual Commit required here
      return saved;
    } catch (err) {
      await queryRunner.rollbackTransaction(); // Manual Rollback required here
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async rejectOrder(
    me: any,
    id: string,
    dto: { notes?: string },
    ipAddress?: string,
  ) {
    const adminId = tenantId(me);
    const userId = me?.id;
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    return this.dataSource.transaction(async (manager) => {
      // 1. Fetch Order and Rejected Status
      const [order, rejectedStatus] = await Promise.all([
        manager.findOne(OrderEntity, {
          where: { id, adminId },
          select: ["id", "orderNumber", "statusId"],
        }),
        this.findStatusByCode(OrderStatus.REJECTED, adminId, manager),
      ]);

      if (!order) {
        throw new NotFoundException(
          this.translations.t("domains.orders.order_not_found"),
        );
      }
      await this.throwIfDelivered(
        order,
        this.translations.t("domains.orders.cannot_reject_closed"),
      );
      if (!rejectedStatus) {
        throw new BadRequestException(
          this.translations.t("domains.orders.rejected_status_not_found"),
        );
      }

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
      const reason =
        dto.notes ||
        this.translations.t("domains.orders.log_no_reason_provided");
      await this.logOrderAction({
        manager,
        adminId,
        userId,
        orderId: order.id,
        actionType: OrderActionType.REJECTED,
        result: OrderActionResult.FAILED,
        details: await this.requestTranslations.tAsync(
          "domains.orders.log_order_rejected",
          adminId,
          { args: { reason } },
        ),
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
        userId: adminId,
        type: NotificationType.ORDER_REJECTED,
        title: await this.requestTranslations.tAsync(
          "domains.orders.order_rejected_title",
          adminId,
        ),
        message: await this.requestTranslations.tAsync(
          "domains.orders.order_rejected_message",
          adminId,
          { args: { orderNumber: order.orderNumber, reason } },
        ),
        relatedEntityType: "order",
        relatedEntityId: String(order.id),
      });

      return { success: true, orderId: id, status: OrderStatus.REJECTED };
    });
  }

  async reConfirmOrder(me: any, id: string, ipAddress?: string) {
    const adminId = tenantId(me);
    const userId = me?.id;
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    return this.dataSource.transaction(async (manager) => {
      // 1. Fetch Order and Confirmed Status
      const [order, confirmedStatus] = await Promise.all([
        manager.findOne(OrderEntity, {
          where: { id, adminId },
          select: ["id", "orderNumber", "statusId"],
        }),
        this.findStatusByCode(OrderStatus.CONFIRMED, adminId, manager),
      ]);

      await this.throwIfDelivered(
        order,
        this.translations.t("domains.orders.cannot_reconfirm_closed"),
      );
      if (!order) {
        throw new NotFoundException(
          this.translations.t("domains.orders.order_not_found"),
        );
      }
      if (!confirmedStatus) {
        throw new BadRequestException(
          this.translations.t("domains.orders.confirmed_status_not_found"),
        );
      }

      const oldStatusId = order.statusId;

      // 2. Update Order: Revert status and CLEAR rejection data
      await manager.update(OrderEntity, id, {
        statusId: confirmedStatus.id,
        isConfirmed: true,
        confirmedAt: new Date(),
        confirmationSource: OrderConfirmationSource.MANUAL,
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
        details: await this.requestTranslations.tAsync(
          "domains.orders.log_order_reconfirmed",
          adminId,
        ),
      });

      // 4. ✅ LOG STATUS CHANGE (The Timeline)
      await this.logStatusChange({
        adminId,
        orderId: order.id,
        fromStatusId: oldStatusId,
        toStatusId: confirmedStatus.id,
        userId,
        notes: await this.requestTranslations.tAsync(
          "domains.orders.log_reconfirmed_after_rejection",
          adminId,
        ),
        ipAddress,
        manager,
      });

      await this.notificationService.create({
        userId: adminId,
        type: NotificationType.ORDER_RECONFIRMED,
        title: await this.requestTranslations.tAsync(
          "domains.orders.order_reconfirmed_title",
          adminId,
        ),
        message: await this.requestTranslations.tAsync(
          "domains.orders.order_reconfirmed_message",
          adminId,
          { args: { orderNumber: order.orderNumber } },
        ),
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
    id: string,
    dto: ChangeOrderStatusDto,
    ipAddress?: string,
  ) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }
    const employeeId = me?.id;
    const notificationPromises = [];
    return this.dataSource.transaction(async (manager) => {
      // 1. Fetch Order and its Active Assignment for this employee
      const order = await manager.findOne(OrderEntity, {
        where: { id, adminId } as any,
        relations: ["status", "items", "items.variant", "assignments"],
      });

      if (!order) {
        throw new BadRequestException(
          this.translations.t("domains.orders.order_not_found"),
        );
      }

      const oldStatus = order?.status;

      // Check if order is already in warehouse
      if (oldStatus && this.isWarehouseStatus(oldStatus.code)) {
        // Prevent update and deactivate assignment
        const activeAssignment = order.assignments.find(
          (a) => a.isAssignmentActive && a.employeeId === employeeId,
        );
        if (activeAssignment) {
          activeAssignment.isAssignmentActive = false;
          activeAssignment.finishedAt = new Date();
          activeAssignment.lockedUntil = null;
          activeAssignment.lastStatusId = oldStatus.id;
          await manager.save(OrderAssignmentEntity, activeAssignment);
        }
        return {
          success: false,
          message:
            oldStatus.code === OrderStatus.DELIVERED
              ? this.translations.t(
                "domains.orders.order_delivered_cannot_edit",
              )
              : this.translations.t(
                "domains.orders.order_in_warehouse_cannot_edit",
              ),
        };
      }

      // Validate Active Assignment
      const activeAssignment = order.assignments.find(
        (a) => a.isAssignmentActive && a.employeeId === employeeId,
      );
      if (!activeAssignment) {
        throw new BadRequestException(
          this.translations.t("domains.orders.no_active_assignment"),
        );
      }

      // 2. Fetch Statuses & Settings
      let newStatus = await this.findStatusById(dto.statusId, adminId);
      const oldStatusId = order.statusId;

      if (oldStatusId === newStatus.id) return order;

      const settings =
        await this.clientSettingsService.getCachedSettings(adminId);
      const allowed = settings.confirmationStatuses;

      if (
        newStatus.system &&
        !allowed.includes(newStatus.code as OrderStatus)
      ) {
        throw new BadRequestException(
          this.translations.t(
            "domains.orders.confirmation_status_not_allowed",
            { args: { statusCode: newStatus.code } },
          ),
        );
      }

      // Fetch Retry Settings

      const now = new Date();
      activeAssignment.lastActionAt = now;
      activeAssignment.contactTries = (activeAssignment.contactTries || 0) + 1;

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

          if (!newStatus) {
            throw new BadRequestException(
              this.translations.t(
                "domains.orders.auto_move_status_not_configured",
              ),
            );
          }

          activeAssignment.isAssignmentActive = false;
          activeAssignment.finishedAt = now;
          activeAssignment.lockedUntil = null;
          actionResult = OrderActionResult.FAILED;

          if (settings.notifyAdmin) {
            notificationPromises.push(
              this.notificationService.create({
                userId: adminId,
                type: NotificationType.ORDER_STATUS_UPDATE,
                title: await this.requestTranslations.tAsync(
                  "domains.orders.order_follow_up_title",
                  adminId,
                  { args: { orderNumber: order.orderNumber } },
                ),
                message: await this.requestTranslations.tAsync(
                  "domains.orders.order_follow_up_message",
                  adminId,
                  { args: { orderNumber: order.orderNumber } },
                ),
                relatedEntityType: "order",
                relatedEntityId: String(order.id),
              }),
            );
          }
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

        notificationPromises.push(
          this.notificationService.create({
            userId: adminId,
            type: NotificationType.ORDER_STATUS_UPDATE,
            title: await this.requestTranslations.tAsync(
              "domains.orders.order_status_changed_by_staff_title",
              adminId,
              { args: { orderNumber: order.orderNumber } },
            ),
            message: await this.requestTranslations.tAsync(
              "domains.orders.order_status_changed_by_staff_message",
              adminId,
              {
                args: {
                  orderNumber: order.orderNumber,
                  statusName: newStatus.name,
                  staffName: me.name || "Staff",
                },
              },
            ),
            relatedEntityType: "order",
            relatedEntityId: String(order.id),
          }),
        );
      }
      activeAssignment.lastStatusId = newStatus.id;

      // 4. Update Order (Stock logic included for terminal states)
      // if (
      //   newStatus.code === OrderStatus.CANCELLED ||
      //   newStatus.code === OrderStatus.RETURNED
      // ) {
      //   for (const item of order.items) {
      //     if (item.stockDeducted) {
      //       // If it was already deducted from stock, add it back
      //       item.variant.stockOnHand = (item.variant.stockOnHand || 0) + item.quantity;
      //       item.stockDeducted = false;
      //     } else {
      //       // Otherwise just release the reservation
      //       item.variant.reserved = Math.max(
      //         0,
      //         (item.variant.reserved || 0) - item.quantity,
      //       );
      //     }
      //     await manager.save(ProductVariantEntity, item.variant);
      //     await manager.save(OrderItemEntity, item);
      //   }
      // }
      order.status = newStatus;
      order.updatedByUserId = employeeId;

      if (newStatus.code === OrderStatus.CONFIRMED) {
        this.applyConfirmation(
          order,
          dto,
          OrderConfirmationSource.MANUAL,
        );
      }

      let resolvedCause = null;
      let historyNotes = dto.notes;
      if (newStatus.code === OrderStatus.CANCELLED) {
        resolvedCause =
          await this.cancelCausesService.resolveCancellationCause(manager, {
            adminId,
            employeeId,
            dto,
            required: true,
          });
        historyNotes = this.cancelCausesService.composeHistoryNotes(
          resolvedCause.snapshotName,
          dto.notes,
        );
      }

      // Persist assignment (including contactTries) before the order save.
      // Tag automations run on OrderEntity afterUpdate; a TypeORM save() can
      // skip new columns if they are not marked dirty, so update() always writes them.
      await manager.update(
        OrderAssignmentEntity,
        { id: activeAssignment.id },
        {
          lastActionAt: activeAssignment.lastActionAt,
          contactTries: activeAssignment.contactTries,
          retriesUsed: activeAssignment.retriesUsed,
          isAssignmentActive: activeAssignment.isAssignmentActive,
          lockedUntil: activeAssignment.lockedUntil ?? null,
          finishedAt: activeAssignment.finishedAt ?? null,
          lastStatusId: activeAssignment.lastStatusId,
        },
      );
      const savedOrder = await manager.save(OrderEntity, order);

      if (this.isWarehouseStatus(newStatus.code)) {
        this.logger.log(
          `[changeConfirmationStatus] Order #${order.orderNumber} moved to warehouse status: ${newStatus.code} (old: ${oldStatus?.code})`,
        );
      }

      await this.logOrderAction({
        manager,
        adminId,
        userId: employeeId,
        orderId: savedOrder.id,
        shippingCompanyId: order?.shippingCompanyId,
        actionType: OrderActionType.CONFIRMED,
        result: actionResult,
        details: await this.requestTranslations.tAsync(
          "domains.orders.log_confirmation_process",
          adminId,
          {
            args: {
              oldStatusName: oldStatus?.name,
              newStatusName: newStatus.name,
              retriesUsed: activeAssignment.retriesUsed,
              maxRetries: activeAssignment.maxRetriesAtAssignment,
            },
          },
        ),
      });

      // Log History
      const history = await this.logStatusChange({
        adminId,
        orderId: savedOrder.id,
        fromStatusId: oldStatusId,
        toStatusId: newStatus.id,
        userId: employeeId,
        notes: historyNotes,
        ipAddress,
        manager,
      });

      if (resolvedCause) {
        await this.cancelCausesService.applyCancellationCause(manager, {
          adminId,
          order: savedOrder,
          employeeId,
          resolved: resolvedCause,
          historyId: history.id,
          toStatusId: newStatus.id,
        });
      }

      // 2. Notify Employee (The one assigned to the order)
      notificationPromises.push(
        this.notificationService.create({
          userId: activeAssignment.employeeId,
          type: NotificationType.ORDER_STATUS_UPDATE,
          title: await this.requestTranslations.tAsync(
            "domains.orders.assignment_updated_title",
            adminId,
          ),
          message: await this.requestTranslations.tAsync(
            "domains.orders.assignment_updated_message",
            adminId,
            {
              args: {
                orderNumber: savedOrder.orderNumber,
                statusName: newStatus.name,
              },
            },
          ),
          relatedEntityType: "order",
          relatedEntityId: String(savedOrder.id),
        }),
      );

      await Promise.all(notificationPromises);

      if (
        newStatus.code === OrderStatus.SHIPPED ||
        newStatus.code === OrderStatus.CONFIRMED
      ) {
        await this.deductStockForOrder(manager, order?.id, adminId);
      }

      return savedOrder;
    });
  }

  // ========================================
  // ✅ UPDATE PAYMENT STATUS
  // ========================================
  async updatePaymentStatus(me: any, id: string, dto: UpdatePaymentStatusDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const order = await this.get(me, id);
    await this.throwIfDelivered(
      order,
      "Cannot update a order that has been closed.",
    );
    order.paymentStatus = dto.paymentStatus;
    order.updatedByUserId = me?.id;

    return this.orderRepo.save(order);
  }

  // ========================================
  // ✅ ORDER MESSAGES/CHAT
  // ========================================
  async getMessages(me: any, orderId: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    await this.get(me, orderId); // validate access

    return this.messageRepo.find({
      where: { adminId, orderId } as any,
      order: { created_at: "ASC" },
    });
  }

  async addMessage(me: any, orderId: string, dto: AddOrderMessageDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

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

  async markMessagesRead(me: any, orderId: string, dto: MarkMessagesReadDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

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
  async remove(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const order = await this.get(me, id);

    const DELETABLE_STATUSES: OrderStatus[] = [
      OrderStatus.NEW,
      OrderStatus.UNDER_REVIEW,
      OrderStatus.DISTRIBUTED,
      OrderStatus.POSTPONED,
      OrderStatus.NO_ANSWER,
      OrderStatus.WRONG_NUMBER,
      OrderStatus.OUT_OF_DELIVERY_AREA,
      OrderStatus.DUPLICATE,
      OrderStatus.CANCELLED, // keep this too if needed
    ];

    const isDeletableStatus = DELETABLE_STATUSES.includes(
      order.status.code as OrderStatus,
    );

    const isNonSystemStatus = order.status.system === false;

    if (!isDeletableStatus && !isNonSystemStatus) {
      throw new BadRequestException(
        this.translations.t("domains.orders.order_status_cannot_delete"),
      );
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

    await this.orderRepo.softDelete({ id, adminId } as any);

    await this.notificationService.create({
      userId: adminId,
      type: NotificationType.ORDER_DELETED,
      title: await this.requestTranslations.tAsync(
        "domains.orders.order_deleted_title",
        adminId,
      ),
      message: await this.requestTranslations.tAsync(
        "domains.orders.order_deleted_message",
        adminId,
        { args: { orderNumber: order.orderNumber } },
      ),
    });

    return { ok: true };
  }

  async findByExternalId(
    externalId: string,
    adminId: string,
  ): Promise<OrderEntity | null> {
    return this.orderRepo.findOne({
      where: { adminId, externalId },
      relations: ["status", "items", "items.variant", "store"],
    });
  }

  private applyConfirmation(
    order: OrderEntity,
    dto?: { confirmationSource?: OrderConfirmationSource },
    defaultSource?: OrderConfirmationSource,
  ) {
    order.confirmedAt = new Date();
    order.isConfirmed = true;
    const source = dto?.confirmationSource ?? defaultSource;
    if (source) {
      order.confirmationSource = source;
    }
  }

  async updateExternalId(orderId: string, externalId: string) {
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
        this.translations.t("domains.orders.status_code_not_found", {
          args: { code: trimmedCode },
        }),
      );
    }

    return status;
  }
  async findStatusById(
    id: string,
    adminId: string,
    manager?: EntityManager,
    active?: boolean,
  ): Promise<OrderStatusEntity> {
    // [2025-12-24] Trim input and ensure case-insensitive matching if needed

    const repo = manager
      ? manager.getRepository(OrderStatusEntity)
      : this.statusRepo;
    const status = await repo.findOne({
      where: [
        { id: id, system: true, ...(active ? { isActive: true } : {}) }, // Condition 1: Global System Status
        { id: id, adminId: adminId, ...(active ? { isActive: true } : {}) }, // Condition 2: Admin-specific Status
      ],
    });

    if (!status) {
      throw new NotFoundException(
        this.translations.t("domains.orders.status_id_not_found", {
          args: { id },
        }),
      );
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
      throw new Error(
        this.translations.t("domains.orders.critical_no_order_statuses"),
      );
    }

    return status;
  }

  async createStatus(me: any, dto: CreateStatusDto) {
    const adminId = tenantId(me);
    const name = dto.name.trim();
    const code = slugify(name);

    const existing = await this.statusRepo
      .createQueryBuilder("status")
      .where("status.adminId = :adminId", { adminId })
      .andWhere(
        new Brackets((qb) => {
          qb.where("status.name = :name", { name }).orWhere(
            "status.code = :code",
            { code },
          );
        }),
      )
      .withDeleted() // IMPORTANT if you use soft delete
      .getOne();

    if (existing) {
      if (existing.isActive) {
        throw new BadRequestException(
          this.translations.t("domains.orders.status_conflict_exists", {
            args: { conflictType: name },
          }),
        );
      }

      existing.isActive = true;
      existing.deactivatedAt = null;
      existing.name = dto.name.trim();
      existing.description = dto.description?.trim();
      existing.color = dto.color.trim();
      existing.sortOrder = dto.sortOrder;
      existing.percentFrom = this.resolvePercentFrom(false, dto.percentFrom);
      existing.system = false;

      const saved = await this.statusRepo.save(existing);

      await this.notificationService.create({
        userId: adminId,
        type: NotificationType.ORDER_STATUS_CREATED,
        title: await this.requestTranslations.tAsync(
          "domains.orders.status_reactivated_title",
          adminId,
        ),
        message: await this.requestTranslations.tAsync(
          "domains.orders.status_reactivated_message",
          adminId,
          { args: { name: saved.name } },
        ),
      });

      return saved;
    }

    await this.validateStatusUniqueness(name, code, adminId);
    // Check if name already exists for this admin or system

    const status = this.statusRepo.create({
      ...dto,
      name: dto.name?.trim(),
      description: dto.description?.trim(),
      color: dto.color.trim(),
      sortOrder: dto.sortOrder,
      percentFrom: this.resolvePercentFrom(false, dto.percentFrom),
      adminId: adminId,
      system: false, // Force false for admin-created statuses
    });

    const saved = await this.statusRepo.save(status);

    await this.notificationService.create({
      userId: adminId,
      type: NotificationType.ORDER_STATUS_CREATED,
      title: await this.requestTranslations.tAsync(
        "domains.orders.status_created_title",
        adminId,
      ),
      message: await this.requestTranslations.tAsync(
        "domains.orders.status_created_message",
        adminId,
        { args: { name: saved.name } },
      ),
    });

    return saved;
  }

  async updateStatus(me: any, id: string, dto: UpdateStatusDto) {
    const adminId = tenantId(me);
    const status = await this.statusRepo.findOneBy({ id, adminId: adminId });

    if (!status) {
      throw new NotFoundException(
        this.translations.t("domains.orders.status_not_found_or_protected"),
      );
    }

    // Extra safety: even if adminId matches, block if system is true
    if (status.system) {
      throw new ForbiddenException(
        this.translations.t("domains.orders.cannot_edit_system_statuses"),
      );
    }
    const newName = dto.name?.trim() ?? status.name;

    const code = slugify(newName);
    await this.validateStatusUniqueness(newName, code, adminId, id);

    Object.assign(status, {
      ...dto,
      name: dto.name?.trim() ?? status.name,
      description: dto.description?.trim(),
      color: dto.color.trim(),
      sortOrder: dto.sortOrder,
      percentFrom: this.resolvePercentFrom(
        false,
        dto.percentFrom ?? status.percentFrom,
      ),
    });

    const saved = await this.statusRepo.save(status);

    await this.notificationService.create({
      userId: adminId,
      type: NotificationType.ORDER_STATUS_SETTINGS_UPDATED,
      title: await this.requestTranslations.tAsync(
        "domains.orders.status_updated_title",
        adminId,
      ),
      message: await this.requestTranslations.tAsync(
        "domains.orders.status_updated_message",
        adminId,
        { args: { statusName: saved.name } },
      ),
    });

    return saved;
  }

  private async validateStatusUniqueness(
    name: string,
    code: string,
    adminId: string,
    excludeId?: string,
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
      throw new BadRequestException(
        this.translations.t("domains.orders.status_conflict_exists", {
          args: { conflictType: name },
        }),
      );
    }
  }

  async removeStatus(me: any, id: string) {
    const adminId = tenantId(me);
    const status = await this.statusRepo.findOneBy({ id, adminId: adminId });

    if (!status) {
      throw new NotFoundException(
        this.translations.t("domains.orders.status_not_found_dot"),
      );
    }
    if (status.system) {
      throw new ForbiddenException(
        this.translations.t("domains.orders.system_status_cannot_delete"),
      );
    }

    return await this.dataSource.transaction(async (manager) => {
      await CRUD.toggleStatus(
        manager,
        OrderStatusEntity,
        id,
        adminId,
        false, // Deactivate
        [],
      );
    });
  }

  private calcShippingDaysElapsed(
    shippedAt?: Date | null,
    referenceDate?: Date | null,
  ): number | null {
    if (!shippedAt) return null;

    const shipped = new Date(shippedAt);
    const shippedDay = new Date(
      shipped.getFullYear(),
      shipped.getMonth(),
      shipped.getDate(),
    );
    const ref = referenceDate ? new Date(referenceDate) : new Date();
    ref.setHours(0, 0, 0, 0);

    const diffDays = Math.floor(
      (ref.getTime() - shippedDay.getTime()) / (24 * 60 * 60 * 1000),
    );
    return diffDays + 1;
  }

  // ========================================
  // ✅ EXPORT ORDERS TO EXCEL
  // ========================================
  async exportOrders(me: any, q?: any) {
    const isShippedExport =
      String(q?.status ?? "").trim() === OrderStatus.SHIPPED;
    const na = this.translations.t("common.not_applicable");
    const unassigned = this.translations.t("common.unassigned");
    const t = (
      key: Parameters<TranslationService["t"]>[0],
      options?: Parameters<TranslationService["t"]>[1],
    ) => this.translations.t(key, options);

    // Use list method to get all orders (no pagination)
    const { records: orders } = await this.list(me, { ...q, limit: 10000 });

    if (isShippedExport) {
      const exportData = orders.map((order) => {
        const productsList =
          order.items
            ?.map(
              (item) =>
                `${item.variant?.product?.name || na} - ${item.variant?.sku || na} (x${item.quantity})`,
            )
            .join("; ") || na;
        const shipment = order.shipments?.[0];
        const assignment = order.assignments?.[0];
        const shippingDays = this.calcShippingDaysElapsed(
          order.shippedAt,
          order.status?.code === OrderStatus.DELIVERED
            ? order.deliveredAt
            : null,
        );

        return {
          orderNumber: order.orderNumber,
          customerName: order.customerName,
          phoneNumber: order.phoneNumber || na,
          city: order.city || na,
          address: order.address || na,
          finalTotal: order.finalTotal || 0,
          shippingCost: order.shippingCost || 0,
          products: productsList,
          status: order.status?.system
            ? order.status.code
            : order.status?.name || na,
          shippingDays: shippingDays ?? na,
          trackingNumber:
            shipment?.trackingNumber || order.trackingNumber || na,
          shipmentStatus: shipment?.status || na,
          shipmentDate:
            shipment?.created_at || order.shippedAt
              ? new Date(
                shipment?.created_at || order.shippedAt,
              ).toLocaleDateString()
              : na,
          shippingCompany: order.shippingCompany?.name || na,
          assignedEmployee: assignment?.employee?.name || na,
        };
      });

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet(
        t("domains.orders.export_shipped_orders_sheet"),
      );

      worksheet.columns = [
        {
          header: t("common.export_order_number"),
          key: "orderNumber",
          width: 18,
        },
        {
          header: t("domains.orders.export_customer_name"),
          key: "customerName",
          width: 25,
        },
        {
          header: t("domains.orders.export_phone_number"),
          key: "phoneNumber",
          width: 18,
        },
        { header: t("domains.orders.export_city"), key: "city", width: 15 },
        {
          header: t("domains.orders.export_address"),
          key: "address",
          width: 35,
        },
        {
          header: t("domains.orders.export_final_total"),
          key: "finalTotal",
          width: 15,
        },
        {
          header: t("domains.orders.export_shipping_cost"),
          key: "shippingCost",
          width: 15,
        },
        {
          header: t("domains.orders.export_products"),
          key: "products",
          width: 40,
        },
        {
          header: t("domains.orders.export_order_status"),
          key: "status",
          width: 20,
        },
        {
          header: t("domains.orders.export_shipping_days"),
          key: "shippingDays",
          width: 15,
        },
        {
          header: t("domains.orders.export_tracking_number"),
          key: "trackingNumber",
          width: 22,
        },
        {
          header: t("domains.orders.export_shipment_status"),
          key: "shipmentStatus",
          width: 20,
        },
        {
          header: t("domains.orders.export_shipment_date"),
          key: "shipmentDate",
          width: 18,
        },
        {
          header: t("common.export_shipping_company"),
          key: "shippingCompany",
          width: 20,
        },
        {
          header: t("domains.orders.export_assigned_employee"),
          key: "assignedEmployee",
          width: 22,
        },
      ];

      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFE0E0E0" },
      };

      exportData.forEach((row) => {
        worksheet.addRow(row);
      });

      return workbook.xlsx.writeBuffer();
    }

    // Prepare Excel data
    const exportData = orders.map((order) => {
      const productsList =
        order.items
          ?.map(
            (item) =>
              `${item.variant?.product?.name || na} (x${item.quantity})`,
          )
          .join("; ") || na;
      const activeAssignment = order.assignments?.find(
        (a) => a.isAssignmentActive,
      );
      const assignedTo = activeAssignment?.employee
        ? `${activeAssignment.employee.name || na} (ID: ${activeAssignment.employee.id || na})`
        : unassigned;
      return {
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        assignedTo: assignedTo,
        phoneNumber: order.phoneNumber || na,
        email: order.email || na,
        address: order.address || na,
        city: order.city || na,
        area: order.area || na,
        landmark: order.landmark || na,
        products: productsList,
        status: order.status?.system
          ? order.status.code
          : order.status?.name || na,
        paymentMethod: order.paymentMethod || na,
        paymentStatus: order.paymentStatus || na,
        shippingCompany: order.shippingCompany?.name || na,
        shippingCost: order.shippingCost || 0,
        discount: order.discount || 0,
        additionalFees: order.additionalFees || 0,
        deposit: order.deposit || 0,
        finalTotal:
          (order.items?.reduce(
            (sum, item) => sum + item.unitPrice * item.quantity,
            0,
          ) || 0) +
          (order.shippingCost || 0) +
          (order.additionalFees || 0) -
          (order.discount || 0),
        notes: order.notes || na,
        customerNotes: order.customerNotes || na,
        createdAt: order.created_at
          ? new Date(order.created_at).toLocaleDateString()
          : na,
        updatedAt: order.updated_at
          ? new Date(order.updated_at).toLocaleDateString()
          : na,
      };
    });

    // Create workbook and worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      t("domains.orders.export_orders_sheet"),
    );

    // Define columns
    const columns = [
      {
        header: t("common.export_order_number"),
        key: "orderNumber",
        width: 18,
      },
      {
        header: t("domains.orders.export_customer_name"),
        key: "customerName",
        width: 25,
      },
      {
        header: t("domains.orders.export_assigned_to"),
        key: "assignedTo",
        width: 25,
      },
      {
        header: t("domains.orders.export_phone_number"),
        key: "phoneNumber",
        width: 18,
      },
      { header: t("domains.orders.export_email"), key: "email", width: 30 },
      { header: t("domains.orders.export_address"), key: "address", width: 35 },
      { header: t("domains.orders.export_city"), key: "city", width: 15 },
      { header: t("domains.orders.export_area"), key: "area", width: 15 },
      {
        header: t("domains.orders.export_landmark"),
        key: "landmark",
        width: 20,
      },
      {
        header: t("domains.orders.export_products"),
        key: "products",
        width: 40,
      },
      { header: t("common.export_status"), key: "status", width: 20 },
      {
        header: t("domains.orders.export_payment_method"),
        key: "paymentMethod",
        width: 18,
      },
      {
        header: t("domains.orders.export_payment_status"),
        key: "paymentStatus",
        width: 18,
      },
      {
        header: t("common.export_shipping_company"),
        key: "shippingCompany",
        width: 20,
      },
      {
        header: t("domains.orders.export_shipping_cost"),
        key: "shippingCost",
        width: 15,
      },
      {
        header: t("domains.orders.export_discount"),
        key: "discount",
        width: 15,
      },
      {
        header: t("domains.orders.export_additional_fees"),
        key: "additionalFees",
        width: 15,
      },
      { header: t("domains.orders.export_deposit"), key: "deposit", width: 15 },
      {
        header: t("domains.orders.export_final_total"),
        key: "finalTotal",
        width: 15,
      },
      { header: t("domains.orders.export_notes"), key: "notes", width: 30 },
      {
        header: t("domains.orders.export_customer_notes"),
        key: "customerNotes",
        width: 30,
      },
      {
        header: t("domains.orders.export_created_at"),
        key: "createdAt",
        width: 15,
      },
      {
        header: t("domains.orders.export_updated_at"),
        key: "updatedAt",
        width: 15,
      },
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
  async getBulkTemplate(me: any): Promise<Buffer> {
    const adminId = tenantId(me);

    // ==========================================
    // 1. Fetch Dynamic Data (Stores, Shipping, Products)
    // ==========================================

    // Fetch Stores
    // ==========================================
    const [storesList, shippingData, products] = await Promise.all([
      this.storesService.list(me),
      this.shippingService.activeIntegrations(me),
      // Fetching only required fields to optimize database performance
      this.productRepo
        .createQueryBuilder("product")
        .leftJoinAndSelect("product.variants", "variant")
        .leftJoin(
          ClientSettingsEntity,
          "settings",
          "settings.adminId = product.adminId",
        )
        .where("product.adminId = :adminId", { adminId: adminId.trim() })
        .andWhere("product.isActive = :isActive", { isActive: true })
        .andWhere("variant.isActive = :vActive", { vActive: true })

        // 🔥 filter by available stock
        .andWhere(
          new Brackets((qb) => {
            qb.where(
              "COALESCE(settings.reservedEnabled, false) = true AND (variant.stockOnHand - variant.reserved) > 0",
            ).orWhere(
              "COALESCE(settings.reservedEnabled, false) = false AND variant.stockOnHand > 0",
            );
          }),
        )

        .select([
          "product.id",
          "product.name",
          "product.slug",
          "variant.id",
          "variant.sku",
          "variant.price",
          "variant.stockOnHand",
          "variant.reserved",
        ])
        .getMany(),
    ]);

    const storeProviders = storesList.records
      .map((s) => s.provider)
      .filter(Boolean);
    const shippingProviders = shippingData.integrations
      .map((i) => i.provider)
      .filter(Boolean);
    // ==========================================
    // 2. Initialize Workbook & Main Sheet
    // ==========================================

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Madar";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Orders", {
      views: [{ state: "frozen", ySplit: 2 }],
    });

    const columns = [
      {
        header: this.translations.t("domains.orders.export_items"),
        key: "items",
        width: 50,
      },
      {
        header: this.translations.t("domains.orders.export_customer_name"),
        key: "customerName",
        width: 22,
      },
      {
        header: this.translations.t("domains.orders.export_phone_number"),
        key: "phoneNumber",
        width: 16,
      },
      {
        header: this.translations.t(
          "domains.orders.export_second_phone_number",
        ),
        key: "secondPhoneNumber",
        width: 40,
      },
      {
        header: this.translations.t("domains.orders.export_email"),
        key: "email",
        width: 28,
      },
      {
        header: this.translations.t("domains.orders.export_address"),
        key: "address",
        width: 32,
      },
      {
        header: this.translations.t("domains.orders.export_landmark"),
        key: "landmark",
        width: 30,
      },
      {
        header: this.translations.t("domains.orders.export_city"),
        key: "city",
        width: 14,
      },
      {
        header: this.translations.t("domains.orders.export_area"),
        key: "area",
        width: 14,
      },
      {
        header: this.translations.t("domains.orders.export_payment_method"),
        key: "paymentMethod",
        width: 40,
      },
      {
        header: this.translations.t("domains.orders.export_payment_status"),
        key: "paymentStatus",
        width: 40,
      },
      {
        header: this.translations.t("domains.orders.export_shipping_company"),
        key: "shippingCompany",
        width: 45,
      },
      {
        header: this.translations.t("domains.orders.export_allow_open_package"),
        key: "allowOpenPackage",
        width: 45,
      },
      {
        header: this.translations.t("domains.orders.export_store"),
        key: "store",
        width: 30,
      },
      {
        header: this.translations.t("domains.orders.export_shipping_cost"),
        key: "shippingCost",
        width: 30,
      },
      {
        header: this.translations.t("domains.orders.export_deposit"),
        key: "deposit",
        width: 30,
      },
      {
        header: this.translations.t("domains.orders.export_discount"),
        key: "discount",
        width: 30,
      },
      {
        header: this.translations.t("domains.orders.export_additional_fees"),
        key: "additionalFees",
        width: 30,
      },
      {
        header: this.translations.t("domains.orders.export_notes"),
        key: "notes",
        width: 24,
      },
      {
        header: this.translations.t("domains.orders.export_customer_notes"),
        key: "customerNotes",
        width: 40,
      },
    ];
    sheet.columns = columns;

    // Example Data Row
    sheet.addRow({
      customerName: "Ahmed Ali",
      phoneNumber: "01000000000",
      secondPhoneNumber: "01111111111",
      email: "test@example.com",
      address: "Street 1, Building 2",
      landmark: "Near the mall",
      city: "Cairo",
      area: "Nasr City",
      paymentMethod: "cod",
      paymentStatus: "pending",
      shippingCompany: "turbo",
      allowOpenPackage: "true",
      store: "easyorder",
      shippingCost: 50,
      deposit: 0,
      discount: 0,
      additionalFees: 0,
      notes: "Handle with care",
      customerNotes: "Call before delivery",
      // ✅ Grouped items logic applied here
      items: "sku1|2|250, sku2|1|180",
    });

    // Note Row (Row 1)
    this.applyNoteRow(
      sheet,
      this.translations.t("domains.orders.export_format"),
      columns.length,
    );

    const headerRow = sheet.getRow(2);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: "middle", horizontal: "center" };

    // ==========================================
    // 3. Create Validation Enum Sheets (Hidden)
    // ==========================================
    const paymentMethodValues = Object.values(PaymentMethod || {});
    const paymentStatusValues = Object.values(PaymentStatus || {});
    const booleanValues = ["true", "false"];

    const pmValues = Object.values(PaymentMethod || {});
    const psValues = Object.values(PaymentStatus || {});

    const pmSheet = workbook.addWorksheet(
      this.translations.t("domains.orders.export_payment_methods_sheet"),
    );
    this.applyNoteRow(
      pmSheet,
      this.translations.t("domains.orders.export_payment_method_note"),
      10,
    );
    paymentMethodValues.forEach((val, i) => {
      pmSheet.getCell(`A${i + 2}`).value = val;
    });

    // PaymentStatus Sheet
    const psSheet = workbook.addWorksheet(
      this.translations.t("domains.orders.export_payment_statuses_sheet"),
    );
    this.applyNoteRow(
      psSheet,
      this.translations.t("domains.orders.export_payment_status_note"),
      10,
    );
    paymentStatusValues.forEach((val, i) => {
      psSheet.getCell(`A${i + 2}`).value = val;
    });

    // Booleans Sheet
    const boolSheet = workbook.addWorksheet(
      this.translations.t("domains.orders.export_booleans_sheet"),
    );
    this.applyNoteRow(
      boolSheet,
      this.translations.t("domains.orders.export_boolean_note"),
      10,
    );
    booleanValues.forEach((val, i) => {
      boolSheet.getCell(`A${i + 2}`).value = val;
    });

    // --- 4. Apply Data Validations to Main Sheet ---
    // Assuming 1000 rows is enough for the template validation
    for (let i = 3; i <= 1000; i++) {
      // Payment Method (Column I) - Data starts at row 2 due to note row
      sheet.getCell(`I${i}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`PaymentMethods!$A$2:$A$${paymentMethodValues.length + 1}`],
      };
      // Payment Status (Column J) - Data starts at row 2 due to note row
      sheet.getCell(`J${i}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`PaymentStatuses!$A$2:$A$${paymentStatusValues.length + 1}`],
      };
      // Allow Open Package (Column L) - Data starts at row 2 due to note row
      sheet.getCell(`L${i}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`Booleans!$A$2:$A$3`],
      };
    }

    // Dynamic Validation Sheets
    if (storeProviders.length > 0) {
      const storesSheet = workbook.addWorksheet(
        this.translations.t("domains.orders.export_stores_sheet"),
      );
      this.applyNoteRow(
        storesSheet,
        this.translations.t("domains.orders.export_store_note"),
        10,
      );
      storeProviders.forEach(
        (v, i) => (storesSheet.getCell(`A${i + 2}`).value = v),
      );
    }

    if (shippingProviders.length > 0) {
      const shipSheet = workbook.addWorksheet(
        this.translations.t("domains.orders.export_shipping_sheet"),
      );
      this.applyNoteRow(
        shipSheet,
        this.translations.t("domains.orders.export_shipping_note"),
        10,
      );
      shippingProviders.forEach(
        (v, i) => (shipSheet.getCell(`A${i + 2}`).value = v),
      );
    }

    // Apply Validation to Orders Sheet
    for (let i = 3; i <= 500; i++) {
      sheet.getCell(`I${i}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`PaymentMethods!$A$2:$A$${pmValues.length + 1}`],
      };
      sheet.getCell(`J${i}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`PaymentStatuses!$A$2:$A$${psValues.length + 1}`],
      };
      sheet.getCell(`L${i}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`Booleans!$A$2:$A$3`],
      };

      // Shipping (Column K)
      if (shippingProviders.length > 0) {
        sheet.getCell(`K${i}`).dataValidation = {
          type: "list",
          allowBlank: true,
          formulae: [`Shipping!$A$2:$A$${shippingProviders.length + 1}`],
        };
      }

      // Stores (Column M)
      if (storeProviders.length > 0) {
        sheet.getCell(`M${i}`).dataValidation = {
          type: "list",
          allowBlank: true,
          formulae: [`Stores!$A$2:$A$${storeProviders.length + 1}`],
        };
      }
    }

    // ==========================================
    // 4. Products & Variants Reference Sheet
    // ==========================================
    // We do NOT hide this sheet so users can browse it and copy the Variant IDs.

    const refSheet = workbook.addWorksheet(
      this.translations.t("domains.orders.export_products_reference_sheet"),
    );
    refSheet.columns = [
      {
        header: this.translations.t(
          "domains.orders.export_product_variant_name",
        ),
        key: "name",
        width: 45,
      },
      {
        header: this.translations.t("domains.orders.export_sku"),
        key: "sku",
        width: 50,
      },
      {
        header: this.translations.t("domains.orders.export_available_stock"),
        key: "stock",
        width: 18,
      },
      {
        header: this.translations.t("domains.orders.export_price"),
        key: "price",
        width: 18,
      },
    ];

    this.applyNoteRow(
      refSheet,
      this.translations.t("domains.orders.export_products_reference_note"),
      4,
    );
    // Style the reference headers (Row 2 due to note row at Row 1)
    refSheet.getRow(2).font = { bold: true, color: { argb: "FFFFFFFF" } };
    refSheet.getRow(2).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF3b82f6" },
    }; // Blue header

    for (const product of products) {
      // 1. Add Parent Product Row (Visually bold and shaded)
      const pRow = refSheet.addRow({
        name: `📦 ${product.name}`,
        sku: "-",
        stock: "",
        price: "",
      });
      pRow.font = { bold: true, size: 12 };
      pRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF3F4F6" },
      }; // Light gray background to separate products

      // 2. Add Child Variant Rows underneath
      if (product.variants && product.variants.length > 0) {
        for (const variant of product.variants) {
          const available = await this.calculateAvailableStock(
            variant.stockOnHand || 0,
            variant.reserved || 0,
            adminId,
          );

          const vRow = refSheet.addRow({
            name: ``, // Indented to show hierarchy
            sku: variant.sku || "-",
            stock: available,
            price: variant.price || "",
          });
        }
      }
    }

    // Auto filter for the reference sheet to make searching easy
    refSheet.autoFilter = {
      from: { row: 2, column: 1 },
      to: { row: 2, column: 4 },
    };

    workbook.views = [
      {
        x: 0,
        y: 0,
        width: 10000,
        height: 20000,
        firstSheet: 0,
        activeTab: 0, // Ensures 'Orders' is the focused sheet
        visibility: "visible",
      },
    ];

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private async getUsageTracker(adminId: string): Promise<BulkUploadUsage> {
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
  // ✅ REUSABLE NOTE ROW STYLING
  // ========================================
  private applyNoteRow(
    sheet: ExcelJS.Worksheet,
    noteText: string,
    columnCount: number = 1,
  ): void {
    sheet.insertRow(1, [noteText]);
    sheet.mergeCells(1, 1, 1, columnCount);

    const noteRow = sheet.getRow(1);
    noteRow.height = 30;
    noteRow.getCell(1).font = { italic: true, color: { argb: "FF666666" } };
    noteRow.getCell(1).alignment = { wrapText: true, vertical: "middle" };
  }

  // ========================================
  // ✅ CELL VALUE CONVERTER WITH VALIDATION
  // ========================================
  private convertCellValue(
    value: any,
    fieldName: string,
    rowNumber: number,
    cellNumber: number,
    cellErrors: Map<number, Map<number, string[]>>,
    isOptional: boolean = true,
  ): string {
    // Handle null/undefined
    if (value === null || value === undefined) {
      return "";
    }

    // Valid primitives: string, number, boolean
    if (typeof value === "string") {
      return value.trim();
    }

    if (typeof value === "number") {
      return String(value).trim();
    }

    if (typeof value === "boolean") {
      return String(value).trim();
    }

    // Date objects
    if (value instanceof Date) {
      return value.toISOString().trim();
    }

    // Invalid types: objects, arrays, functions, etc.
    const addError = (
      rowNumber: number,
      colNumber: number,
      message: string,
    ) => {
      if (!cellErrors.has(rowNumber)) {
        cellErrors.set(rowNumber, new Map<number, string[]>());
      }
      const rowMap = cellErrors.get(rowNumber)!;
      if (!rowMap.has(colNumber)) {
        rowMap.set(colNumber, []);
      }
      rowMap.get(colNumber)!.push(message);
    };

    const typeOf = Array.isArray(value) ? "array" : typeof value;
    addError(
      rowNumber,
      cellNumber,
      this.translations.t("domains.orders.bulk_invalid_cell_value", {
        args: { fieldName, typeOf },
      }),
    );

    return "";
  }

  // ========================================
  // ✅ BULK CREATE ORDERS FROM EXCEL
  // ========================================
  async bulkCreateOrders(
    me: any,
    file: Express.Multer.File,
  ): Promise<{
    message: string;
    failed: number;
    errorFileBuffer?: Buffer;
    skuErrors: { sku: string; totalQty: number; available: number }[];
  }> {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }
    if (!file?.buffer) {
      throw new BadRequestException(
        this.translations.t("common.no_file_uploaded"),
      );
    }

    const [storesData, shippingData, admin, storeProviders, shippingProviders] =
      await Promise.all([
        this.storesService.list(me),
        this.shippingService.activeIntegrations(me),
        this.userRepo.findOne({
          where: { id: adminId },
          relations: ["subscriptions", "subscriptions.plan"],
        }),
        this.storesService.listProviders(),
        this.shippingService.listProviders(),
      ]);

    const paymentMethodValues = Object.values(PaymentMethod || {});
    const paymentStatusValues = Object.values(PaymentStatus || {});
    const storeProvidersSet = new Set(
      storeProviders.providers.map((s) => s.code),
    );
    const shippingProvidersSet = new Set(
      shippingProviders.providers.map((i) => i.code),
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);

    const sheet = workbook.getWorksheet("Orders");
    if (!sheet) {
      throw new BadRequestException(
        this.translations.t("domains.orders.excel_orders_sheet_required"),
      );
    }

    const rowCount = sheet.rowCount - 2;
    // const usage = await this.getUsageTracker(adminId);
    const activeSub = admin.subscriptions.find(
      (s) => s.status === SubscriptionStatus.ACTIVE,
    );
    // const limit = activeSub?.bulkUploadPerMonth || 0;
    // const remaining = Math.max(0, limit - usage.count);

    // if (usage.count + rowCount > limit) {
    //   throw new BadRequestException(
    //     this.translations.t('domains.orders.bulk_upload_limit_exceeded', { args: { remaining, rowCount } }),
    //   );
    // }

    const storeMap = new Map(
      storesData.records.map((s) => [s.provider.toLowerCase().trim(), s.id]),
    );
    const shippingMap = new Map(
      shippingData.integrations.map((i) => [
        i.provider.toLowerCase().trim(),
        i.providerId,
      ]),
    );

    const rows: any[] = [];
    const allSkus = new Set<string>();
    const cellErrors = new Map<number, Map<number, string[]>>();

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= 2) return;

      const rowData: any = {
        rowNumber,
        customerName: this.convertCellValue(
          row.getCell(1).value,
          "customerName",
          rowNumber,
          1,
          cellErrors,
        ),
        phoneNumber: this.convertCellValue(
          row.getCell(2).value,
          "phoneNumber",
          rowNumber,
          2,
          cellErrors,
        ),
        secondPhoneNumber: this.convertCellValue(
          row.getCell(3).value,
          "secondPhoneNumber",
          rowNumber,
          3,
          cellErrors,
          true,
        ),
        email: this.convertCellValue(
          row.getCell(4).value,
          "email",
          rowNumber,
          4,
          cellErrors,
          true,
        ),
        address: this.convertCellValue(
          row.getCell(5).value,
          "address",
          rowNumber,
          5,
          cellErrors,
        ),
        landmark: this.convertCellValue(
          row.getCell(6).value,
          "landmark",
          rowNumber,
          6,
          cellErrors,
          true,
        ),
        city: this.convertCellValue(
          row.getCell(7).value,
          "city",
          rowNumber,
          7,
          cellErrors,
        ),
        area: this.convertCellValue(
          row.getCell(8).value,
          "area",
          rowNumber,
          8,
          cellErrors,
          true,
        ),
        paymentMethod: (
          this.convertCellValue(
            row.getCell(9).value || "cod",
            "paymentMethod",
            rowNumber,
            9,
            cellErrors,
          ) || "cod"
        )
          .toLowerCase()
          .trim(),
        paymentStatus: (
          this.convertCellValue(
            row.getCell(10).value || "pending",
            "paymentStatus",
            rowNumber,
            10,
            cellErrors,
          ) || "pending"
        )
          .toLowerCase()
          .trim(),
        shippingCompany: (
          this.convertCellValue(
            row.getCell(11).value,
            "shippingCompany",
            rowNumber,
            11,
            cellErrors,
            true,
          ) || ""
        )
          .toLowerCase()
          .trim(),
        allowOpenPackage:
          (
            this.convertCellValue(
              row.getCell(12).value || "false",
              "allowOpenPackage",
              rowNumber,
              12,
              cellErrors,
            ) || "false"
          )
            .toLowerCase()
            .trim() === "true",
        store: (
          this.convertCellValue(
            row.getCell(13).value,
            "store",
            rowNumber,
            13,
            cellErrors,
            true,
          ) || ""
        )
          .toLowerCase()
          .trim(),
        shippingCost: Number(row.getCell(14).value || 0),
        deposit: Number(row.getCell(15).value || 0),
        discount: Number(row.getCell(16).value || 0),
        additionalFees: Number(row.getCell(20).value || 0),
        notes: this.convertCellValue(
          row.getCell(17).value,
          "notes",
          rowNumber,
          17,
          cellErrors,
          true,
        ),
        customerNotes: this.convertCellValue(
          row.getCell(18).value,
          "customerNotes",
          rowNumber,
          18,
          cellErrors,
          true,
        ),
        itemsRaw: this.convertCellValue(
          row.getCell(19).value,
          "items",
          rowNumber,
          19,
          cellErrors,
          true,
        ),
      };

      if (rowData.itemsRaw) {
        rowData.itemsRaw.split(",").forEach((part: string) => {
          const sku = part.split("|")[0]?.trim();
          if (sku) allSkus.add(sku);
        });
      }

      rows.push(rowData);
    });

    const variants = await this.variantRepo.find({
      where: { adminId, sku: In([...allSkus]), isActive: true },
      select: ["id", "sku", "stockOnHand", "reserved", "price"],
    });

    const variantMap = new Map(variants.map((v) => [v.sku, v]));

    const skuUsage = new Map<
      string,
      { totalQty: number; rowNumbers: Set<number> }
    >();
    const validOrderPayloads: CreateOrderDto[] = [];

    const addCellError = (
      rowNumber: number,
      colNumber: number,
      message: string,
    ) => {
      if (!cellErrors.has(rowNumber)) {
        cellErrors.set(rowNumber, new Map<number, string[]>());
      }

      const rowMap = cellErrors.get(rowNumber)!;
      if (!rowMap.has(colNumber)) {
        rowMap.set(colNumber, []);
      }

      rowMap.get(colNumber)!.push(message);
    };

    for (const row of rows) {
      const rowErrors: string[] = [];

      if (!row.customerName || row.customerName.length > 200) {
        const msg = this.translations.t(
          "domains.orders.bulk_invalid_customer_name",
        );
        rowErrors.push(msg);
        addCellError(row.rowNumber, 1, msg);
      }

      if (!row.phoneNumber || row.phoneNumber.length > 50) {
        const msg = this.translations.t(
          "domains.orders.bulk_invalid_phone_number",
        );
        rowErrors.push(msg);
        addCellError(row.rowNumber, 2, msg);
      }

      if (row.secondPhoneNumber && row.secondPhoneNumber.length > 50) {
        const msg = this.translations.t(
          "domains.orders.bulk_invalid_second_phone",
        );
        rowErrors.push(msg);
        addCellError(row.rowNumber, 3, msg);
      }

      if (row.email && !isEmail(row.email)) {
        const msg = this.translations.t("domains.orders.bulk_invalid_email");
        rowErrors.push(msg);
        addCellError(row.rowNumber, 4, msg);
      }
      if (!row.address || row.address.length > 1000) {
        const msg = this.translations.t("domains.orders.bulk_invalid_address");
        rowErrors.push(msg);
        addCellError(row.rowNumber, 5, msg);
      }

      if (row.landmark && row.landmark.length > 300) {
        const msg = this.translations.t("domains.orders.bulk_invalid_landmark");
        rowErrors.push(msg);
        addCellError(row.rowNumber, 6, msg);
      }

      if (!row.city || row.city.length > 100) {
        const msg = this.translations.t("domains.orders.bulk_invalid_city");
        rowErrors.push(msg);
        addCellError(row.rowNumber, 7, msg);
      }

      if (row.area && row.area.length > 100) {
        const msg = this.translations.t("domains.orders.bulk_invalid_area");
        rowErrors.push(msg);
        addCellError(row.rowNumber, 8, msg);
      }

      if (row.notes && row.notes.length > 4000) {
        const msg = this.translations.t("domains.orders.bulk_invalid_notes");
        rowErrors.push(msg);
        addCellError(row.rowNumber, 17, msg);
      }

      if (row.customerNotes && row.customerNotes.length > 4000) {
        const msg = this.translations.t(
          "domains.orders.bulk_invalid_customer_notes",
        );
        rowErrors.push(msg);
        addCellError(row.rowNumber, 18, msg);
      }

      let storeId: string | null = null;
      if (row.store) {
        if (storeProvidersSet.has(row.store)) {
          storeId = storeMap.get(row.store) ?? null;
          if (!storeId) {
            const msg = this.translations.t(
              "domains.orders.bulk_store_provider_not_found",
              { args: { provider: row.store } },
            );
            rowErrors.push(msg);
            addCellError(row.rowNumber, 13, msg);
          }
        } else {
          const msg = this.translations.t(
            "domains.orders.bulk_invalid_store_provider",
            { args: { provider: row.store } },
          );
          rowErrors.push(msg);
          addCellError(row.rowNumber, 13, msg);
        }
      }

      let shippingCompanyId: string | null = null;
      if (row.shippingCompany) {
        if (shippingProvidersSet.has(row.shippingCompany)) {
          shippingCompanyId = shippingMap.get(row.shippingCompany) ?? null;
          if (!shippingCompanyId) {
            const msg = this.translations.t(
              "domains.orders.bulk_shipping_provider_not_found",
              { args: { provider: row.shippingCompany } },
            );
            rowErrors.push(msg);
            addCellError(row.rowNumber, 11, msg);
          }
        } else {
          const msg = this.translations.t(
            "domains.orders.bulk_invalid_shipping_provider",
            { args: { provider: row.shippingCompany } },
          );
          rowErrors.push(msg);
          addCellError(row.rowNumber, 11, msg);
        }
      }

      if (!paymentMethodValues.includes(row.paymentMethod as any)) {
        const msg = this.translations.t(
          "domains.orders.bulk_invalid_payment_method",
          { args: { paymentMethod: row.paymentMethod } },
        );
        rowErrors.push(msg);
        addCellError(row.rowNumber, 9, msg);
      }

      if (!paymentStatusValues.includes(row.paymentStatus as any)) {
        const msg = this.translations.t(
          "domains.orders.bulk_invalid_payment_status",
          { args: { paymentStatus: row.paymentStatus } },
        );
        rowErrors.push(msg);
        addCellError(row.rowNumber, 10, msg);
      }

      const deposit = Number(row.deposit) || 0;
      const shippingCost = Number(row.shippingCost) || 0;
      const discount = Number(row.discount) || 0;

      if (isNaN(deposit) || deposit < 0) {
        const msg = this.translations.t(
          "domains.orders.bulk_deposit_must_be_positive",
        );
        rowErrors.push(msg);
        addCellError(row.rowNumber, 15, msg);
      }

      if (isNaN(shippingCost) || shippingCost < 0) {
        const msg = this.translations.t(
          "domains.orders.bulk_shipping_cost_must_be_positive",
        );
        rowErrors.push(msg);
        addCellError(row.rowNumber, 14, msg);
      }

      if (isNaN(discount) || discount < 0) {
        const msg = this.translations.t(
          "domains.orders.bulk_discount_must_be_positive",
        );
        rowErrors.push(msg);
        addCellError(row.rowNumber, 16, msg);
      }

      const additionalFees = Number(row.additionalFees) || 0;
      if (isNaN(additionalFees) || additionalFees < 0) {
        const msg = this.translations.t(
          "domains.orders.bulk_additional_fees_must_be_positive",
        );
        rowErrors.push(msg);
        addCellError(row.rowNumber, 20, msg);
      }

      const items: OrderItemDto[] = [];
      const itemParts = row.itemsRaw.split(",").filter(Boolean);

      for (const part of itemParts) {
        const [skuRaw, qty, price] = part.split("|").map((p) => p?.trim());
        const sku = skuRaw;

        const variant = variantMap.get(sku);

        if (!variant) {
          const msg = this.translations.t("domains.orders.bulk_sku_not_found", {
            args: { sku: skuRaw },
          });
          rowErrors.push(msg);
          addCellError(row.rowNumber, 19, msg);
          continue;
        }

        const quantity = parseInt(qty);
        const unitPrice = parseFloat(price);

        if (isNaN(quantity) || quantity < 1) {
          const msg = this.translations.t(
            "domains.orders.bulk_quantity_min_one",
            { args: { sku: skuRaw } },
          );
          rowErrors.push(msg);
          addCellError(row.rowNumber, 19, msg);
          continue;
        }

        if (isNaN(unitPrice) || unitPrice < 0) {
          const msg = this.translations.t(
            "domains.orders.bulk_price_must_be_positive",
            { args: { sku: skuRaw } },
          );
          rowErrors.push(msg);
          addCellError(row.rowNumber, 19, msg);
          continue;
        }

        const usageItem = skuUsage.get(sku) || {
          totalQty: 0,
          rowNumbers: new Set<number>(),
        };

        usageItem.totalQty += quantity;
        usageItem.rowNumbers.add(row.rowNumber);
        skuUsage.set(sku, usageItem);

        items.push({
          variantId: variant.id,
          quantity,
          unitPrice,
          unitCost: variant.price,
        });
      }

      if (items.length === 0) {
        const msg = this.translations.t(
          "domains.orders.bulk_order_must_have_item",
        );
        rowErrors.push(msg);
        addCellError(row.rowNumber, 19, msg);
      }

      if (rowErrors.length === 0) {
        validOrderPayloads.push({
          customerName: row.customerName,
          phoneNumber: row.phoneNumber,
          secondPhoneNumber: row.secondPhoneNumber,
          email: row.email,
          address: row.address,
          landmark: row.landmark,
          city: row.city,
          area: row.area,
          paymentMethod: row.paymentMethod,
          paymentStatus: row.paymentStatus,
          shippingCompanyId,
          storeId,
          items,
          shippingCost: row.shippingCost,
          allowOpenPackage: row.allowOpenPackage,
          deposit: row.deposit,
          discount: row.discount,
          additionalFees: row.additionalFees,
          notes: row.notes,
          customerNotes: row.customerNotes,
        });
      }
    }

    const skuErrors: { sku: string; totalQty: number; available: number }[] =
      [];

    for (const [sku, usageItem] of skuUsage.entries()) {
      const variant = variantMap.get(sku);
      if (!variant) continue;

      const available = await this.calculateAvailableStock(
        variant.stockOnHand || 0,
        variant.reserved || 0,
        adminId,
      );

      if (usageItem.totalQty > available) {
        skuErrors.push({
          sku,
          totalQty: usageItem.totalQty,
          available,
        });

        for (const rowNumber of usageItem.rowNumbers) {
          addCellError(
            rowNumber,
            19,
            this.translations.t("domains.orders.bulk_sku_exceeds_stock", {
              args: { sku, totalQty: usageItem.totalQty, available },
            }),
          );
        }
      }
    }

    let errorFileBuffer: Buffer | undefined;

    if (cellErrors.size > 0 || skuErrors.length > 0) {
      const rowsForReport = rows.map((r) => ({
        ...r,
        // keep original data; cells will be highlighted based on cellErrors
      }));

      errorFileBuffer = await this.generateErrorReportExcel(
        rowsForReport,
        cellErrors,
        skuErrors.map((s) => ({
          ...s,
          rows: [...(skuUsage.get(s.sku)?.rowNumbers || [])],
        })),
      );
      return {
        message: this.translations.t("domains.orders.bulk_validation_failed", {
          args: { rowCount: cellErrors.size, skuCount: skuErrors.length },
        }),
        failed: rows.length,
        errorFileBuffer,
        skuErrors,
      };
    }

    if (validOrderPayloads.length > 0) {
      await this.orderSyncQueueService.enqueueBulkOrderCreate(
        adminId,
        validOrderPayloads,
      );
    }

    return {
      message:
        validOrderPayloads.length > 0
          ? this.translations.t("domains.orders.bulk_orders_queued", {
            args: { count: validOrderPayloads.length },
          })
          : this.translations.t("domains.orders.bulk_no_valid_orders"),
      failed: rows.length - validOrderPayloads.length,
      errorFileBuffer,
      skuErrors,
    };
  }

  private async generateErrorReportExcel(
    rows: any[],
    cellErrors: CellErrorMap,
    skuErrors: SkuErrorRow[],
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Madar";
    workbook.created = new Date();

    // -------------------------
    // Sheet 1: Orders
    // -------------------------
    const sheet = workbook.addWorksheet("Orders", {
      views: [{ state: "frozen", ySplit: 2 }],
    });

    const columns = [
      {
        header: this.translations.t("domains.orders.export_items"),
        key: "items",
        width: 50,
      },
      {
        header: this.translations.t("domains.orders.export_customer_name"),
        key: "customerName",
        width: 22,
      },
      {
        header: this.translations.t("domains.orders.export_phone_number"),
        key: "phoneNumber",
        width: 16,
      },
      {
        header: this.translations.t(
          "domains.orders.export_second_phone_number",
        ),
        key: "secondPhoneNumber",
        width: 40,
      },
      {
        header: this.translations.t("domains.orders.export_email"),
        key: "email",
        width: 28,
      },
      {
        header: this.translations.t("domains.orders.export_address"),
        key: "address",
        width: 32,
      },
      {
        header: this.translations.t("domains.orders.export_landmark"),
        key: "landmark",
        width: 30,
      },
      {
        header: this.translations.t("domains.orders.export_city"),
        key: "city",
        width: 14,
      },
      {
        header: this.translations.t("domains.orders.export_area"),
        key: "area",
        width: 14,
      },
      {
        header: this.translations.t("domains.orders.export_payment_method"),
        key: "paymentMethod",
        width: 40,
      },
      {
        header: this.translations.t("domains.orders.export_payment_status"),
        key: "paymentStatus",
        width: 40,
      },
      {
        header: this.translations.t("domains.orders.export_shipping_company"),
        key: "shippingCompany",
        width: 45,
      },
      {
        header: this.translations.t("domains.orders.export_allow_open_package"),
        key: "allowOpenPackage",
        width: 45,
      },
      {
        header: this.translations.t("domains.orders.export_store"),
        key: "store",
        width: 30,
      },
      {
        header: this.translations.t("domains.orders.export_shipping_cost"),
        key: "shippingCost",
        width: 30,
      },
      {
        header: this.translations.t("domains.orders.export_deposit"),
        key: "deposit",
        width: 30,
      },
      {
        header: this.translations.t("domains.orders.export_discount"),
        key: "discount",
        width: 30,
      },
      {
        header: this.translations.t("domains.orders.export_additional_fees"),
        key: "additionalFees",
        width: 30,
      },
      {
        header: this.translations.t("domains.orders.export_notes"),
        key: "notes",
        width: 24,
      },
      {
        header: this.translations.t("domains.orders.export_customer_notes"),
        key: "customerNotes",
        width: 40,
      },
    ];

    sheet.columns = columns;

    sheet.insertRow(1, [this.translations.t("domains.orders.export_format")]);
    sheet.mergeCells(1, 1, 1, columns.length);

    const noteRow = sheet.getRow(1);
    noteRow.height = 30;
    noteRow.getCell(1).font = { italic: true, color: { argb: "FF666666" } };
    noteRow.getCell(1).alignment = { wrapText: true, vertical: "middle" };

    const headerRow = sheet.getRow(2);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: "middle", horizontal: "center" };

    const sourceToOutputRow = new Map<number, number>();

    rows.forEach((row, index) => {
      const outRowNumber = index + 3; // because row 1 = note, row 2 = header
      sourceToOutputRow.set(row.rowNumber, outRowNumber);

      const excelRow = sheet.addRow({
        customerName: row.customerName,
        phoneNumber: row.phoneNumber,
        secondPhoneNumber: row.secondPhoneNumber,
        email: row.email,
        address: row.address,
        landmark: row.landmark,
        city: row.city,
        area: row.area,
        paymentMethod: row.paymentMethod,
        paymentStatus: row.paymentStatus,
        shippingCompany: row.shippingCompany,
        allowOpenPackage: row.allowOpenPackage,
        store: row.store,
        shippingCost: row.shippingCost,
        deposit: row.deposit,
        discount: row.discount,
        additionalFees: row.additionalFees,
        notes: row.notes,
        customerNotes: row.customerNotes,
        items: row.itemsRaw,
      });

      const rowErrorMap = cellErrors.get(row.rowNumber);
      if (!rowErrorMap) return;

      for (const [colNumber, messages] of rowErrorMap.entries()) {
        const cell = excelRow.getCell(colNumber);
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFC7CE" },
        };
        cell.font = {
          color: { argb: "FF9C0006" },
        };
        cell.note = messages.join("\n");
      }
    });

    // -------------------------
    // Sheet 2: SKU Errors
    // -------------------------
    const skuSheet = workbook.addWorksheet(
      this.translations.t("domains.orders.export_sku_errors_sheet"),
    );
    skuSheet.columns = [
      {
        header: this.translations.t("domains.orders.export_sku_header"),
        key: "sku",
        width: 24,
      },
      {
        header: this.translations.t("domains.orders.export_total_qty_header"),
        key: "totalQty",
        width: 12,
      },
      {
        header: this.translations.t("domains.orders.export_available_header"),
        key: "available",
        width: 12,
      },
      {
        header: this.translations.t("domains.orders.export_rows_header"),
        key: "rows",
        width: 20,
      },
      {
        header: this.translations.t("domains.orders.export_message_header"),
        key: "message",
        width: 60,
      },
    ];

    const skuHeader = skuSheet.getRow(1);
    skuHeader.font = { bold: true };
    skuHeader.alignment = { vertical: "middle", horizontal: "center" };

    for (const skuError of skuErrors) {
      skuSheet.addRow({
        sku: skuError.sku,
        totalQty: skuError.totalQty,
        available: skuError.available,
        rows: skuError.rows.join(", "),
        message: this.translations.t(
          "domains.orders.bulk_sku_requested_available",
          {
            args: {
              totalQty: skuError.totalQty,
              available: skuError.available,
            },
          },
        ),
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
  async createBulkOrders(orders: CreateOrderDto[], adminId: string) {
    const me = { adminId };

    let created = 0;
    const createdOrders: { index: number; customerName: string }[] = [];

    try {
      await this.dataSource.transaction(async (manager) => {
        for (let i = 0; i < orders.length; i++) {
          const dto = orders[i];

          await this.createWithManager(manager, adminId, me, dto, undefined);

          created++;

          createdOrders.push({
            index: i + 1,
            customerName: dto.customerName,
          });
        }
      });
    } catch (error: any) {
      created = 0;

      await this.notificationService.create({
        userId: adminId,
        type: NotificationType.BULK_ORDERS_FAILED,
        title: await this.requestTranslations.tAsync(
          "domains.orders.bulk_orders_failed_title",
          adminId,
        ),
        message: await this.requestTranslations.tAsync(
          "domains.orders.bulk_orders_failed_message_with_error",
          adminId,
          { args: { errorMessage: error.message } },
        ),
      });

      throw new BadRequestException(
        this.translations.t("domains.orders.failed_create_orders", {
          args: { errorMessage: error.message },
        }),
      );
    }

    // =========================
    // SUCCESS NOTIFICATION
    // =========================
    if (created > 0) {
      const preview = createdOrders
        .slice(0, 5)
        .map((o) => `#${o.index} - ${o.customerName}`)
        .join(", ");

      await this.notificationService.create({
        userId: adminId,
        type: NotificationType.BULK_ORDERS_CREATED,
        title: await this.requestTranslations.tAsync(
          "domains.orders.bulk_orders_created_title",
          adminId,
        ),
        message:
          this.translations.t("domains.orders.bulk_orders_created_message", {
            args: { count: created },
          }) +
          (preview
            ? `\n${this.translations.t("domains.orders.bulk_orders_created_preview", { args: { preview } })}`
            : ""),
      });
    } else {
      await this.notificationService.create({
        userId: adminId,
        type: NotificationType.BULK_ORDERS_FAILED,
        title: await this.requestTranslations.tAsync(
          "domains.orders.bulk_orders_failed_title",
          adminId,
        ),
        message: await this.requestTranslations.tAsync(
          "domains.orders.bulk_orders_failed_message",
          adminId,
        ),
      });
    }

    return createdOrders;
  }

  public async deductStockForOrder(
    manager: EntityManager,
    orderId: string,
    adminId: string,
    options: { skipValidation?: boolean } = {},
  ) {
    const settings =
      await this.clientSettingsService.getCachedSettings(adminId);

    // 1. جلب الطلب مع التحقق من الـ adminId للأمان
    const order = await manager.getRepository(OrderEntity).findOne({
      where: { id: orderId, adminId },
      relations: ["status", "items", "items.variant"],
    });

    if (!order) {
      throw new NotFoundException(
        this.translations.t("domains.orders.order_not_found"),
      );
    }

    // 2. التحقق من استراتيجية خصم المخزون
    const shouldDedicate =
      (settings.stockDeductionStrategy ===
        StockDeductionStrategy.ON_CONFIRMATION &&
        order.status.code === OrderStatus.CONFIRMED) ||
      (settings.stockDeductionStrategy === StockDeductionStrategy.ON_SHIPMENT &&
        order.status.code === OrderStatus.SHIPPED);

    const isDellivered = order.status.code === OrderStatus.DELIVERED;
    if (!shouldDedicate && !isDellivered) return;

    // Map لتجميع الكميات (في حال تكرار نفس المنتج في أسطر مختلفة بالطلب)
    const variantDeductions = new Map<string, number>();
    const itemsToUpdateIds: string[] = [];

    for (const item of order.items) {
      if (!item.variant) continue;

      const variantId = item.variant.id;
      const qty = getMissingDeductionQuantity(item);
      if (qty <= 0) continue;

      const currentTotal = variantDeductions.get(variantId) || 0;
      variantDeductions.set(variantId, currentTotal + qty);

      itemsToUpdateIds.push(item.id);
    }

    if (itemsToUpdateIds.length > 0) {
      // 3. التحقق من توفر المخزون قبل الخصم
      if (!options.skipValidation) {
        const stockCheckItems = Array.from(variantDeductions.entries()).map(
          ([variantId, qty]) => {
            const item = order.items.find((it) => it.variant?.id === variantId);
            return {
              variantId,
              quantity: qty,
              variant: item?.variant,
              sku: item?.variant?.sku,
            };
          },
        );

        await this.validateStockAvailability(adminId, stockCheckItems, {
          isDeduction: true,
        });
      }

      // 4. تنفيذ التحديثات في قاعدة البيانات مباشرة (Atomic Updates)
      const variantUpdates = Array.from(variantDeductions.entries()).map(
        ([id, qty]) => {
          const updateSet: any = {
            stockOnHand: () =>
              options.skipValidation
                ? `"stockOnHand" - ${qty}`
                : `GREATEST(0, "stockOnHand" - ${qty})`,
            reserved: () =>
              options.skipValidation
                ? `"reserved" - ${qty}`
                : `GREATEST(0, "reserved" - ${qty})`,
          };

          return manager
            .createQueryBuilder()
            .update(ProductVariantEntity)
            .set(updateSet)
            .where("id = :id", { id })
            .execute();
        },
      );

      // 4. تحديث حالة أسطر الطلب
      const itemsUpdate = manager
        .createQueryBuilder()
        .update(OrderItemEntity)
        .set({ stockDeducted: true, stockDeductedQuantity: () => `"quantity"` })
        .where("id IN (:...ids)", { ids: itemsToUpdateIds })
        .execute();

      // تشغيل جميع الاستعلامات بالتوازي لسرعة الأداء
      await Promise.all([...variantUpdates, itemsUpdate]);
    }
  }

  public async deductStockForMultipleOrders(
    manager: EntityManager,
    orderIds: string[],
    adminId: string,
    options: { skipValidation?: boolean } = {},
  ) {
    const settings =
      await this.clientSettingsService.getCachedSettings(adminId);

    // Map لتخزين إجمالي الكمية المراد خصمها لكل Variant
    // Key: variantId, Value: totalQty
    const variantDeductions = new Map<string, number>();
    const itemsToUpdateIds: string[] = [];

    const orders = await manager.getRepository(OrderEntity).find({
      where: { id: In(orderIds), adminId }, // تأكد من إضافة adminId للأمان
      relations: ["status", "items", "items.variant"],
    });

    for (const order of orders) {
      const shouldDedicate =
        (settings.stockDeductionStrategy ===
          StockDeductionStrategy.ON_CONFIRMATION &&
          order.status.code === OrderStatus.CONFIRMED) ||
        (settings.stockDeductionStrategy ===
          StockDeductionStrategy.ON_SHIPMENT &&
          order.status.code === OrderStatus.SHIPPED);

      if (!shouldDedicate) continue;

      for (const item of order.items) {
        if (!item.variant) continue;

        const variantId = item.variant.id;
        const qty = getMissingDeductionQuantity(item);
        if (qty <= 0) continue;

        // تجميع الكميات لكل VariantID
        const currentTotal = variantDeductions.get(variantId) || 0;
        variantDeductions.set(variantId, currentTotal + qty);

        itemsToUpdateIds.push(item.id);
      }
    }

    if (itemsToUpdateIds.length > 0) {
      // 1. التحقق من توفر المخزون قبل الخصم لجميع الطلبات
      if (!options.skipValidation) {
        const stockCheckItems = Array.from(variantDeductions.entries()).map(
          ([variantId, qty]) => {
            let variant: ProductVariantEntity | undefined;
            for (const order of orders) {
              const item = order.items.find(
                (it) => it.variant?.id === variantId,
              );
              if (item?.variant) {
                variant = item.variant;
                break;
              }
            }
            return {
              variantId,
              quantity: qty,
              variant,
              sku: variant?.sku,
            };
          },
        );

        await this.validateStockAvailability(adminId, stockCheckItems, {
          isDeduction: true,
        });
      }

      const variantUpdates = Array.from(variantDeductions.entries()).map(
        ([id, qty]) => {
          const updateSet: any = {
            stockOnHand: () =>
              options.skipValidation
                ? `"stockOnHand" - ${qty}`
                : `GREATEST(0, "stockOnHand" - ${qty})`,
            reserved: () =>
              options.skipValidation
                ? `"reserved" - ${qty}`
                : `GREATEST(0, "reserved" - ${qty})`,
          };

          return manager
            .createQueryBuilder()
            .update(ProductVariantEntity)
            .set(updateSet)
            .where("id = :id", { id })
            .execute();
        },
      );

      // 2. تحديث عناصر الطلب (Order Items) لتجنب الخصم المتكرر
      const itemUpdate = manager
        .createQueryBuilder()
        .update(OrderItemEntity)
        .set({ stockDeducted: true, stockDeductedQuantity: () => `"quantity"` })
        .where("id IN (:...ids)", { ids: itemsToUpdateIds })
        .execute();

      await Promise.all([...variantUpdates, itemUpdate]);
    }
  }

  async calculateAvailableStock(
    stockOnHand: number,
    reserved: number,
    adminId: string,
  ): Promise<number> {
    const settings =
      await this.clientSettingsService.getCachedSettings(adminId);
    const reservedEnabled = settings?.reservedEnabled ?? false;

    if (reservedEnabled) {
      return Math.max(0, (stockOnHand ?? 0) - (reserved ?? 0));
    }
    return Math.max(0, stockOnHand ?? 0);
  }

  /**
   * Reusable stock validation logic.
   * Checks if there is enough stock available for a list of items.
   *
   * @param adminId - The admin ID for settings context.
   * @param items - List of items to check.
   * @param options - Configuration options.
   */
  public async validateStockAvailability(
    adminId: string,
    items: {
      variantId: string;
      quantity: number;
      variant?: ProductVariantEntity;
      sku?: string;
    }[],
    options: {
      isDeduction?: boolean;
      variantMap?: Map<string, ProductVariantEntity>;
      errorMessagePrefix?: string;
    } = {},
  ) {
    const { isDeduction = false, variantMap, errorMessagePrefix } = options;

    for (const item of items) {
      const variant = item.variant || variantMap?.get(item.variantId);
      if (!variant) {
        throw new BadRequestException(
          this.translations.t("domains.orders.variant_not_found", {
            args: { variantId: item.variantId },
          }),
        );
      }

      let available: number;
      if (isDeduction) {
        // When deducting, we are fulfilling an order that might already be reserved.
        // We just need to ensure we have enough physical stock on hand.
        available = variant.stockOnHand || 0;
      } else {
        // When creating/updating, we check against the configured "available" stock.
        available = await this.calculateAvailableStock(
          variant.stockOnHand || 0,
          variant.reserved || 0,
          adminId,
        );
      }

      if (available < item.quantity) {
        const prefix = errorMessagePrefix ? `${errorMessagePrefix}: ` : "";
        const sku = variant.sku || item.sku || item.variantId;

        const message = isDeduction
          ? this.translations.t("domains.orders.insufficient_stock_deduct", {
            args: { prefix, sku, available, quantity: item.quantity },
          })
          : this.translations.t("domains.orders.insufficient_stock_order", {
            args: { prefix, sku, available },
          });

        throw new BadRequestException(message);
      }
    }
  }

  /**
   * Non-throwing stock check for automation conditions and read-only validations.
   */
  public async isStockSufficientForItems(
    adminId: string,
    items: {
      variantId: string;
      quantity: number;
      variant?: ProductVariantEntity;
      sku?: string;
    }[],
    options: {
      isDeduction?: boolean;
      variantMap?: Map<string, ProductVariantEntity>;
    } = {},
  ): Promise<boolean> {
    if (!items.length) {
      return false;
    }

    try {
      await this.validateStockAvailability(adminId, items, options);
      return true;
    } catch (error) {
      if (error instanceof BadRequestException) {
        return false;
      }
      throw error;
    }
  }

  public async isStockSufficientForOrder(
    order: Pick<OrderEntity, "adminId" | "items">,
    options: { isDeduction?: boolean } = {},
  ): Promise<boolean> {
    const items = (order.items || []).map((item) => ({
      variantId: item.variantId,
      quantity: item.quantity,
      variant: item.variant,
      sku: item.variant?.sku,
    }));

    return this.isStockSufficientForItems(order.adminId, items, options);
  }

  async getAllowedConfirmationStatuses(me: any): Promise<OrderStatusEntity[]> {
    const adminId = tenantId(me);

    // 1. Get the codes from settings
    const settings = await this.clientSettingsService.getSettings(me);
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
        "status.percentFrom",
      ])
      .addSelect("COUNT(assignment.id)", "count")
      .addSelect(
        "COUNT(CASE WHEN order.isConfirmed = true THEN assignment.id END)",
        "previouslyConfirmedCount",
      )
      .where(
        new Brackets((qb) => {
          qb.where("status.adminId = :adminId", { adminId }).orWhere(
            "status.system = true",
          );
        }),
      )
      .andWhere("status.isActive = true")
      .groupBy("status.id")
      .orderBy("status.sortOrder", "ASC")
      .getRawMany();

    const totalOrders = results.reduce(
      (sum, r) => sum + (Number(r.count) || 0),
      0,
    );
    const countsByCode = this.buildStatusCountsByCode(results);
    const previouslyConfirmedCount = results.reduce(
      (sum, r) =>
        sum +
        (Number(
          r.previouslyConfirmedCount ?? r.previouslyconfirmedcount,
        ) || 0),
      0,
    );

    return results.map((r) => {
      const count = Number(r.count) || 0;
      const system = !!r.status_system;
      const percentFrom = this.resolvePercentFrom(
        system,
        r.status_percentFrom ?? r.status_percent_from,
      );
      return {
        id: r.status_id,
        name: r.status_name,
        code: r.status_code,
        color: r.status_color,
        system,
        percentFrom,
        count,
        percent: this.computeStatusPercent(
          count,
          percentFrom,
          totalOrders,
          countsByCode,
          previouslyConfirmedCount,
        ),
      };
    });
  }

  ALLOWED_STATUS_CODES_FOR_ASSIGNMENT = new Set([
    OrderStatus.CANCELLED,
    OrderStatus.RETURNED,
    OrderStatus.PARTIALLY_RETURNED,
    OrderStatus.FAILED_DELIVERY,
    OrderStatus.REJECTED,
    OrderStatus.NO_ANSWER,
    OrderStatus.POSTPONED,
    OrderStatus.NEW,
    OrderStatus.UNDER_REVIEW,
    OrderStatus.OUT_OF_DELIVERY_AREA,
  ]);

  /**
   * Single Order Log Helper
   */
  async logOrderAction(params: {
    manager?: EntityManager;
    adminId: string;
    userId: string;
    orderId: string;
    actionType: OrderActionType;
    shippingCompanyId?: string;
    result?: OrderActionResult;
    details?: string;
  }) {
    const repo = params.manager
      ? params.manager.getRepository(OrderActionLogEntity)
      : this.orderActionLogRepo;

    const dateStr = Date.now();
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
    userId: string;
    orderIds: string[];
    actionType: OrderActionType;
    shippingCompanyId?: string;
    result?: OrderActionResult;
    details?: string;
  }) {
    const dateStr = Date.now();
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
