import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DateFilterUtil } from "common/date-filter.util";
import {
  AutoAssignDto,
  AutoPreviewDto,
  CreateAutoAssignRuleDto,
  GetFreeOrdersDto,
  ManualAssignManyDto,
  UpdateAutoAssignRuleDto,
} from "dto/order-assignment.dto";
import {
  OrderAssignmentEntity,
  AutoAssignRuleEntity,
  AutoAssignRuleType,
  AssignmentStrategy,
  WeekDay,
} from "entities/assignment.entity";
import {
  OrderEntity,
  OrderStatus,
  OrderStatusEntity,
  OrderStatusPercentFrom,
} from "entities/order.entity";
import { OrderTagEntity } from "entities/tag.entity";
import { OrderCancelCauseEntity } from "entities/cancel-cause.entity";
import { AssignmentMode } from "entities/clientSettings.entity";
import { TimeUnit } from "entities/clientSettings.entity";
import { User } from "entities/user.entity";
import { tenantId } from "src/category/category.service";
import { OrdersService } from "src/orders/services/orders.service";
import { Brackets, DataSource, EntityManager, In, Repository } from "typeorm";
import * as ExcelJS from "exceljs";
import { ProductEntity } from "entities/sku.entity";
import { CityEntity } from "entities/cities.entity";
import { ShippingCompanyEntity } from "entities/shipping.entity";
import { NotificationService } from "src/notifications/notification.service";
import { NotificationType } from "entities/notifications.entity";
import { BitmaskHelper, WeekDayHelper } from "common/bitmask.helper";
import { StoreEntity } from "entities/stores.entity";
import { ClientSettingsService } from "src/client-settings/client-settings.service";
import {
  RequestTranslationService,
  TranslationService,
} from "common/translation.service";
import { OnboardingAchievementService } from "src/queue/queues/onboarding-achievement.queue";
import { GettingStartedAchievementType } from "entities/getting-started.entity";
import { TagAutomationEvaluator } from "src/tags/tag-automation.evaluator";
import { AutoAssignmentQueueService } from "src/queue/queues/auto-assignment.queue";
import { TriggerDispatcherService } from "src/automation/engine/triggerDispatcher.service";
import { TriggerEntityType, TriggerType } from "entities/automation.entity";

@Injectable()
export class OrderAssignmentService {
  private readonly logger = new Logger(OrderAssignmentService.name);
  constructor(
    @InjectRepository(OrderAssignmentEntity)
    private readonly orderAssignmentRepo: Repository<OrderAssignmentEntity>,
    @InjectRepository(AutoAssignRuleEntity)
    private readonly autoAssignRuleRepo: Repository<AutoAssignRuleEntity>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    private dataSource: DataSource,

    @InjectRepository(OrderEntity)
    private orderRepo: Repository<OrderEntity>,

    @InjectRepository(OrderStatusEntity)
    private statusRepo: Repository<OrderStatusEntity>,

    @InjectRepository(ProductEntity)
    private readonly productRepo: Repository<ProductEntity>,

    @InjectRepository(CityEntity)
    private readonly cityRepo: Repository<CityEntity>,

    @InjectRepository(ShippingCompanyEntity)
    private readonly shippingCompanyRepo: Repository<ShippingCompanyEntity>,

    @Inject(forwardRef(() => OrdersService))
    protected readonly ordersService: OrdersService,

    @Inject(forwardRef(() => NotificationService))
    protected readonly notificationService: NotificationService,

    @InjectRepository(StoreEntity)
    private readonly storeRepo: Repository<StoreEntity>,
    private readonly clientSettingsService: ClientSettingsService,
    private readonly translations: TranslationService,
    private requestTranslations: RequestTranslationService,
    private readonly onboardingAchievementService: OnboardingAchievementService,
    @Inject(forwardRef(() => TagAutomationEvaluator))
    private readonly tagAutomationEvaluator: TagAutomationEvaluator,
    @Inject(forwardRef(() => AutoAssignmentQueueService))
    private readonly autoAssignmentQueueService: AutoAssignmentQueueService,
    @Inject(forwardRef(() => TriggerDispatcherService))
    private readonly triggerDispatcher: TriggerDispatcherService,
  ) {}

  private async dispatchAssignmentCancelledAutomations(
    adminId: string,
    orderIds: string[],
    cancelSource: "automatic" | "manual",
  ) {
    const uniqueOrderIds = [...new Set(orderIds.filter(Boolean))];
    if (!uniqueOrderIds.length) {
      return;
    }

    const orders = await this.orderRepo.find({
      where: { id: In(uniqueOrderIds), adminId },
      relations: [
        "status",
        "items",
        "items.variant",
        "items.variant.product",
      ],
    });

    if (!orders.length) {
      return;
    }

    const results = await Promise.allSettled(
      orders.map((order) =>
        this.triggerDispatcher.dispatch({
          type: TriggerType.ASSIGNMENT_CANCELLED,
          entityType: TriggerEntityType.ORDER,
          entityId: order.id,
          adminId,
          payload: {
            ...order,
            assignmentCancelSource: cancelSource,
          },
        }),
      ),
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const orderId = orders[index]?.id ?? uniqueOrderIds[index];
        this.logger.error(
          `[dispatchAssignmentCancelledAutomations] Failed for order ${orderId}`,
          result.reason instanceof Error ? result.reason.stack : result.reason,
        );
      }
    });
  }

  async expireAssignment(
    adminId: string,
    data: { orderId: string; assignmentId: string },
  ) {
    const settings =
      await this.clientSettingsService.getCachedSettings(adminId);
    if (!settings?.assignmentExpiryEnabled) {
      this.logger.debug(
        `Skip expire assignment ${data.assignmentId}: expiry disabled`,
      );
      return { skipped: true, reason: "expiry_disabled" };
    }

    const assignment = await this.orderAssignmentRepo.findOne({
      where: {
        id: data.assignmentId,
        orderId: data.orderId,
        assignedByAdminId: adminId,
        isAssignmentActive: true,
      },
      relations: ["order", "employee"],
    });

    if (!assignment) {
      this.logger.debug(
        `Skip expire assignment ${data.assignmentId}: not active`,
      );
      return { skipped: true, reason: "not_active" };
    }

    assignment.isAssignmentActive = false;
    assignment.finishedAt = new Date();
    assignment.lockedUntil = null;
    await this.orderAssignmentRepo.save(assignment);

    await this.notificationService.create({
      userId: adminId,
      type: NotificationType.ORDER_ASSIGNED,
      title: await this.requestTranslations.tAsync(
        "domains.order_assignment.order_assignment_expired_title",
        adminId,
      ),
      message: await this.requestTranslations.tAsync(
        "domains.order_assignment.order_assignment_expired_message",
        adminId,
        {
          args: {
            orderNumber: assignment.order?.orderNumber ?? data.orderId,
            employeeName: assignment.employee?.name ?? "",
          },
        },
      ),
      relatedEntityType: "order",
      relatedEntityId: String(data.orderId),
    });

    this.logger.debug(
      `Expired assignment ${data.assignmentId} for order ${data.orderId}`,
    );

    try {
      await this.dispatchAssignmentCancelledAutomations(
        adminId,
        [data.orderId],
        "automatic",
      );
    } catch (error) {
      this.logger.error(
        `[expireAssignment] Automation dispatch failed for order ${data.orderId}`,
        error instanceof Error ? error.stack : error,
      );
    }

    return { success: true, assignmentId: assignment.id };
  }

  private async scheduleAssignmentExpiry(
    adminId: string,
    assignments: Array<{ id: string; orderId: string }>,
  ) {
    if (!adminId || !assignments?.length) return;

    const settings =
      await this.clientSettingsService.getCachedSettings(adminId);
    if (
      !settings?.assignmentExpiryEnabled ||
      !settings.assignmentExpiryHours ||
      settings.assignmentExpiryHours < 1
    ) {
      return;
    }

    const delayMs = settings.assignmentExpiryHours * 60 * 60 * 1000;

    await Promise.all(
      assignments.map((a) =>
        this.autoAssignmentQueueService.enqueueExpireAssignment(
          adminId,
          { orderId: a.orderId, assignmentId: a.id },
          { delayMs },
        ),
      ),
    );
  }

  private async bulkUpdateOrderStatusOnAssignment(
    orderIds: string[],
    adminId: string,
    manager: EntityManager,
  ): Promise<void> {
    // Step 1: Fetch all orders with their statuses
    const orders = await manager
      .createQueryBuilder(OrderEntity, "order")
      .innerJoinAndSelect("order.status", "status")
      .where("order.id IN (:...orderIds)", { orderIds })
      .getMany();

    if (!orders.length) return;

    // Step 2: Find the required new statuses for this admin
    const [
      cancelledFollowUpStatus,
      noAnswerFollowUpStatus,
      noAnswerStatus,
      cancelledStatus,
    ] = await Promise.all([
      this.ordersService.findStatusByCode(
        OrderStatus.CANCELLED_FOLLOW_UP,
        adminId,
        manager,
      ),
      this.ordersService.findStatusByCode(
        OrderStatus.NO_ANSWER_FOLLOW_UP,
        adminId,
        manager,
      ),
      this.ordersService.findStatusByCode(
        OrderStatus.NO_ANSWER,
        adminId,
        manager,
      ),
      this.ordersService.findStatusByCode(
        OrderStatus.CANCELLED,
        adminId,
        manager,
      ),
    ]);

    // Step 3: Determine which orders need updating and prepare changes
    const orderStatusChanges: Array<{
      orderId: string;
      fromStatusId: string | null;
      toStatusId: string;
    }> = [];

    const ordersToUpdate: string[] = [];

    for (const order of orders) {
      let newStatus = null;
      if (
        order.status?.code === OrderStatus.CANCELLED &&
        cancelledFollowUpStatus
      ) {
        newStatus = cancelledFollowUpStatus;
      } else if (
        order.status?.code === OrderStatus.NO_ANSWER &&
        noAnswerFollowUpStatus
      ) {
        newStatus = noAnswerFollowUpStatus;
      }

      if (newStatus) {
        ordersToUpdate.push(order.id);
        orderStatusChanges.push({
          orderId: order.id,
          fromStatusId: order.statusId,
          toStatusId: newStatus.id,
        });
      }
    }

    if (!ordersToUpdate.length) return;
    // Update all orders in one query using CASE statement
    await manager
      .createQueryBuilder()
      .update(OrderEntity)
      .set({
        statusId: () => `
                        CASE 
                            WHEN statusId = :cancelledStatusId THEN :cancelledFollowUpStatusId
                            WHEN statusId = :noAnswerStatusId THEN :noAnswerFollowUpStatusId
                            ELSE statusId
                        END
                    `,
        oldStatusId: "statusId",
      })
      .where("id IN (:...orderIds)", { orderIds: ordersToUpdate })
      .setParameters({
        cancelledStatusId: cancelledStatus?.id,
        cancelledFollowUpStatusId: cancelledFollowUpStatus.id,
        noAnswerStatusId: noAnswerStatus?.id,
        noAnswerFollowUpStatusId: noAnswerFollowUpStatus.id,
      })
      .execute();

    // Step 5: Bulk log status changes
    if (orderStatusChanges.length) {
      await this.ordersService.bulkLogStatusChange({
        adminId,
        manager,
        orderStatusChanges,
        notes: this.translations.t(
          "domains.order_assignment.status_updated_on_assignment",
        ),
      });
    }
  }

  private async bulkRevertOrderStatusOnUnassignment(
    orderIds: string[],
    adminId: string,
    manager: EntityManager,
  ): Promise<void> {
    const orders = await manager
      .createQueryBuilder(OrderEntity, "order")
      .innerJoinAndSelect("order.status", "status")
      .where("order.id IN (:...orderIds)", { orderIds })
      .getMany();

    if (!orders.length) return;

    const [
      cancelledStatus,
      noAnswerStatus,
      cancelledFollowUpStatus,
      noAnswerFollowUpStatus,
    ] = await Promise.all([
      this.ordersService.findStatusByCode(
        OrderStatus.CANCELLED,
        adminId,
        manager,
      ),
      this.ordersService.findStatusByCode(
        OrderStatus.NO_ANSWER,
        adminId,
        manager,
      ),
      this.ordersService.findStatusByCode(
        OrderStatus.CANCELLED_FOLLOW_UP,
        adminId,
        manager,
      ),
      this.ordersService.findStatusByCode(
        OrderStatus.NO_ANSWER_FOLLOW_UP,
        adminId,
        manager,
      ),
    ]);

    const orderStatusChanges: Array<{
      orderId: string;
      fromStatusId: string | null;
      toStatusId: string;
    }> = [];

    const ordersToUpdate: string[] = [];

    for (const order of orders) {
      let newStatus = null;

      if (
        order.status?.code === OrderStatus.CANCELLED_FOLLOW_UP &&
        cancelledStatus
      ) {
        newStatus = cancelledStatus;
      } else if (
        order.status?.code === OrderStatus.NO_ANSWER_FOLLOW_UP &&
        noAnswerStatus
      ) {
        newStatus = noAnswerStatus;
      }

      if (newStatus) {
        ordersToUpdate.push(order.id);
        orderStatusChanges.push({
          orderId: order.id,
          fromStatusId: order.statusId,
          toStatusId: newStatus.id,
        });
      }
    }

    if (!ordersToUpdate.length) return;

    await manager
      .createQueryBuilder()
      .update(OrderEntity)
      .set({
        statusId: () => `
                CASE
                    WHEN statusId = :cancelledFollowUpStatusId THEN :cancelledStatusId
                    WHEN statusId = :noAnswerFollowUpStatusId THEN :noAnswerStatusId
                    ELSE statusId
                END
            `,
        oldStatusId: "statusId",
      })
      .where("id IN (:...orderIds)", { orderIds: ordersToUpdate })
      .setParameters({
        cancelledFollowUpStatusId: cancelledFollowUpStatus?.id,
        cancelledStatusId: cancelledStatus?.id,
        noAnswerFollowUpStatusId: noAnswerFollowUpStatus?.id,
        noAnswerStatusId: noAnswerStatus?.id,
      })
      .execute();

    if (orderStatusChanges.length) {
      await this.ordersService.bulkLogStatusChange({
        adminId,
        manager,
        orderStatusChanges,
        notes: this.translations.t(
          "domains.order_assignment.status_reverted_on_unassignment",
        ),
      });
    }
  }

  async removeActiveAssignments(me: any, orderIds: string[]) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const result = await this.dataSource.transaction(async (manager) => {
      // Find active assignments
      const assignments = await manager.find(OrderAssignmentEntity, {
        where: {
          assignedByAdminId: adminId,
          isAssignmentActive: true,
          orderId: In(orderIds),
        },
      });

      if (!assignments.length) {
        throw new NotFoundException(
          this.translations.t("domains.order_assignment.no_active_assignments"),
        );
      }

      const assignmentOrderIds = [
        ...new Set(assignments.map((a) => a.orderId).filter(Boolean)),
      ];

      // Revert follow-up statuses back to their original statuses
      await this.bulkRevertOrderStatusOnUnassignment(
        assignmentOrderIds,
        adminId,
        manager,
      );

      await manager.delete(OrderAssignmentEntity, {
        assignedByAdminId: adminId,
        isAssignmentActive: true,
        orderId: In(assignmentOrderIds),
      });

      return {
        success: true,
        message: this.translations.t(
          "domains.order_assignment.assignments_removed_success",
          {
            args: { count: assignmentOrderIds.length },
          },
        ),
        assignmentOrderIds,
      };
    });

    try {
      await this.tagAutomationEvaluator.evaluateOrders(
        result.assignmentOrderIds,
        adminId,
      );
    } catch (error) {
      this.logger.error(
        "[removeActiveAssignments] Tag evaluate failed after unassignment",
        error instanceof Error ? error.stack : error,
      );
    }

    try {
      await this.dispatchAssignmentCancelledAutomations(
        adminId,
        result.assignmentOrderIds,
        "manual",
      );
    } catch (error) {
      this.logger.error(
        "[removeActiveAssignments] Automation dispatch failed after unassignment",
        error instanceof Error ? error.stack : error,
      );
    }

    return {
      success: result.success,
      message: result.message,
    };
  }

  async getEmployeesByLoad(
    me: any,
    limit: number = 20,
    cursor: number | null,
    role?: string,
  ) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const fetchLimit = Number(limit) || 20;

    const qb = this.userRepo
      .createQueryBuilder("user")
      .leftJoin("user.role", "role")
      .leftJoin(
        "user.assignments",
        "assignment",
        `
          assignment."isAssignmentActive" = true
          AND EXISTS (
            SELECT 1
            FROM "orders" o
            WHERE o.id = assignment."orderId"
          )
        `,
      )
      .leftJoin("assignment.order", "o")
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
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

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
        this.translations.t(
          "domains.order_assignment.order_single_employee_only",
        ),
      );
    }

    const summary = await this.dataSource.transaction(async (manager) => {
      // 1) verify employees exist & belong to admin
      const employees = await manager.find(User, {
        where: { id: In(employeeIds), adminId } as any,
      });

      if (employees.length !== employeeIds.length) {
        throw new NotFoundException(
          this.translations.t("domains.order_assignment.employees_not_found"),
        );
      }

      // 2) verify orders exist & belong to admin
      const freeOrders = await manager
        .createQueryBuilder(OrderEntity, "order")
        .innerJoin("order.status", "status")
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

      for (const order of freeOrders) {
        if (
          order.status &&
          !this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT.has(
            order.status.code as OrderStatus,
          )
        ) {
          throw new BadRequestException(
            this.translations.t(
              "domains.order_assignment.order_status_not_allowed",
              {
                args: {
                  orderNumber: order.orderNumber,
                  statusName: order.status.name,
                  allowedStatuses: [
                    ...this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT,
                  ].join(", "),
                },
              },
            ),
          );
        }
      }

      if (freeOrders.length !== allOrderIds.length) {
        throw new BadRequestException(
          this.translations.t(
            "domains.order_assignment.orders_invalid_restricted_assigned",
          ),
        );
      }

      const cannotAssignClosedMessage = this.translations.t(
        "domains.order_assignment.cannot_assign_closed_order",
      );
      freeOrders.forEach(
        async (o) =>
          await this.ordersService.throwIfDelivered(
            o,
            cannotAssignClosedMessage,
          ),
      );
      // 4) fetch settings
      const settings =
        await this.clientSettingsService.getCachedSettings(adminId);
      const maxRetries = settings?.maxRetries || 3;

      // 5) create assignment entities in bulk
      const assignmentsToSave: OrderAssignmentEntity[] = [];

      for (const item of dto.assignments) {
        for (const orderId of item.orderIds) {
          const assignment = manager.create(OrderAssignmentEntity, {
            orderId,
            employeeId: item.userId,
            assignedByAdminId: adminId,
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

      // Update order statuses if needed
      await this.bulkUpdateOrderStatusOnAssignment(
        allOrderIds,
        adminId,
        manager,
      );

      // return helpful summary
      return {
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
        _savedAssignments: saved.map((s) => ({
          id: s.id,
          orderId: s.orderId,
        })),
      };
    });
    
    await this.scheduleAssignmentExpiry(
      adminId,
      summary._savedAssignments || [],
    );
    const { _savedAssignments, ...rest } = summary;
    return rest;
  }

  async manualAssign(
    employeeId: string,
    order: OrderEntity,
    adminId: string,
  ): Promise<string> {
    const outcome = await this.dataSource.transaction(async (manager) => {
      // Verify employee exists and belongs to admin
      const employee = await manager.findOne(User, {
        where: { id: employeeId, adminId } as any,
      });
      if (!employee) {
        throw new NotFoundException(
          this.translations.t("domains.order_assignment.employee_not_found"),
        );
      }

      // Verify order is free and eligible
      const freeOrder = await manager
        .createQueryBuilder(OrderEntity, "order")
        .innerJoin("order.status", "status")
        .leftJoin(
          "order.assignments",
          "assignment",
          "assignment.isAssignmentActive = :isActive",
          { isActive: true },
        )
        .where("order.id = :orderId", { orderId: order.id })
        .andWhere("assignment.id IS NULL")
        .getOne();

      if (!freeOrder) {
        return { result: "not_eligable" as const, saved: null };
      }

      if (
        freeOrder.status &&
        !this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT.has(
          freeOrder.status.code as any,
        )
      ) {
        return { result: "not_eligable" as const, saved: null };
      }

      // Get settings
      const settings =
        await this.clientSettingsService.getCachedSettings(adminId);
      const maxRetries = settings?.maxRetries || 3;

      // Create assignment
      const saved = await manager.save(
        manager.create(OrderAssignmentEntity, {
          orderId: order.id,
          employeeId: employeeId,
          assignedByAdminId: adminId,
          maxRetriesAtAssignment: maxRetries,
          isAssignmentActive: true,
        }),
      );

      // Update order status if needed
      await this.bulkUpdateOrderStatusOnAssignment(
        [order.id],
        adminId,
        manager,
      );

      return { result: "assigned" as const, saved };
    });

    if (outcome.result === "assigned" && outcome.saved) {
      await this.scheduleAssignmentExpiry(adminId, [
        { id: outcome.saved.id, orderId: outcome.saved.orderId },
      ]);
    }
    return outcome.result;
  }

  async autoAssign(me: any, dto: AutoAssignDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const result = await this.dataSource.transaction(async (manager) => {
      // 1. Find 'Free' Orders (No active assignments)
      const q = manager
        .createQueryBuilder(OrderEntity, "order")
        .innerJoin("order.status", "status")
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
      DateFilterUtil.applyToQueryBuilder(
        q,
        "order.created_at",
        dto?.startDate,
        dto?.endDate,
      );

      const freeOrders = await q.limit(dto.orderCount).getMany();

      for (const order of freeOrders) {
        if (
          order.status &&
          !this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT.has(
            order.status.code as OrderStatus,
          )
        ) {
          throw new BadRequestException(
            this.translations.t(
              "domains.order_assignment.order_status_not_allowed",
              {
                args: {
                  orderNumber: order.orderNumber,
                  statusName: order.status.name,
                  allowedStatuses: [
                    ...this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT,
                  ].join(", "),
                },
              },
            ),
          );
        }
      }

      if (freeOrders.length === 0) {
        throw new NotFoundException(
          this.translations.t("domains.order_assignment.no_free_orders"),
        );
      }
      if (freeOrders.length !== dto.orderCount) {
        throw new BadRequestException(
          this.translations.t(
            "domains.order_assignment.cannot_fulfill_order_count",
            {
              args: {
                requestedCount: dto.orderCount,
                availableCount: freeOrders.length,
              },
            },
          ),
        );
      }
      const cannotAssignClosedMessage = this.translations.t(
        "domains.order_assignment.cannot_assign_closed_order",
      );
      freeOrders.forEach(
        async (o) =>
          await this.ordersService.throwIfDelivered(
            o,
            cannotAssignClosedMessage,
          ),
      );

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
        throw new NotFoundException(
          this.translations.t("domains.order_assignment.no_eligible_employees"),
        );
      }

      if (employees.length < dto.employeeCount) {
        throw new BadRequestException(
          this.translations.t(
            "domains.order_assignment.insufficient_employees",
            {
              args: {
                requestedCount: dto.employeeCount,
                availableCount: employees.length,
              },
            },
          ),
        );
      }

      // 3. Fetch Settings
      const settings =
        await this.clientSettingsService.getCachedSettings(adminId);
      const maxRetries = settings?.maxRetries || 3;

      const assignmentsToSave: OrderAssignmentEntity[] = [];

      freeOrders.forEach((order, index) => {
        const employee = employees[index % employees.length]; // Cycle through employees

        const assignment = manager.create(OrderAssignmentEntity, {
          orderId: order.id,
          employeeId: employee.id,
          assignedByAdminId: adminId,
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

      // Update order statuses if needed
      const allOrderIds = freeOrders.map((o) => o.id);
      await this.bulkUpdateOrderStatusOnAssignment(
        allOrderIds,
        adminId,
        manager,
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
        _savedAssignments: saved.map((s) => ({
          id: s.id,
          orderId: s.orderId,
        })),
      };
    });

    await this.scheduleAssignmentExpiry(
      adminId,
      result._savedAssignments || [],
    );
    const { _savedAssignments, ...rest } = result;
    return rest;
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
    DateFilterUtil.applyToQueryBuilder(
      orderCountQuery,
      "order.created_at",
      dto?.startDate,
      dto?.endDate,
    );

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
      string,
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

  async listMyAssignedOrders(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const myUserId = me?.id;
    if (!myUserId) {
      throw new BadRequestException(
        this.translations.t("common.missing_user_id"),
      );
    }

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
    if (q?.paymentStatus) {
      qb.andWhere("order.paymentStatus = :paymentStatus", {
        paymentStatus: q.paymentStatus,
      });
    }

    if (q?.paymentMethod) {
      qb.andWhere("order.paymentMethod = :paymentMethod", {
        paymentMethod: q.paymentMethod,
      });
    }

    if (q?.shippingCompanyId) {
      qb.andWhere("order.shippingCompanyId = :shippingCompanyId", {
        shippingCompanyId: q.shippingCompanyId,
      });
    }

    if (q?.storeId) {
      qb.andWhere("order.storeId = :storeId", {
        storeId: q.storeId,
      });
    }

    // Date range
    DateFilterUtil.applyToQueryBuilder(
      qb,
      "order.created_at",
      q?.startDate,
      q?.endDate,
    );

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

  async exportMyAssignedOrders(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const myUserId = me?.id;
    if (!myUserId) {
      throw new BadRequestException(
        this.translations.t("common.missing_user_id"),
      );
    }

    // 1. نفس منطق بناء الاستعلام (Query Builder)
    const search = String(q?.search ?? "").trim();
    const qb = this.orderRepo
      .createQueryBuilder("order")
      .where("order.adminId = :adminId", { adminId })
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

    // 2. تطبيق نفس الفلاتر
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
    if (q?.type) qb.andWhere("order.type = :type", { type: q.type });
    if (q?.paymentStatus) {
      qb.andWhere("order.paymentStatus = :paymentStatus", {
        paymentStatus: q.paymentStatus,
      });
    }
    if (q?.paymentMethod) {
      qb.andWhere("order.paymentMethod = :paymentMethod", {
        paymentMethod: q.paymentMethod,
      });
    }
    if (q?.shippingCompanyId) {
      qb.andWhere("order.shippingCompanyId = :shippingCompanyId", {
        shippingCompanyId: q.shippingCompanyId,
      });
    }
    if (q?.storeId) {
      qb.andWhere("order.storeId = :storeId", { storeId: q.storeId });
    }

    DateFilterUtil.applyToQueryBuilder(
      qb,
      "order.created_at",
      q?.startDate,
      q?.endDate,
    );

    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("order.orderNumber ILIKE :s", { s: `%${search}%` })
            .orWhere("order.customerName ILIKE :s", { s: `%${search}%` })
            .orWhere("order.phoneNumber ILIKE :s", { s: `%${search}%` });
        }),
      );
    }

    // 3. جلب جميع البيانات بدون Pagination للتصدير
    qb.orderBy("order.created_at", "DESC");
    const orders = await qb.getMany();

    // 4. تحضير البيانات (Prepare Data)
    const notApplicable = this.translations.t("common.not_applicable");
    const exportData = orders.map((order) => {
      return {
        orderNumber: order.orderNumber || notApplicable,
        status: order.status?.name || order.status?.code || notApplicable,
        customerName: order.customerName || notApplicable,
        phoneNumber: order.phoneNumber || notApplicable,
        city: order.city || notApplicable,
        paymentStatus: order.paymentStatus || notApplicable,
        shippingCompany: order.shippingCompany?.name || notApplicable,
        store: order.store?.name || notApplicable,
        finalTotal: order.finalTotal || 0,
        createdAt: order.created_at
          ? new Date(order.created_at).toLocaleString("en-GB")
          : notApplicable,
      };
    });

    // 5. إنشاء ملف الإكسل (Create Workbook)
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      this.translations.t(
        "domains.order_assignment.export_my_assigned_orders_sheet",
      ),
    );

    const columns = [
      {
        header: this.translations.t("common.export_order_number"),
        key: "orderNumber",
        width: 20,
      },
      {
        header: this.translations.t("common.export_status"),
        key: "status",
        width: 15,
      },
      {
        header: this.translations.t(
          "domains.order_assignment.export_customer_name",
        ),
        key: "customerName",
        width: 25,
      },
      {
        header: this.translations.t(
          "domains.order_assignment.export_phone_number",
        ),
        key: "phoneNumber",
        width: 18,
      },
      {
        header: this.translations.t("domains.order_assignment.export_city"),
        key: "city",
        width: 18,
      },
      {
        header: this.translations.t(
          "domains.order_assignment.export_final_total",
        ),
        key: "finalTotal",
        width: 15,
      },
      {
        header: this.translations.t(
          "domains.order_assignment.export_payment_status",
        ),
        key: "paymentStatus",
        width: 18,
      },
      {
        header: this.translations.t("common.export_shipping_company"),
        key: "shippingCompany",
        width: 20,
      },
      {
        header: this.translations.t("domains.order_assignment.export_store"),
        key: "store",
        width: 20,
      },
      {
        header: this.translations.t(
          "domains.order_assignment.export_created_at",
        ),
        key: "createdAt",
        width: 20,
      },
    ];

    worksheet.columns = columns;

    // تنسيق رأس الجدول (Style header row)
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };

    // إضافة البيانات (Add data rows)
    exportData.forEach((row) => {
      worksheet.addRow(row);
    });

    // 6. توليد الـ Buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }

  async getNextAssignedOrder(me: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const order = await this.orderRepo
      .createQueryBuilder("order")
      .innerJoinAndSelect(
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
      .leftJoinAndSelect("items.bundle", "bundle")
      .leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("order.orderTags", "orderTags")
      .leftJoinAndSelect("orderTags.tag", "tag")
      .leftJoinAndSelect("order.statusHistory", "statusHistory")
      .leftJoinAndSelect("statusHistory.fromStatus", "fromStatus")
      .leftJoinAndSelect("statusHistory.toStatus", "toStatus")
      .leftJoinAndSelect("order.status", "status")
      .leftJoinAndSelect("order.shippingCompany", "shippingCompany")
      .leftJoinAndSelect("order.store", "store")
      .leftJoinAndSelect("order.lastInternalNote", "lastInternalNote")
      .leftJoinAndSelect("lastInternalNote.author", "lastInternalNoteAuthor")
      .orderBy("assignment.assignedAt", "ASC") // 🔥 Old → New
      .addOrderBy("order.id", "ASC")
      .getOne();

    if (!order) return null;

    (order as any).myUnreadCount = Number(
      order.internalNotesUnreadCounts?.[me?.id] || 0,
    );

    // Collect upselling product ids
    const upsellingIds = new Set<string>();

    for (const item of order.items || []) {
      if (!item.variant?.product?.upsellingEnabled) continue;
      for (const upsell of item.variant?.product?.upsellingProducts || []) {
        if (upsell.productId) {
          upsellingIds.add(upsell.productId);
        }
      }
    }

    // Fetch lightweight products with SKUs to calculate stock
    const upsellingProducts = upsellingIds.size
      ? await this.productRepo
          .createQueryBuilder("product")
          .leftJoinAndSelect("product.variants", "skus", "skus.isActive = true")
          .select([
            "product.id",
            "product.name",
            "product.sku",
            "product.type",
            "product.mainImage",
            "product.lowestPrice",
            "product.salePrice",
            "skus.id",
            "skus.stockOnHand",
            "skus.reserved",
          ])
          .where("product.id IN (:...ids)", {
            ids: [...upsellingIds],
          })
          .getMany()
      : [];

    const productEntries = await Promise.all(
      upsellingProducts.map(
        async (p): Promise<[string, typeof p & { totalAvailable: number }]> => {
          const totals = (p.variants || []).reduce(
            (acc, sku) => {
              acc.totalStock += sku.stockOnHand || 0;
              acc.totalReserved += sku.reserved || 0;
              return acc;
            },
            { totalStock: 0, totalReserved: 0 },
          );

          const totalAvailable =
            await this.ordersService.calculateAvailableStock(
              totals.totalStock,
              totals.totalReserved,
              adminId,
            );

          return [p.id, { ...p, totalAvailable }];
        },
      ),
    );

    const productMap = new Map(productEntries);

    // Attach product info
    for (const item of order.items || []) {
      (item as any).upsellingProducts =
        item.variant?.product?.upsellingProducts || [];
      (item as any).upsellingProducts = (
        (item as any).upsellingProducts || []
      ).map((upsell) => ({
        ...upsell,
        product: productMap.get(upsell.productId) || null,
      }));
    }

    return order;
  }

  async getFreeOrders(me: any, q: GetFreeOrdersDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

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
    DateFilterUtil.applyToQueryBuilder(
      qb,
      "order.created_at",
      q?.startDate,
      q?.endDate,
    );
    // Date filters

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
    q: { statusIds: string[]; startDate?: string; endDate?: string },
  ) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

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
    DateFilterUtil.applyToQueryBuilder(
      qb,
      "order.created_at",
      q?.startDate,
      q?.endDate,
    );

    const count = await qb.getCount();
    return { count };
  }

  async getAssignmentStats(me: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const now = new Date();

    const [
      activeAssignmentsCount,
      assignedEmployeesResult,
      // activeAssignedTodayCount,
      lockedAssignmentsCount,
    ] = await Promise.all([
      // 1. Active Assignments
      this.orderAssignmentRepo.count({
        where: {
          assignedByAdminId: adminId,
          isAssignmentActive: true,
        },
      }),

      // 2. Assigned Employees
      this.orderAssignmentRepo
        .createQueryBuilder("assignment")
        .select("COUNT(DISTINCT assignment.employeeId)", "count")
        .where("assignment.assignedByAdminId = :adminId", { adminId })
        .andWhere("assignment.isAssignmentActive = true")
        .getRawOne(),

      // 3. Assigned Today
      // this.orderAssignmentRepo
      //     .createQueryBuilder("assignment")
      //     .where("assignment.assignedByAdminId = :adminId", { adminId })
      //     .andWhere("assignment.isAssignmentActive = true")
      //     .andWhere("assignment.assignedAt >= :todayStart", { todayStart })
      //     .andWhere("assignment.assignedAt <= :todayEnd", { todayEnd })
      //     .getCount(),

      // 4. Locked Assignments
      this.orderAssignmentRepo
        .createQueryBuilder("assignment")
        .where("assignment.assignedByAdminId = :adminId", { adminId })
        .andWhere("assignment.isAssignmentActive = true")
        .andWhere("assignment.lockedUntil IS NOT NULL")
        .andWhere("assignment.lockedUntil > :now", { now })
        .getCount(),
    ]);

    return {
      activeAssignmentsCount,
      assignedEmployeesCount: parseInt(
        assignedEmployeesResult?.count ?? "0",
        10,
      ),
      // activeAssignedTodayCount,
      lockedAssignmentsCount,
    };
  }

  // =========================================================================
  // AUTO ASSIGN RULES MANAGEMENT
  // =========================================================================

  async listAutoAssignRules(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? "").trim();

    const qb = this.autoAssignRuleRepo
      .createQueryBuilder("rule")
      .where("rule.adminId = :adminId", { adminId })
      .leftJoinAndSelect("rule.products", "products")
      .leftJoinAndSelect("rule.cities", "cities")
      .leftJoinAndSelect("rule.employees", "employees")
      .leftJoinAndSelect("rule.stores", "stores");

    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("rule.name ILIKE :s", { s: `%${search}%` });
        }),
      );
    }
    DateFilterUtil.applyToQueryBuilder(
      qb,
      "rule.createdAt",
      q?.startDate,
      q?.endDate,
    );

    if (q?.ruleType) {
      qb.andWhere("rule.ruleType = :ruleType", { ruleType: q.ruleType });
    }

    if (q?.strategy) {
      qb.andWhere("rule.strategy = :strategy", { strategy: q.strategy });
    }

    if (q?.isActive !== undefined && q?.isActive !== "") {
      qb.andWhere("rule.isActive = :isActive", {
        isActive: q.isActive === "true",
      });
    }

    qb.orderBy("rule.priority", "ASC").addOrderBy("rule.id", "ASC");

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

  async createAutoAssignRule(me: any, dto: CreateAutoAssignRuleDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const existingRule = await this.autoAssignRuleRepo.findOne({
      where: { name: dto.name, adminId },
    });
    if (existingRule) {
      throw new BadRequestException(
        this.translations.t("domains.order_assignment.rule_name_exists"),
      );
    }

    const rule = this.autoAssignRuleRepo.create({
      ...dto,
      adminId,
    });

    const promises: Promise<any>[] = [];

    if (dto.productIds?.length) {
      promises.push(
        this.productRepo
          .find({ where: { id: In(dto.productIds), isActive: true } })
          .then(async (products) => {
            if (products.length !== dto.productIds.length) {
              throw new BadRequestException(
                this.translations.t(
                  "domains.order_assignment.some_products_not_found",
                ),
              );
            }
            rule.products = products;
          }),
      );
    }
    if (dto.cityIds?.length) {
      promises.push(
        this.cityRepo
          .find({ where: { id: In(dto.cityIds), isActive: true } })
          .then(async (cities) => {
            if (cities.length !== dto.cityIds.length) {
              throw new BadRequestException(
                this.translations.t(
                  "domains.order_assignment.some_cities_not_found",
                ),
              );
            }
            rule.cities = cities;
          }),
      );
    }

    if (dto.storeIds?.length) {
      promises.push(
        this.storeRepo
          .find({ where: { id: In(dto.storeIds), isActive: true } })
          .then(async (stores) => {
            if (stores.length !== dto.storeIds.length) {
              throw new BadRequestException(
                this.translations.t(
                  "domains.order_assignment.some_stores_not_found",
                ),
              );
            }
            rule.stores = stores;
          }),
      );
    }

    if (dto.employeeIds?.length) {
      promises.push(
        this.userRepo
          .find({ where: { id: In(dto.employeeIds), adminId, isActive: true } })
          .then(async (employees) => {
            if (employees.length !== dto.employeeIds.length) {
              throw new BadRequestException(
                this.translations.t(
                  "domains.order_assignment.some_employees_not_found",
                ),
              );
            }
            rule.employees = employees;
          }),
      );
    }

    if (promises.length) await Promise.all(promises);

    const saved = await this.autoAssignRuleRepo.save(rule);
    this.onboardingAchievementService.enqueueAchievement(
      adminId,
      GettingStartedAchievementType.FIRST_ORDER_ASSIGNMENT_AUTOMATION_RULE_CREATED,
    );
    return saved;
  }

  async updateAutoAssignRule(
    me: any,
    id: string,
    dto: UpdateAutoAssignRuleDto,
  ) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const rule = await this.autoAssignRuleRepo.findOne({
      where: { id, adminId },
    });
    if (!rule) {
      throw new NotFoundException(
        this.translations.t("domains.order_assignment.rule_not_found"),
      );
    }

    if (dto.name && dto.name !== rule.name) {
      const existingRule = await this.autoAssignRuleRepo.findOne({
        where: { name: dto.name, adminId },
      });
      if (existingRule) {
        throw new BadRequestException(
          this.translations.t("domains.order_assignment.rule_name_exists"),
        );
      }
    }

    Object.assign(rule, dto);

    const promises: Promise<any>[] = [];

    if (dto.productIds !== undefined) {
      promises.push(
        (dto.productIds.length
          ? this.productRepo.find({
              where: { id: In(dto.productIds), isActive: true },
            })
          : Promise.resolve([])
        ).then(async (products) => {
          if (
            dto.productIds.length &&
            products.length !== dto.productIds.length
          ) {
            throw new BadRequestException(
              this.translations.t(
                "domains.order_assignment.some_products_not_found",
              ),
            );
          }
          rule.products = products;
        }),
      );
    }
    if (dto.cityIds !== undefined) {
      promises.push(
        (dto.cityIds.length
          ? this.cityRepo.find({
              where: { id: In(dto.cityIds), isActive: true },
            })
          : Promise.resolve([])
        ).then(async (cities) => {
          if (dto.cityIds.length && cities.length !== dto.cityIds.length) {
            throw new BadRequestException(
              this.translations.t(
                "domains.order_assignment.some_cities_not_found",
              ),
            );
          }
          rule.cities = cities;
        }),
      );
    }

    if (dto.storeIds !== undefined) {
      promises.push(
        (dto.storeIds.length
          ? this.storeRepo.find({
              where: { id: In(dto.storeIds), isActive: true },
            })
          : Promise.resolve([])
        ).then(async (stores) => {
          if (dto.storeIds.length && stores.length !== dto.storeIds.length) {
            throw new BadRequestException(
              this.translations.t(
                "domains.order_assignment.some_stores_not_found",
              ),
            );
          }
          rule.stores = stores;
        }),
      );
    }

    if (dto.employeeIds !== undefined) {
      promises.push(
        (dto.employeeIds.length
          ? this.userRepo.find({
              where: { id: In(dto.employeeIds), adminId, isActive: true },
            })
          : Promise.resolve([])
        ).then(async (employees) => {
          if (
            dto.employeeIds.length &&
            employees.length !== dto.employeeIds.length
          ) {
            throw new BadRequestException(
              this.translations.t(
                "domains.order_assignment.some_employees_not_found",
              ),
            );
          }
          rule.employees = employees;
        }),
      );
    }

    if (promises.length) await Promise.all(promises);

    return this.autoAssignRuleRepo.save(rule);
  }

  async getAutoAssignRuleDetails(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const rule = await this.autoAssignRuleRepo.findOne({
      where: { id, adminId },
      relations: ["products", "cities", "employees"],
    });

    if (!rule) {
      throw new NotFoundException(
        this.translations.t("domains.order_assignment.rule_not_found"),
      );
    }
    return rule;
  }

  async toggleAutoAssignRuleActive(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const rule = await this.autoAssignRuleRepo.findOne({
      where: { id, adminId },
    });
    if (!rule) {
      throw new NotFoundException(
        this.translations.t("domains.order_assignment.rule_not_found"),
      );
    }

    rule.isActive = !rule.isActive;
    return this.autoAssignRuleRepo.save(rule);
  }

  async deleteAutoAssignRule(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const rule = await this.autoAssignRuleRepo.findOne({
      where: { id, adminId },
    });
    if (!rule) {
      throw new NotFoundException(
        this.translations.t("domains.order_assignment.rule_not_found"),
      );
    }

    await this.autoAssignRuleRepo.remove(rule);
    return { success: true };
  }

  async getAutoAssignRulesStats(me: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const [generalStats, typeStats] = await Promise.all([
      this.autoAssignRuleRepo
        .createQueryBuilder("rule")
        .select("COUNT(rule.id)", "total")
        .addSelect(
          "SUM(CASE WHEN rule.isActive = true THEN 1 ELSE 0 END)",
          "active",
        )
        .where("rule.adminId = :adminId", { adminId })
        .getRawOne(),
      this.autoAssignRuleRepo
        .createQueryBuilder("rule")
        .select("rule.ruleType", "type")
        .addSelect("COUNT(rule.id)", "count")
        .where("rule.adminId = :adminId", { adminId })
        .groupBy("rule.ruleType")
        .getRawMany(),
    ]);

    const byType: Record<string, number> = {};
    typeStats.forEach((ts) => {
      byType[ts.type] = parseInt(ts.count, 10);
    });

    return {
      total: parseInt(generalStats.total || 0, 10),
      active: parseInt(generalStats.active || 0, 10),
      byType,
    };
  }

  async exportAutoAssignRules(me: any, q?: any) {
    const { records } = await this.listAutoAssignRules(me, {
      ...q,
      limit: 10000,
    });
    const adminId = tenantId(me);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      this.translations.t(
        "domains.order_assignment.export_auto_assign_rules_sheet",
      ),
    );

    worksheet.columns = [
      {
        header: this.translations.t("domains.order_assignment.export_name"),
        key: "name",
        width: 25,
      },
      {
        header: this.translations.t("domains.order_assignment.export_type"),
        key: "ruleType",
        width: 20,
      },
      {
        header: this.translations.t("domains.order_assignment.export_status"),
        key: "status",
        width: 15,
      },
      {
        header: this.translations.t("domains.order_assignment.export_priority"),
        key: "priority",
        width: 10,
      },
      {
        header: this.translations.t(
          "domains.order_assignment.export_description",
        ),
        key: "description",
        width: 30,
      },
      {
        header: this.translations.t("domains.order_assignment.export_strategy"),
        key: "strategy",
        width: 15,
      },
      {
        header: this.translations.t(
          "domains.order_assignment.export_min_amount",
        ),
        key: "minAmount",
        width: 15,
      },
      {
        header: this.translations.t(
          "domains.order_assignment.export_max_amount",
        ),
        key: "maxAmount",
        width: 15,
      },
      {
        header: this.translations.t(
          "domains.order_assignment.export_payment_status",
        ),
        key: "paymentStatus",
        width: 15,
      },
      {
        header: this.translations.t(
          "domains.order_assignment.export_target_employees",
        ),
        key: "employees",
        width: 30,
      },
      {
        header: this.translations.t("domains.order_assignment.export_products"),
        key: "products",
        width: 30,
      },
      {
        header: this.translations.t("domains.order_assignment.export_cities"),
        key: "cities",
        width: 30,
      },
      {
        header: this.translations.t("domains.order_assignment.export_stores"),
        key: "stores",
        width: 30,
      },
    ];

    const rows = records.map((rule) => ({
      name: rule.name,
      ruleType: rule.ruleType,
      status: rule.isActive
        ? this.translations.t("domains.order_assignment.status_active")
        : this.translations.t("domains.order_assignment.status_inactive"),
      paymentStatus: rule.paymentStatus,
      minAmount: rule.minAmount,
      maxAmount: rule.maxAmount,
      strategy: rule.strategy,
      priority: rule.priority,
      description: rule.description || "—",
      employees: rule.employees?.map((e) => e.name).join(", ") || "—",
      products: rule.products?.map((e) => e.name).join(", ") || "—",
      cities: rule.cities?.map((e) => e.nameEn).join(", ") || "—",
      stores: rule.stores?.map((e) => e.name).join(", ") || "—",
    }));

    worksheet.addRows(rows);

    // Styling
    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF4F46E5" },
    };
    worksheet.getRow(1).alignment = {
      vertical: "middle",
      horizontal: "center",
    };

    return await workbook.xlsx.writeBuffer();
  }

  async processAutoAssignment(
    adminId: any,
    orderIds: string[],
  ): Promise<{
    success?: boolean;
    message?: string;
    noActiveRules?: boolean;
    assignedCount: number;
    results?: Array<{
      orderId: string;
      orderNumber?: string;
      employeeId?: string;
      ruleName?: string;
    }>;
  }> {
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const result = await this.dataSource.transaction(async (manager) => {
      // 1. Get active rules ordered by priority
      const rules = await manager.find(AutoAssignRuleEntity, {
        where: { adminId, isActive: true },
        relations: ["products", "cities", "employees", "stores"],
        order: { priority: "ASC", createdAt: "ASC" },
      });

      if (!rules.length) {
        return {
          message: this.translations.t(
            "domains.order_assignment.no_active_rules",
          ),
          noActiveRules: true,
          assignedCount: 0,
        };
      }

      // 2. Fetch orders with necessary details
      const orders = await manager.find(OrderEntity, {
        where: { id: In(orderIds), adminId },
        relations: [
          "items",
          "items.variant",
          "items.variant.product",
          "cityDetails",
          "status",
        ],
      });
      this.logger.debug(
        `Fetched ${orders.map((o) => o.orderNumber).join(", ")} orders for auto-assignment.`,
      );
      const settings =
        await this.clientSettingsService.getCachedSettings(adminId);
      if (settings && settings.assignmentMode === AssignmentMode.DISABLED) {
        return {
          message: this.translations.t(
            "domains.order_assignment.auto_assignment_disabled",
          ),
          assignedCount: 0,
        };
      }
      const maxRetries = settings?.maxRetries || 3;

      let assignedCount = 0;
      const results = [];
      const savedAssignments: Array<{ id: string; orderId: string }> = [];

      for (const order of orders) {
        // Check if already assigned
        const existingAssignment = await manager.findOne(
          OrderAssignmentEntity,
          {
            where: { orderId: order.id, isAssignmentActive: true },
          },
        );
        this.logger.debug(
          `Checking assignment for Order: ${order.orderNumber} | Existing Assignment: ${!!existingAssignment}`,
        );
        if (existingAssignment) continue;

        // Check if status allowed
        this.logger.debug(
          `Checking status for Order: ${order.orderNumber} | Status: ${order.status?.code}`,
        );
        if (
          order.status &&
          !this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT.has(
            order.status.code as OrderStatus,
          )
        ) {
          continue;
        }

        // Find matching rule
        const rule = this.findMatchingRule(order, rules);
        if (rule && rule.employees?.length) {
          const employee = await this.selectEmployeeByStrategy(rule);
          if (employee) {
            const saved = await manager.save(
              manager.create(OrderAssignmentEntity, {
                orderId: order.id,
                employeeId: employee.id,
                assignedByAdminId: adminId,
                maxRetriesAtAssignment: maxRetries,
                isAssignmentActive: true,
              }),
            );
            savedAssignments.push({ id: saved.id, orderId: saved.orderId });
            assignedCount++;
            //send notification to admin about thi assignment
            this.logger.debug(
              `Sending notification for Order: ${order.orderNumber} | Employee: ${employee.name}`,
            );
            await this.notificationService.create({
              userId: adminId,
              type: NotificationType.ORDER_ASSIGNED,
              title: await this.requestTranslations.tAsync(
                "domains.order_assignment.order_assigned_title",
                adminId,
              ),
              message: await this.requestTranslations.tAsync(
                "domains.order_assignment.order_assigned_message",
                adminId,
                {
                  args: {
                    orderNumber: order.orderNumber,
                    employeeName: employee.name,
                    ruleName: rule.name,
                  },
                },
              ),
              relatedEntityType: "order",
              relatedEntityId: String(order.id),
            });

            // Update order status if needed
            await this.bulkUpdateOrderStatusOnAssignment(
              [order.id],
              adminId,
              manager,
            );

            results.push({
              orderId: order.id,
              orderNumber: order.orderNumber,
              employeeId: employee.id,
              ruleName: rule.name,
            });
          }
        }
      }

      return { success: true, assignedCount, results, savedAssignments };
    });

    if (
      "savedAssignments" in result &&
      Array.isArray(result.savedAssignments) &&
      result.savedAssignments.length
    ) {
      await this.scheduleAssignmentExpiry(adminId, result.savedAssignments);
    }

    if ("savedAssignments" in result) {
      const { savedAssignments: _saved, ...rest } = result;
      return rest;
    }

    return result;
  }

  async previewAutoAssignment(adminId: string, orders: OrderEntity[]) {
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    // 1. Get active rules ordered by priority
    const rules = await this.autoAssignRuleRepo.find({
      where: { adminId, isActive: true },
      relations: ["products", "cities", "employees", "stores"],
      order: { priority: "ASC", createdAt: "ASC" },
    });

    if (!rules.length) {
      return {
        message: this.translations.t(
          "domains.order_assignment.no_active_rules",
        ),
        noActiveRules: true,
        assignedCount: 0,
      };
    }

    const settings =
      await this.clientSettingsService.getCachedSettings(adminId);
    if (settings && settings.assignmentMode === AssignmentMode.DISABLED) {
      return {
        message: this.translations.t(
          "domains.order_assignment.auto_assignment_disabled",
        ),
        assignedCount: 0,
      };
    }

    let assignedCount = 0;
    const results = [];

    for (const order of orders) {
      // Check if already assigned
      const existingAssignment = await this.orderAssignmentRepo.findOne({
        where: { orderId: order.id, isAssignmentActive: true },
      });
      if (existingAssignment) continue;

      // Check if status allowed
      if (
        order.status &&
        !this.ordersService.ALLOWED_STATUS_CODES_FOR_ASSIGNMENT.has(
          order.status.code as OrderStatus,
        )
      ) {
        continue;
      }

      // Find matching rule
      const rule = this.findMatchingRule(order, rules);
      if (rule && rule.employees?.length) {
        const employee = await this.selectEmployeeByStrategy(rule);
        if (employee) {
          assignedCount++;

          results.push({
            orderId: order.id,
            orderNumber: order.orderNumber,
            employeeId: employee.id,
            ruleName: rule.name,
          });
        }
      }
    }

    return { success: true, assignedCount, results };
  }

  private findMatchingRule(
    order: OrderEntity,
    rules: AutoAssignRuleEntity[],
  ): AutoAssignRuleEntity | null {
    for (const rule of rules) {
      if (this.isRuleMatch(order, rule)) {
        return rule;
      }
    }
    return null;
  }

  private isRuleMatch(order: OrderEntity, rule: AutoAssignRuleEntity): boolean {
    const now = new Date();

    // =========================
    // 1. DATE RANGE CHECK
    // =========================
    if (rule.activeFrom && now < new Date(rule.activeFrom)) return false;
    if (rule.activeUntil && now > new Date(rule.activeUntil)) return false;
    // =========================
    // 2. WEEKDAY CHECK (BITMASK)
    // =========================
    if (rule.weekDays != null) {
      const currentWeekDay = WeekDayHelper.WEEKDAY_BITS[now.getDay() % 7];

      if (!BitmaskHelper.has(rule.weekDays, currentWeekDay)) {
        return false;
      }
    }

    // =========================
    // 3. TIME WINDOW CHECK
    // =========================
    if (rule.startTime || rule.endTime) {
      const timezone = rule.timezone || "Africa/Cairo";
      const now = new Date();

      // Get current hours and minutes in the rule's timezone
      const formatter = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: timezone,
      });
      const parts = formatter.formatToParts(now);
      const currentHours = parseInt(
        parts.find((p) => p.type === "hour")?.value || "0",
        10,
      );
      const currentMinutes = parseInt(
        parts.find((p) => p.type === "minute")?.value || "0",
        10,
      );
      const currentTotalMinutes = currentHours * 60 + currentMinutes;

      // Convert start time to total minutes if set
      if (rule.startTime) {
        const [startHours, startMins] = rule.startTime.split(":").map(Number);
        const startTotalMinutes = startHours * 60 + startMins;
        if (currentTotalMinutes < startTotalMinutes) {
          return false;
        }
      }

      // Convert end time to total minutes if set
      if (rule.endTime) {
        const [endHours, endMins] = rule.endTime.split(":").map(Number);
        const endTotalMinutes = endHours * 60 + endMins;
        if (currentTotalMinutes > endTotalMinutes) {
          return false;
        }
      }
    }

    switch (rule.ruleType) {
      case AutoAssignRuleType.MANUAL:
        return true;
      case AutoAssignRuleType.PRODUCT:
        if (!rule.products?.length) return false;
        const orderProductIds =
          order.items?.map((item) => item.variant?.productId).filter(Boolean) ||
          [];
        const ruleProductIds = rule.products.map((p) => p.id);
        return orderProductIds.some((pid) => ruleProductIds.includes(pid));
      case AutoAssignRuleType.CITY:
        if (!rule.cities?.length) return false;
        const ruleCityIds = rule.cities.map((c) => c.id);
        return ruleCityIds.includes(order.cityId);
      case AutoAssignRuleType.AMOUNT_RANGE:
        const total = Number(order.finalTotal || 0);
        const min =
          rule.minAmount !== null && rule.minAmount !== undefined
            ? Number(rule.minAmount)
            : -Infinity;
        const max =
          rule.maxAmount !== null && rule.maxAmount !== undefined
            ? Number(rule.maxAmount)
            : Infinity;
        return total >= min && total <= max;
      case AutoAssignRuleType.PAYMENT_STATUS:
        return order.paymentStatus === rule.paymentStatus;
      case AutoAssignRuleType.STORE:
        if (!rule.stores?.length) return false;
        const ruleStoreIds = rule.stores.map((s) => s.id);
        return ruleStoreIds.includes(order.storeId);
      default:
        return false;
    }
  }

  private async selectEmployeeByStrategy(
    rule: AutoAssignRuleEntity,
  ): Promise<User | null> {
    const employees = rule.employees;
    if (!employees?.length) return null;

    if (rule.strategy === AssignmentStrategy.ROUND_ROBIN) {
      const sortedEmployees = [...employees].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      let nextIndex = 0;
      if (rule.lastAssignedEmployeeId) {
        const lastIndex = sortedEmployees.findIndex(
          (e) => e.id === rule.lastAssignedEmployeeId,
        );
        if (lastIndex !== -1) {
          nextIndex = (lastIndex + 1) % sortedEmployees.length;
        }
      }
      const selectedEmployee = sortedEmployees[nextIndex];

      // Update lastAssignedEmployeeId in DB
      await this.autoAssignRuleRepo.update(rule.id, {
        lastAssignedEmployeeId: selectedEmployee.id,
      });

      return selectedEmployee;
    } else if (rule.strategy === AssignmentStrategy.LEAST_ACTIVE_ORDERS) {
      const employeeIds = employees.map((e) => e.id);
      const counts = await this.orderAssignmentRepo
        .createQueryBuilder("oa")
        .select("oa.employeeId", "id")
        .addSelect("COUNT(oa.id)", "count")
        .where("oa.employeeId IN (:...employeeIds)", { employeeIds })
        .andWhere("oa.isAssignmentActive = true")
        .groupBy("oa.employeeId")
        .getRawMany();

      const countMap = new Map(
        counts.map((c) => [c.id, parseInt(c.count, 10)]),
      );

      let minCount = Infinity;
      let selectedEmployee = employees[0];

      for (const employee of employees) {
        const count = countMap.get(employee.id) || 0;
        if (count < minCount) {
          minCount = count;
          selectedEmployee = employee;
        }
      }
      return selectedEmployee;
    }
    return null;
  }

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

  private defaultThisMonthBounds() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  async getMyPerformance(me: any, q: any) {
    const adminId = tenantId(me);
    const employeeId = me?.id;
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }
    if (!employeeId) {
      throw new BadRequestException(
        this.translations.t("common.missing_user_id"),
      );
    }

    let { start, end } = DateFilterUtil.getBoundaries(q?.startDate, q?.endDate);
    if (!start && !end) {
      ({ start, end } = this.defaultThisMonthBounds());
    }

    const actionAt = `COALESCE(oa."lastActionAt", oa."assignedAt")`;
    const dayExpr = `to_char(timezone('Africa/Cairo', ${actionAt}), 'YYYY-MM-DD')`;

    const [
      settings,
      statuses,
      countRows,
      previouslyConfirmedRow,
      activeRow,
      contactRow,
      lockedRow,
      lastStatusRows,
      confirmedShipmentRow,
      assignedRow,
      dailyStatusRows,
      dailyTotalRows,
      tagRows,
      causeRows,
    ] = await Promise.all([
      this.clientSettingsService.getCachedSettings(adminId),
      this.statusRepo
        .createQueryBuilder("status")
        .where(
          new Brackets((qb) => {
            qb.where("status.adminId = :adminId", { adminId }).orWhere(
              "status.system = true",
            );
          }),
        )
        .orderBy("status.sortOrder", "ASC")
        .addOrderBy("status.name", "ASC")
        .getMany(),
      this.orderAssignmentRepo
        .createQueryBuilder("oa")
        .innerJoin("oa.order", "o")
        .select("o.statusId", "statusId")
        .addSelect("COUNT(DISTINCT oa.id)", "count")
        .where("oa.employeeId = :employeeId", { employeeId })
        .andWhere("o.adminId = :adminId", { adminId })
        .andWhere(start ? `${actionAt} >= :start` : "1=1", { start })
        .andWhere(end ? `${actionAt} <= :end` : "1=1", { end })
        .groupBy("o.statusId")
        .getRawMany(),
      this.orderAssignmentRepo
        .createQueryBuilder("oa")
        .innerJoin("oa.order", "o")
        .select(
          "COUNT(DISTINCT CASE WHEN o.isConfirmed = true THEN oa.id END)",
          "previouslyConfirmedCount",
        )
        .where("oa.employeeId = :employeeId", { employeeId })
        .andWhere("o.adminId = :adminId", { adminId })
        .andWhere(start ? `${actionAt} >= :start` : "1=1", { start })
        .andWhere(end ? `${actionAt} <= :end` : "1=1", { end })
        .getRawOne(),
      this.orderAssignmentRepo
        .createQueryBuilder("oa")
        .innerJoin("oa.order", "o")
        .select("COUNT(DISTINCT oa.id)", "count")
        .where("oa.employeeId = :employeeId", { employeeId })
        .andWhere("o.adminId = :adminId", { adminId })
        .andWhere("oa.isAssignmentActive = true")
        .andWhere(start ? `${actionAt} >= :start` : "1=1", { start })
        .andWhere(end ? `${actionAt} <= :end` : "1=1", { end })
        .getRawOne(),
      this.orderAssignmentRepo
        .createQueryBuilder("oa")
        .innerJoin("oa.order", "o")
        .select("COALESCE(SUM(oa.contactTries), 0)", "contactTries")
        .where("oa.employeeId = :employeeId", { employeeId })
        .andWhere("o.adminId = :adminId", { adminId })
        .andWhere(start ? `${actionAt} >= :start` : "1=1", { start })
        .andWhere(end ? `${actionAt} <= :end` : "1=1", { end })
        .getRawOne(),
      this.orderAssignmentRepo
        .createQueryBuilder("oa")
        .innerJoin("oa.order", "o")
        .select("COUNT(DISTINCT oa.id)", "count")
        .where("oa.employeeId = :employeeId", { employeeId })
        .andWhere("o.adminId = :adminId", { adminId })
        .andWhere("oa.isAssignmentActive = true")
        .andWhere("oa.lockedUntil IS NOT NULL")
        .andWhere("oa.lockedUntil > :now", { now: new Date() })
        .andWhere(start ? `${actionAt} >= :start` : "1=1", { start })
        .andWhere(end ? `${actionAt} <= :end` : "1=1", { end })
        .getRawOne(),
      this.orderAssignmentRepo
        .createQueryBuilder("oa")
        .innerJoin("oa.order", "o")
        .innerJoin("oa.lastStatus", "ls")
        .select("ls.id", "statusId")
        .addSelect("ls.code", "code")
        .addSelect("COUNT(DISTINCT oa.id)", "count")
        .where("oa.employeeId = :employeeId", { employeeId })
        .andWhere("o.adminId = :adminId", { adminId })
        .andWhere(start ? `${actionAt} >= :start` : "1=1", { start })
        .andWhere(end ? `${actionAt} <= :end` : "1=1", { end })
        .groupBy("ls.id")
        .addGroupBy("ls.code")
        .getRawMany(),
      this.orderAssignmentRepo
        .createQueryBuilder("oa")
        .innerJoin("oa.order", "o")
        .innerJoin("oa.lastStatus", "ls")
        .leftJoin("o.shipments", "ship")
        .select(
          "COUNT(DISTINCT CASE WHEN ship.id IS NULL THEN oa.id END)",
          "withoutShipment",
        )
        .addSelect(
          "COUNT(DISTINCT CASE WHEN ship.id IS NOT NULL THEN oa.id END)",
          "withShipment",
        )
        .where("oa.employeeId = :employeeId", { employeeId })
        .andWhere("o.adminId = :adminId", { adminId })
        .andWhere("ls.code = :confirmedCode", {
          confirmedCode: OrderStatus.CONFIRMED,
        })
        .andWhere(start ? `${actionAt} >= :start` : "1=1", { start })
        .andWhere(end ? `${actionAt} <= :end` : "1=1", { end })
        .getRawOne(),
      this.userRepo
        .createQueryBuilder("user")
        .innerJoin("user.assignments", "oa")
        .innerJoin("oa.order", "o")
        .select("COUNT(DISTINCT oa.id)", "count")
        .where("user.id = :employeeId", { employeeId })
        .andWhere("o.adminId = :adminId", { adminId })
        .andWhere(start ? `${actionAt} >= :start` : "1=1", { start })
        .andWhere(end ? `${actionAt} <= :end` : "1=1", { end })
        .getRawOne(),
      this.orderAssignmentRepo
        .createQueryBuilder("oa")
        .innerJoin("oa.order", "o")
        .select(dayExpr, "date")
        .addSelect("oa.lastStatusId", "statusId")
        .addSelect("COUNT(DISTINCT oa.id)", "count")
        .where("oa.employeeId = :employeeId", { employeeId })
        .andWhere("o.adminId = :adminId", { adminId })
        .andWhere("oa.lastStatusId IS NOT NULL")
        .andWhere(start ? `${actionAt} >= :start` : "1=1", { start })
        .andWhere(end ? `${actionAt} <= :end` : "1=1", { end })
        .groupBy(dayExpr)
        .addGroupBy("oa.lastStatusId")
        .orderBy(dayExpr, "ASC")
        .getRawMany(),
      this.orderAssignmentRepo
        .createQueryBuilder("oa")
        .innerJoin("oa.order", "o")
        .select(dayExpr, "date")
        .addSelect("COUNT(DISTINCT oa.id)", "assigned")
        .addSelect("COALESCE(SUM(oa.contactTries), 0)", "contactTries")
        .where("oa.employeeId = :employeeId", { employeeId })
        .andWhere("o.adminId = :adminId", { adminId })
        .andWhere(start ? `${actionAt} >= :start` : "1=1", { start })
        .andWhere(end ? `${actionAt} <= :end` : "1=1", { end })
        .groupBy(dayExpr)
        .orderBy(dayExpr, "ASC")
        .getRawMany(),
      this.dataSource
        .getRepository(OrderTagEntity)
        .createQueryBuilder("ot")
        .innerJoin("ot.tag", "t")
        .innerJoin(OrderAssignmentEntity, "oa", "oa.orderId = ot.orderId")
        .innerJoin("oa.order", "o")
        .select("t.id", "id")
        .addSelect("t.name", "name")
        .addSelect("t.color", "color")
        .addSelect("COUNT(DISTINCT ot.id)", "count")
        .where("oa.employeeId = :employeeId", { employeeId })
        .andWhere("o.adminId = :adminId", { adminId })
        .andWhere(start ? `${actionAt} >= :start` : "1=1", { start })
        .andWhere(end ? `${actionAt} <= :end` : "1=1", { end })
        .groupBy("t.id")
        .addGroupBy("t.name")
        .addGroupBy("t.color")
        .orderBy("COUNT(DISTINCT ot.id)", "DESC")
        .getRawMany(),
      this.dataSource
        .getRepository(OrderCancelCauseEntity)
        .createQueryBuilder("occ")
        .innerJoin(OrderAssignmentEntity, "oa", "oa.orderId = occ.orderId")
        .innerJoin("oa.order", "o")
        .select("occ.cancelCauseId", "id")
        .addSelect("MAX(occ.causeNameSnapshot)", "name")
        .addSelect("COUNT(DISTINCT occ.id)", "count")
        .where("oa.employeeId = :employeeId", { employeeId })
        .andWhere("o.adminId = :adminId", { adminId })
        .andWhere("occ.submittedByEmployeeId = :employeeId", { employeeId })
        .andWhere(start ? `${actionAt} >= :start` : "1=1", { start })
        .andWhere(end ? `${actionAt} <= :end` : "1=1", { end })
        .groupBy("occ.cancelCauseId")
        .orderBy("COUNT(DISTINCT occ.id)", "DESC")
        .getRawMany(),
    ]);

    const confirmationCodes = (settings?.confirmationStatuses || []).filter(
      Boolean,
    );

    const countByStatusId: Record<string, number> = {};
    for (const row of countRows) {
      if (!row.statusId) continue;
      countByStatusId[String(row.statusId)] = Number(row.count) || 0;
    }

    const assigned = Number(assignedRow?.count) || 0;
    const previouslyConfirmedCount = Number(
      previouslyConfirmedRow?.previouslyConfirmedCount ??
        previouslyConfirmedRow?.previouslyconfirmedcount ??
        0,
    );

    const countsByCode: Record<string, number> = {};
    for (const status of statuses) {
      countsByCode[status.code] = countByStatusId[status.id] || 0;
    }

    const catalog = statuses.map((status) => {
      const percentFrom = this.resolvePercentFrom(
        !!status.system,
        status.percentFrom,
      );
      const count = countByStatusId[status.id] || 0;
      return {
        id: status.id,
        code: status.code,
        name: status.name,
        color: status.color,
        system: !!status.system,
        sortOrder: status.sortOrder,
        percentFrom,
        count,
        percent: this.computeStatusPercent(
          count,
          percentFrom,
          assigned,
          countsByCode,
          previouslyConfirmedCount,
        ),
      };
    });

    const byStatus = catalog.map((s) => ({
      statusId: s.id,
      count: s.count,
      percent: s.percent,
    }));

    const lastStatusCountById: Record<string, number> = {};
    const lastStatusCountByCode: Record<string, number> = {};
    for (const row of lastStatusRows) {
      const count = Number(row.count) || 0;
      if (row.statusId) lastStatusCountById[String(row.statusId)] = count;
      if (row.code) lastStatusCountByCode[String(row.code)] = count;
    }

    const confirmationStatuses = statuses
      .filter((status) => confirmationCodes.includes(status.code))
      .map((status) => {
        const percentFrom = this.resolvePercentFrom(
          !!status.system,
          status.percentFrom,
        );
        const count = lastStatusCountById[status.id] || 0;
        return {
          id: status.id,
          code: status.code,
          name: status.name,
          color: status.color,
          system: !!status.system,
          sortOrder: status.sortOrder,
          percentFrom,
          count,
          percent: this.computeStatusPercent(
            count,
            percentFrom,
            assigned,
            lastStatusCountByCode,
            previouslyConfirmedCount,
          ),
        };
      });

    const statusBreakdown = [...catalog]
      .sort((a, b) => b.count - a.count)
      .map((s) => ({
        statusId: s.id,
        code: s.code,
        name: s.name,
        color: s.color,
        system: s.system,
        count: s.count,
        percent: s.percent,
      }));

    const dailyMap = new Map<
      string,
      { date: string; assigned: number; contactTries: number; byStatus: Record<string, number> }
    >();

    for (const row of dailyTotalRows) {
      const date = String(row.date);
      dailyMap.set(date, {
        date,
        assigned: Number(row.assigned) || 0,
        contactTries: Number(row.contactTries ?? row.contacttries) || 0,
        byStatus: {},
      });
    }
    for (const row of dailyStatusRows) {
      const date = String(row.date);
      if (!dailyMap.has(date)) {
        dailyMap.set(date, {
          date,
          assigned: 0,
          contactTries: 0,
          byStatus: {},
        });
      }
      if (row.statusId) {
        dailyMap.get(date)!.byStatus[String(row.statusId)] =
          Number(row.count) || 0;
      }
    }

    const daily = Array.from(dailyMap.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );

    const tagTotal = tagRows.reduce((s, r) => s + (Number(r.count) || 0), 0);
    const causeTotal = causeRows.reduce(
      (s, r) => s + (Number(r.count) || 0),
      0,
    );

    const contactTries =
      Number(contactRow?.contactTries ?? contactRow?.contacttries) || 0;
    const confirmedCount =
      lastStatusCountByCode[OrderStatus.CONFIRMED] || 0;
    const shippedNow = countsByCode[OrderStatus.SHIPPED] || 0;
    const deliveredCount = countsByCode[OrderStatus.DELIVERED] || 0;
    const returnedCount =
      (countsByCode[OrderStatus.RETURNED] || 0) +
      (countsByCode[OrderStatus.PARTIALLY_RETURNED] || 0);
    const shippedEver = shippedNow + deliveredCount + returnedCount;
    const confirmedWithShipment =
      Number(
        confirmedShipmentRow?.withShipment ??
          confirmedShipmentRow?.withshipment,
      ) || 0;
    const confirmedNotShipped =
      Number(
        confirmedShipmentRow?.withoutShipment ??
          confirmedShipmentRow?.withoutshipment,
      ) || 0;

    return {
      statuses: catalog.map(({ count: _c, percent: _p, ...rest }) => rest),
      confirmationStatuses,
      kpis: {
        assigned,
        activeAssignments: Number(activeRow?.count) || 0,
        lockedAssignments: Number(lockedRow?.count) || 0,
        contactTries,
        confirmRate:
          assigned > 0 ? Math.round((confirmedCount / assigned) * 100) : 0,
        avgContactTries:
          assigned > 0
            ? Math.round((contactTries / assigned) * 10) / 10
            : 0,
        confirmedCount,
        shippedNow,
        delivered: deliveredCount,
        returned: returnedCount,
        shippedEver,
        shippedOfConfirmedPercent:
          confirmedCount > 0
            ? Math.round((confirmedWithShipment / confirmedCount) * 100)
            : 0,
        confirmedNotShipped,
        byStatus,
      },
      daily,
      statusBreakdown,
      tags: tagRows.map((r) => {
        const count = Number(r.count) || 0;
        return {
          id: r.id,
          name: r.name,
          color: r.color,
          count,
          percent: tagTotal > 0 ? Math.round((count / tagTotal) * 100) : 0,
        };
      }),
      cancelCauses: causeRows.map((r) => {
        const count = Number(r.count) || 0;
        return {
          id: r.id,
          name: r.name,
          count,
          percent: causeTotal > 0 ? Math.round((count / causeTotal) * 100) : 0,
        };
      }),
    };
  }
}
