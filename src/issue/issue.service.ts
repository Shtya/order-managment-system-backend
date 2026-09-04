import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, FindOptionsRelations, In, Repository } from "typeorm";
import {
  IssueActivityEntity,
  IssueActivityType,
  IssueCauseEntity,
  IssueEntity,
  IssueMessageEntity,
  IssuePriority,
  IssueStatus,
  IssueStatusEntity,
  IssueUserEntity,
} from "entities/issue.entity";
import { Role, SystemRole, User } from "entities/user.entity";
import { OrderEntity, slugify } from "entities/order.entity";
import { tenantId } from "../category/category.service";
import {
  I18nKey,
  RequestTranslationService,
  TranslationService,
} from "common/translation.service";
import { NotificationType } from "entities/notifications.entity";
import { NotificationService } from "src/notifications/notification.service";
import { DateFilterUtil } from "common/date-filter.util";
import { AppGateway } from "common/app.gateway";
import { CustomerService } from "../customer/customer.service";
import * as ExcelJS from "exceljs";
import { CreateIssueDto, UpdateIssueDto } from "dto/issue.dto";

const TERMINAL_STATUSES = [IssueStatus.SOLVED, IssueStatus.CANCELLED];

const DEFAULT_ISSUE_STATUSES: {
  nameEn: string;
  nameAr: string;
  code: IssueStatus;
  color: string;
  sortOrder: number;
}[] = [
  {
    nameEn: "Open",
    nameAr: "مفتوح",
    code: IssueStatus.OPEN,
    color: "#2E86DE",
    sortOrder: 1,
  },
  {
    nameEn: "In Progress",
    nameAr: "قيد التقدم",
    code: IssueStatus.IN_PROGRESS,
    color: "#F39C12",
    sortOrder: 2,
  },
  {
    nameEn: "Waiting For Employee",
    nameAr: "في انتظار الموظف",
    code: IssueStatus.WAITING_FOR_EMPLOYEE,
    color: "#8E44AD",
    sortOrder: 3,
  },
  {
    nameEn: "Waiting For Customer",
    nameAr: "في انتظار العميل",
    code: IssueStatus.WAITING_FOR_CUSTOMER,
    color: "#16A085",
    sortOrder: 4,
  },
  {
    nameEn: "Waiting For Shipping Company",
    nameAr: "في انتظار شركة الشحن",
    code: IssueStatus.WAITING_FOR_SHIPPING_COMPANY,
    color: "#5D6D7E",
    sortOrder: 5,
  },
  {
    nameEn: "Waiting For Warehouse",
    nameAr: "في انتظار المخزن",
    code: IssueStatus.WAITING_FOR_WAREHOUSE,
    color: "#A93226",
    sortOrder: 6,
  },
  {
    nameEn: "Solved",
    nameAr: "تم الحل",
    code: IssueStatus.SOLVED,
    color: "#27AE60",
    sortOrder: 7,
  },
  {
    nameEn: "Cancelled",
    nameAr: "ملغي",
    code: IssueStatus.CANCELLED,
    color: "#CB4335",
    sortOrder: 8,
  },
];

const DEFAULT_ISSUE_CAUSES: {
  nameEn: string;
  nameAr: string;
  sortOrder: number;
}[] = [
  { nameEn: "Client Not Responding", nameAr: "العميل لا يرد", sortOrder: 1 },
  { nameEn: "Wrong Address", nameAr: "عنوان خاطئ", sortOrder: 2 },
  { nameEn: "Product Damaged", nameAr: "المنتج تالف", sortOrder: 3 },
  { nameEn: "Delay In Delivery", nameAr: "تأخر التوصيل", sortOrder: 4 },
  {
    nameEn: "Customer Refused Order",
    nameAr: "العميل رفض الطلب",
    sortOrder: 5,
  },
  { nameEn: "Payment Issue", nameAr: "مشكلة في الدفع", sortOrder: 6 },
];

@Injectable()
export class IssueService implements OnModuleInit {
  constructor(
    @InjectRepository(IssueEntity)
    private issueRepo: Repository<IssueEntity>,
    @InjectRepository(IssueStatusEntity)
    private statusRepo: Repository<IssueStatusEntity>,
    @InjectRepository(IssueUserEntity)
    private issueUserRepo: Repository<IssueUserEntity>,
    @InjectRepository(IssueMessageEntity)
    private messageRepo: Repository<IssueMessageEntity>,
    @InjectRepository(IssueActivityEntity)
    private activityRepo: Repository<IssueActivityEntity>,
    @InjectRepository(IssueCauseEntity)
    private causeRepo: Repository<IssueCauseEntity>,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Role) private roleRepo: Repository<Role>,
    @InjectRepository(OrderEntity) private orderRepo: Repository<OrderEntity>,
    private customerService: CustomerService,
    private translations: TranslationService,
    private requestTranslations: RequestTranslationService,
    private notificationService: NotificationService,
    private appGateway: AppGateway,
  ) {}

  private t(key: any) {
    return this.translations.t(key);
  }

  async onModuleInit() {
    await this.seedDefaultStatuses();
    await this.seedDefaultCauses();
  }

  private async seedDefaultStatuses() {
    for (const seed of DEFAULT_ISSUE_STATUSES) {
      const exists = await this.statusRepo.findOne({
        where: { code: seed.code, system: true } as any,
      });
      if (!exists) {
        await this.statusRepo.save(
          this.statusRepo.create({
            adminId: null,
            nameEn: seed.nameEn,
            nameAr: seed.nameAr,
            code: seed.code,
            color: seed.color,
            sortOrder: seed.sortOrder,
            system: true,
          }),
        );
      }
    }
  }

  private async seedDefaultCauses() {
    for (const seed of DEFAULT_ISSUE_CAUSES) {
      const exists = await this.causeRepo.findOne({
        where: { nameEn: seed.nameEn, system: true } as any,
      });
      if (!exists) {
        await this.causeRepo.save(
          this.causeRepo.create({
            adminId: null,
            nameEn: seed.nameEn,
            nameAr: seed.nameAr,
            sortOrder: seed.sortOrder,
            system: true,
          }),
        );
      }
    }
  }

  /* ================= Helpers ================= */

  private pageParams(q: any) {
    const page = Number(q?.page) || 1;
    const limit = Number(q?.limit) || 10;
    return { page, limit, skip: (page - 1) * limit };
  }

  private sortClause(
    q: any,
    alias: string,
  ): { column: string; order: "ASC" | "DESC" } {
    const order = q?.sortOrder?.toUpperCase() === "ASC" ? "ASC" : "DESC";
    const map: Record<string, string> = {
      created_at: `${alias}.created_at`,
      updated_at: `${alias}.updated_at`,
      last_message_at: `${alias}.last_message_at`,
      priority: `${alias}.priority`,
      due_at: `${alias}.due_at`,
    };
    const key = q?.sortBy || "created_at";
    return { column: map[key] || `${alias}.created_at`, order };
  }

  private validateEstimate(minutes?: number | null) {
    if (minutes === undefined || minutes === null) return;
    if (!Number.isInteger(minutes) || minutes <= 0) {
      throw new BadRequestException(this.t("domains.issues.invalid_estimate"));
    }
  }

  private async findTenantIssue(
    me: any,
    issueId: string,
    relations: FindOptionsRelations<IssueEntity> = {},
  ) {
    const adminId = tenantId(me);
    // TODO(typeorm-v1): `relations` no longer accepts a string array. This value references a variable whose shape can't be determined statically — if it holds `string[]`, wrap it: `Object.fromEntries(<expr>?.map(r => [r, true]) ?? [])` (dot-paths need extra nesting handling). If it already holds the v1 object shape, no change needed.
    const issue = await this.issueRepo.findOne({
      where: { id: issueId, adminId } as any,
      relations,
    });
    if (!issue) {
      throw new NotFoundException(this.t("domains.issues.not_found"));
    }
    return issue;
  }

  private async requireCanActOnIssue(me: User, issue: IssueEntity) {
    const adminId = tenantId(me);

    if (!adminId || adminId !== issue.adminId) {
      throw new ForbiddenException(this.t("domains.issues.access_denied"));
    }

    if (me.role?.name === SystemRole.ADMIN) return;

    const [isAssignedEmployee, assignmentCount] = await Promise.all([
      this.issueUserRepo.exists({
        where: {
          issueId: issue.id,
          userId: me.id,
        } as any,
      }),
      this.issueUserRepo.count({
        where: {
          issueId: issue.id,
        } as any,
      }),
    ]);

    // No role and no employees assigned:
    // Anyone belonging to the tenant can access.
    if (!issue.assignedRoleId && assignmentCount === 0) {
      return;
    }

    // Employees are explicitly assigned:
    // Only assigned employees can access.
    if (assignmentCount > 0) {
      if (isAssignedEmployee) return;

      throw new ForbiddenException(this.t("domains.issues.access_denied"));
    }

    // A role is assigned but no specific employees:
    // Any member of that role can access.
    if (issue.assignedRoleId && me.roleId === issue.assignedRoleId) {
      return;
    }

    throw new ForbiddenException(this.t("domains.issues.access_denied"));
  }

  private async logActivity(
    issueId: string,
    adminId: string,
    performedByUserId: string,
    type: IssueActivityType,
    metadata?: Record<string, unknown>,
  ) {
    return this.activityRepo.save(
      this.activityRepo.create({
        adminId,
        issueId,
        performedByUserId,
        type,
        metadata: metadata || null,
      }),
    );
  }

  private async requireRole(adminId: string, roleId: string) {
    const role = await this.roleRepo.findOne({ where: { id: roleId } as any });
    if (!role || (!role.isGlobal && role.adminId !== adminId)) {
      throw new BadRequestException(this.t("domains.issues.role_not_found"));
    }
    return role;
  }
  private async replaceIssueUsers(
    adminId: string,
    issueId: string,
    userIds: string[],
    roleId?: string | null,
  ) {
    const uniqueIds = [...new Set(userIds)];
    if (uniqueIds.length) {
      const users = await this.userRepo.find({
        where: { id: In(uniqueIds) } as any,
      });
      const found = new Set(users.map((u) => u.id));
      const invalid = uniqueIds.filter((id) => !found.has(id));
      if (invalid.length) {
        throw new BadRequestException(
          this.t("domains.issues.employee_not_found"),
        );
      }
      const scoped = users.filter(
        (u) => u.id === adminId || u.adminId === adminId,
      );
      if (scoped.length !== users.length) {
        throw new BadRequestException(
          this.t("domains.issues.employee_not_found"),
        );
      }
    }

    // Keep only users belonging to the given role (if any)
    let finalIds = uniqueIds;
    if (roleId) {
      const roleUsers = await this.userRepo.find({
        where: { id: In(uniqueIds), roleId } as any,
        select: { id: true },
      });
      finalIds = roleUsers.map((u) => u.id);
    }

    await this.issueUserRepo.delete({ issueId });
    if (finalIds.length) {
      await this.issueUserRepo.save(
        finalIds.map((userId) =>
          this.issueUserRepo.create({
            adminId,
            issueId,
            userId,
            unreadUserCount: 0,
          }),
        ),
      );
    }
  }

  private async syncAssigneesToRole(issue: IssueEntity, roleId: string | null) {
    const assigned = await this.issueUserRepo.find({
      where: { issueId: issue.id } as any,
      select: { userId: true },
    });
    await this.replaceIssueUsers(
      issue.adminId,
      issue.id,
      assigned.map((r) => r.userId),
      roleId,
    );
  }

  private async issueRecipientIds(issue: IssueEntity): Promise<string[]> {
    const recipients = new Set<string>([issue.adminId]);

    const assignedRows = await this.issueUserRepo.find({
      where: { issueId: issue.id } as any,
      select: { userId: true },
    });

    if (assignedRows.length > 0) {
      assignedRows.forEach((r) => recipients.add(r.userId));
    } else if (issue.assignedRoleId) {
      const roleMembers = await this.userRepo.find({
        where: { roleId: issue.assignedRoleId, adminId: issue.adminId } as any,
        select: { id: true },
      });
      roleMembers.forEach((u) => recipients.add(u.id));
    }

    return [...recipients];
  }

  private async notifyUsers(
    issueId: string,
    recipients: (string | null | undefined)[],
    actorId: string | undefined,
    type: NotificationType,
    titleKey: I18nKey,
    messageKey: I18nKey,
    args?: Record<string, string | number>,
  ) {
    const userIds = [
      ...new Set(
        recipients.filter((id): id is string => !!id && id !== actorId),
      ),
    ];

    if (!userIds.length) return;

    await Promise.all(
      userIds.map(async (userId) => {
        const [title, message] = await Promise.all([
          this.requestTranslations.tAsync(titleKey, userId),
          this.requestTranslations.tAsync(messageKey, userId, { args }),
        ]);

        return this.notificationService.create({
          userId,
          type,
          title,
          message,
          relatedEntityType: "issue",
          relatedEntityId: issueId,
        });
      }),
    );
  }

  private statusLabel(status: IssueStatus): string {
    const map: Record<IssueStatus, string> = {
      [IssueStatus.OPEN]: this.t("domains.issues.status_open"),
      [IssueStatus.IN_PROGRESS]: this.t("domains.issues.status_in_progress"),
      [IssueStatus.WAITING_FOR_EMPLOYEE]: this.t(
        "domains.issues.status_waiting_for_employee",
      ),
      [IssueStatus.WAITING_FOR_CUSTOMER]: this.t(
        "domains.issues.status_waiting_for_customer",
      ),
      [IssueStatus.WAITING_FOR_SHIPPING_COMPANY]: this.t(
        "domains.issues.status_waiting_for_shipping_company",
      ),
      [IssueStatus.WAITING_FOR_WAREHOUSE]: this.t(
        "domains.issues.status_waiting_for_warehouse",
      ),
      [IssueStatus.SOLVED]: this.t("domains.issues.status_solved"),
      [IssueStatus.CANCELLED]: this.t("domains.issues.status_cancelled"),
    };
    return map[status] ?? status;
  }

  private priorityLabel(priority: IssuePriority): string {
    const map: Record<IssuePriority, string> = {
      [IssuePriority.LOW]: this.t("domains.issues.priority_low"),
      [IssuePriority.MEDIUM]: this.t("domains.issues.priority_medium"),
      [IssuePriority.HIGH]: this.t("domains.issues.priority_high"),
      [IssuePriority.URGENT]: this.t("domains.issues.priority_urgent"),
    };
    return map[priority] ?? priority;
  }

  private async defaultStatus(): Promise<IssueStatusEntity> {
    return this.statusRepo.findOne({
      where: { code: IssueStatus.OPEN, system: true } as any,
    });
  }

  /* ================= Issues ================= */

  async create(me: any, dto: CreateIssueDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(this.t("common.missing_admin_id"));
    }

    this.validateEstimate(dto.estimatedMinutes);

    let status: IssueStatusEntity | null = null;
    if (dto.statusId) {
      status = await this.statusRepo.findOne({
        where: { id: dto.statusId } as any,
      });
      if (!status || (status.system !== true && status.adminId !== adminId)) {
        throw new NotFoundException(this.t("domains.issues.status_not_found"));
      }
    } else {
      status = await this.defaultStatus();
    }
    if (!status) {
      throw new BadRequestException(this.t("domains.issues.status_required"));
    }

    if (!dto.assignedRoleId) {
      throw new BadRequestException(
        this.t("domains.issues.assigned_role_required"),
      );
    }
    await this.requireRole(adminId, dto.assignedRoleId);

    const cause = await this.requireCause(adminId, dto.causeId);

    let customerId: string | null = null;
    let customerName: string | null = null;
    let customerPhone: string | null = null;

    if (dto.orderId) {
      const order = await this.orderRepo.findOne({
        where: { id: dto.orderId, adminId } as any,
      });
      if (!order) {
        throw new NotFoundException(this.t("domains.orders.order_not_found"));
      }

      customerName = order.customerName || null;
      customerPhone = order.normalizedPhoneNumber || order.phoneNumber || null;

      if (customerPhone) {
        const customer = await this.customerService.getOrCreateCustomer(me, {
          phoneNumber: customerPhone,
          name: customerName || undefined,
        });
        customerId = customer.id;
      }
    }

    const issue = this.issueRepo.create({
      adminId,
      createdByUserId: me.id,
      title: dto.title,
      description: dto.description || null,
      orderId: dto.orderId || null,
      customerId,
      customerName,
      customerPhone,
      priority: dto.priority || IssuePriority.MEDIUM,
      statusId: status.id,
      causeId: cause ? cause.id : null,
      assignedRoleId: dto.assignedRoleId,
      estimatedMinutes: dto.estimatedMinutes || null,
    });
    if (issue.estimatedMinutes) {
      issue.due_at = new Date(Date.now() + issue.estimatedMinutes * 60_000);
    }

    const saved = await this.issueRepo.save(issue);

    if (dto.employeeIds?.length) {
      await this.replaceIssueUsers(adminId, saved.id, dto.employeeIds);
    }

    await this.logActivity(
      saved.id,
      adminId,
      me.id,
      IssueActivityType.CREATED,
      {
        title: saved.title,
      },
    );

    const recipients = await this.issueRecipientIds(saved);
    await this.notifyUsers(
      saved.id,
      recipients,
      me.id,
      NotificationType.ISSUE_CREATED,
      "domains.issues.issue_created_title",
      "domains.issues.issue_created_message",
      { issueTitle: saved.title },
    );

    this.appGateway.emitIssueCreated([adminId], saved);

    return {
      success: true,
      message: this.t("domains.issues.created_successfully"),
      data: saved,
    };
  }

  async list(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(this.t("common.missing_admin_id"));
    }
    const { page, limit, skip } = this.pageParams(q);
    const { column, order } = this.sortClause(q, "issue");

    const qb = this.issueRepo
      .createQueryBuilder("issue")
      .leftJoinAndSelect("issue.status", "status")
      .leftJoinAndSelect("issue.assignedRole", "assignedRole")
      .leftJoinAndSelect("issue.cause", "cause")
      .leftJoin("issue.order", "order")
      .addSelect(["order.id", "order.orderNumber"])
      .leftJoinAndSelect("issue.lastMessage", "lastMessage")
      .leftJoinAndSelect("issue.lastMessageByUser", "lastMessageByUser")
      .where("issue.adminId = :adminId", { adminId });

    if (me.role?.name !== SystemRole.ADMIN) {
      qb.andWhere(
        new Brackets((b) => {
          // 1. Access by role ONLY IF the issue has NO assigned users
          b.where(
            new Brackets((roleB) => {
              roleB.where("issue.assignedRoleId = :myRoleId", {
                myRoleId: me.roleId,
              });
              roleB.andWhere(
                (subQb) =>
                  `NOT EXISTS (${subQb
                    .subQuery()
                    .select("1")
                    .from(IssueUserEntity, "iu")
                    .where("iu.issueId = issue.id")
                    .getQuery()})`,
              );
            }),
          );
          // 2. OR access if the user is explicitly assigned to the issue
          b.orWhere(
            (subQb) =>
              `issue.id IN ${subQb
                .subQuery()
                .select("issueUser.issueId")
                .from(IssueUserEntity, "issueUser")
                .where("issueUser.userId = :myUserId")
                .getQuery()}`,
          );
        }),
      ).setParameter("myUserId", me.id);
    }

    if (q?.search) {
      qb.andWhere(
        new Brackets((b) => {
          b.where("issue.title ILIKE :search", { search: `%${q.search}%` })
            .orWhere("issue.customerName ILIKE :search")
            .orWhere("issue.customerPhone ILIKE :search");
        }),
      );
    }
    if (q?.statusId) {
      qb.andWhere("issue.statusId = :statusId", { statusId: q.statusId });
    }
    if (q?.causeId) {
      qb.andWhere("issue.causeId = :causeId", { causeId: q.causeId });
    }
    if (q?.priority) {
      qb.andWhere("issue.priority = :priority", { priority: q.priority });
    }
    if (q?.assignedRoleId) {
      qb.andWhere("issue.assignedRoleId = :assignedRoleId", {
        assignedRoleId: q.assignedRoleId,
      });
    }
    if (q?.assignedEmployeeId) {
      qb.andWhere(
        (subQb) =>
          `issue.id IN ${subQb
            .subQuery()
            .select("issueUser.issueId")
            .from(IssueUserEntity, "issueUser")
            .where("issueUser.userId = :assignedEmployeeId")
            .getQuery()}`,
      ).setParameter("assignedEmployeeId", q.assignedEmployeeId);
    }
    if (q?.isDelayed === true || q?.isDelayed === "true") {
      qb.andWhere("issue.due_at IS NOT NULL").andWhere(
        new Brackets((b) => {
          // Not resolved yet and the due date has passed
          b.where("issue.resolved_at IS NULL AND issue.due_at < NOW()")
            // Resolved, but after the due date
            .orWhere("issue.resolved_at > issue.due_at");
        }),
      );
    }
    DateFilterUtil.applyToQueryBuilder(
      qb,
      "issue.created_at",
      q?.startDate,
      q?.endDate,
    );

    const [records, total] = await qb
      .orderBy(column, order)
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  private encodeIssueCursor(issue: IssueEntity): string {
    return Buffer.from(
      JSON.stringify({
        created_at: issue.created_at.toISOString(),
        id: issue.id,
      }),
    ).toString("base64url");
  }

  private decodeIssueCursor(cursor: string): {
    created_at: string;
    id: string;
  } {
    try {
      const decoded = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      );

      if (!decoded?.created_at || !decoded?.id) {
        throw new Error("Invalid cursor");
      }

      return decoded;
    } catch {
      throw new BadRequestException(this.t("common.invalid_cursor"));
    }
  }

  private async getBoardStatuses(
    me: any,
    q?: any,
  ): Promise<IssueStatusEntity[]> {
    const adminId = tenantId(me);
    const superAdmin = me.role?.name === SystemRole.SUPER_ADMIN;

    const qb = this.statusRepo
      .createQueryBuilder("status")
      .where(
        new Brackets((qb) => {
          if (superAdmin && !q?.adminId) {
            qb.where("status.system = :system", {
              system: true,
            });
          } else {
            qb.where("status.adminId = :adminId", {
              adminId,
            }).orWhere("status.system = :system", {
              system: true,
            });
          }
        }),
      )
      .orderBy("status.sortOrder", "ASC");

    return qb.getMany();
  }

  private async getBoardColumn(
    me: any,
    status: IssueStatusEntity,
    q: any,
    cursor: string | null,
    limit: number,
  ) {
    const adminId = tenantId(me);

    const qb = this.issueRepo
      .createQueryBuilder("issue")
      .leftJoinAndSelect("issue.status", "status")
      .leftJoinAndSelect("issue.assignedRole", "assignedRole")
      .leftJoinAndSelect("issue.cause", "cause")
      .leftJoin("issue.order", "order")
      .addSelect(["order.id", "order.orderNumber"])
      .leftJoinAndSelect("issue.lastMessage", "lastMessage")
      .leftJoinAndSelect("issue.lastMessageByUser", "lastMessageByUser")
      .where("issue.adminId = :adminId", {
        adminId,
      })
      .andWhere("issue.statusId = :statusId", {
        statusId: status.id,
      });

    /*
     * ---------------------------------------------------------
     * ACCESS CONTROL
     * ---------------------------------------------------------
     */

    if (me.role?.name !== SystemRole.ADMIN) {
      qb.andWhere(
        new Brackets((b) => {
          // Access through role only when no users are assigned.
          b.where(
            new Brackets((roleB) => {
              roleB
                .where("issue.assignedRoleId = :myRoleId", {
                  myRoleId: me.roleId,
                })
                .andWhere(
                  (subQb) =>
                    `NOT EXISTS (${subQb
                      .subQuery()
                      .select("1")
                      .from(IssueUserEntity, "iu")
                      .where("iu.issueId = issue.id")
                      .getQuery()})`,
                );
            }),
          );

          // Explicitly assigned user.
          b.orWhere(
            (subQb) =>
              `EXISTS (${subQb
                .subQuery()
                .select("1")
                .from(IssueUserEntity, "issueUser")
                .where("issueUser.issueId = issue.id")
                .andWhere("issueUser.userId = :myUserId")
                .getQuery()})`,
          );
        }),
      ).setParameter("myUserId", me.id);
    }

    /*
     * ---------------------------------------------------------
     * FILTERS
     * ---------------------------------------------------------
     */

    if (q?.search) {
      qb.andWhere(
        new Brackets((b) => {
          b.where("issue.title ILIKE :search", {
            search: `%${q.search}%`,
          })
            .orWhere("issue.customerName ILIKE :search")
            .orWhere("issue.customerPhone ILIKE :search");
        }),
      );
    }

    if (q?.causeId) {
      qb.andWhere("issue.causeId = :causeId", {
        causeId: q.causeId,
      });
    }

    if (q?.priority) {
      qb.andWhere("issue.priority = :priority", {
        priority: q.priority,
      });
    }

    if (q?.assignedRoleId) {
      qb.andWhere("issue.assignedRoleId = :assignedRoleId", {
        assignedRoleId: q.assignedRoleId,
      });
    }

    if (q?.assignedEmployeeId) {
      qb.andWhere(
        (subQb) =>
          `EXISTS (${subQb
            .subQuery()
            .select("1")
            .from(IssueUserEntity, "issueUser")
            .where("issueUser.issueId = issue.id")
            .andWhere("issueUser.userId = :assignedEmployeeId")
            .getQuery()})`,
      ).setParameter("assignedEmployeeId", q.assignedEmployeeId);
    }

    if (q?.isDelayed === true || q?.isDelayed === "true") {
      qb.andWhere("issue.due_at IS NOT NULL").andWhere(
        new Brackets((b) => {
          b.where("issue.resolved_at IS NULL AND issue.due_at < NOW()").orWhere(
            "issue.resolved_at > issue.due_at",
          );
        }),
      );
    }

    DateFilterUtil.applyToQueryBuilder(
      qb,
      "issue.created_at",
      q?.startDate,
      q?.endDate,
    );

    /*
     * ---------------------------------------------------------
     * CURSOR
     *
     * Sort:
     *   created_at DESC
     *   id DESC
     *
     * Cursor contains:
     *   {
     *     createdAt: "...",
     *     id: "..."
     *   }
     * ---------------------------------------------------------
     */

    if (cursor) {
      const decodedCursor = this.decodeIssueCursor(cursor);

      qb.andWhere(
        new Brackets((b) => {
          b.where("issue.created_at < :cursorCreatedAt", {
            cursorCreatedAt: decodedCursor.created_at,
          }).orWhere(
            new Brackets((b2) => {
              b2.where("issue.created_at = :cursorCreatedAt", {
                cursorCreatedAt: decodedCursor.created_at,
              }).andWhere("issue.id < :cursorId", {
                cursorId: decodedCursor.id,
              });
            }),
          );
        }),
      );
    }

    /*
     * ---------------------------------------------------------
     * PAGINATION
     * ---------------------------------------------------------
     *
     * Get one extra record.
     * If we receive limit + 1, another page exists.
     */

    qb.orderBy("issue.created_at", "DESC")
      .addOrderBy("issue.id", "DESC")
      .take(limit + 1);

    const rows = await qb.getMany();

    const hasNextPage = rows.length > limit;

    const records = rows.slice(0, limit);

    const nextCursor =
      hasNextPage && records.length > 0
        ? this.encodeIssueCursor(records[records.length - 1])
        : null;

    return {
      status: {
        id: status.id,
        code: status.code,
        color: status.color,
        description: status.description,
        sortOrder: status.sortOrder,
        created_at: status.created_at,
        nameEn: status.nameEn,
        nameAr: status.nameAr,
      },

      records,

      pagination: {
        hasNextPage,
        nextCursor,
      },
    };
  }

  async board(me: any, q?: any) {
    const adminId = tenantId(me);

    if (!adminId) {
      throw new BadRequestException(this.t("common.missing_admin_id"));
    }

    const limit = Math.min(Math.max(Number(q?.limit) || 20, 1), 100);

    const statuses = await this.getBoardStatuses(me, q);

    const cursors = q?.cursors ?? {};

    const columns = await Promise.all(
      statuses.map((status) =>
        this.getBoardColumn(me, status, q, cursors[status.id] ?? null, limit),
      ),
    );

    return {
      columns,
    };
  }

  async boardColumn(me: any, statusId: string, q?: any) {
    const adminId = tenantId(me);

    if (!adminId) {
      throw new BadRequestException(this.t("common.missing_admin_id"));
    }

    const limit = Math.min(Math.max(Number(q?.limit) || 20, 1), 100);

    const statuses = await this.getBoardStatuses(me, q);

    const status = statuses.find((item) => item.id === statusId);

    if (!status) {
      throw new NotFoundException(this.t("domains.issues.status_not_found"));
    }

    return this.getBoardColumn(me, status, q, q?.cursor ?? null, limit);
  }

  async exportIssues(me: any, q?: any) {
    const data = await this.list(me, { ...q, page: 1, limit: 100000 });
    const records = data.records;

    const exportData = records.map((issue) => ({
      // id: issue.id,
      title: issue.title,
      status: issue.status?.nameEn ?? issue.status?.code ?? "",
      cause: issue.cause?.nameEn ?? "",
      priority: issue.priority,
      orderNumber: issue.order?.orderNumber ?? "",
      customerName: issue.customerName ?? "",
      customerPhone: issue.customerPhone ?? "",
      assignedRole: issue.assignedRole?.name ?? "",
      estimatedMinutes: issue.estimatedMinutes ?? "",
      due_at: issue.due_at ?? "",
      lastMessageAt: issue.last_message_at ?? "",
      resolved_at: issue.resolved_at ?? "",
      created_at: issue.created_at,
      updated_at: issue.updated_at,
    }));

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      this.t("domains.issues.excel_worksheet_title"),
    );

    worksheet.columns = [
      // { header: this.t("domains.issues.excel_header_issue_id"), key: "id", width: 38 },
      {
        header: this.t("domains.issues.excel_header_title"),
        key: "title",
        width: 40,
      },
      {
        header: this.t("domains.issues.excel_header_status"),
        key: "status",
        width: 22,
      },
      {
        header: this.t("domains.issues.excel_header_cause"),
        key: "cause",
        width: 22,
      },
      {
        header: this.t("domains.issues.excel_header_priority"),
        key: "priority",
        width: 16,
      },
      {
        header: this.t("domains.issues.excel_header_order_number"),
        key: "orderNumber",
        width: 22,
      },
      {
        header: this.t("domains.issues.excel_header_customer_name"),
        key: "customerName",
        width: 22,
      },
      {
        header: this.t("domains.issues.excel_header_customer_phone"),
        key: "customerPhone",
        width: 18,
      },
      {
        header: this.t("domains.issues.excel_header_assigned_role"),
        key: "assignedRole",
        width: 22,
      },
      {
        header: this.t("domains.issues.excel_header_estimated_minutes"),
        key: "estimatedMinutes",
        width: 18,
      },
      {
        header: this.t("domains.issues.excel_header_due_at"),
        key: "due_at",
        width: 22,
      },
      {
        header: this.t("domains.issues.excel_header_last_message_at"),
        key: "lastMessageAt",
        width: 22,
      },
      {
        header: this.t("domains.issues.excel_header_resolved_at"),
        key: "resolved_at",
        width: 22,
      },
      {
        header: this.t("domains.issues.excel_header_created_at"),
        key: "created_at",
        width: 22,
      },
      {
        header: this.t("domains.issues.excel_header_updated_at"),
        key: "updated_at",
        width: 22,
      },
    ];

    worksheet.getRow(1).font = {
      bold: true,
      color: { argb: "FFFFFFFF" },
    };

    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF6C5CE7" },
    };

    exportData.forEach((row) => worksheet.addRow(row));

    return await workbook.xlsx.writeBuffer();
  }

  async getStats(me: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(this.t("common.missing_admin_id"));
    }

    const [statusRows, newToday, delayed, total] = await Promise.all([
      this.issueRepo
        .createQueryBuilder("issue")
        .select("issue.statusId", "statusId")
        .addSelect("COUNT(*)::int", "count")
        .where("issue.adminId = :adminId", { adminId })
        .groupBy("issue.statusId")
        .getRawMany(),

      this.issueRepo
        .createQueryBuilder("issue")
        .where("issue.adminId = :adminId", { adminId })
        .andWhere("issue.created_at >= CURRENT_DATE")
        .getCount(),

      this.issueRepo
        .createQueryBuilder("issue")
        .leftJoin("issue.status", "status")
        .where("issue.adminId = :adminId", { adminId })
        .andWhere("issue.due_at IS NOT NULL")
        .andWhere(
          new Brackets((qb) => {
            qb.where(
              "issue.resolved_at IS NULL AND issue.due_at < NOW()",
            ).orWhere(
              "issue.resolved_at IS NOT NULL AND issue.resolved_at > issue.due_at",
            );
          }),
        )
        .andWhere("status.code NOT IN (:...terminalStatuses)", {
          terminalStatuses: TERMINAL_STATUSES,
        })
        .getCount(),

      this.issueRepo
        .createQueryBuilder("issue")
        .where("issue.adminId = :adminId", { adminId })
        .getCount(),
    ]);

    const byStatus: Record<string, number> = {};
    statusRows.forEach((row) => {
      byStatus[row.statusId] = parseInt(row.count, 10);
    });

    return {
      total,
      newToday,
      delayed,
      byStatus,
    };
  }

  async get(me: any, issueId: string) {
    const issue = this.findTenantIssue(me, issueId, {
      status: true,
      cause: true,
      assignedRole: true,
      customer: true,
      order: true,
      createdByUser: true,
      lastMessage: true,
      lastMessageByUser: true,
      users: {
        user: true,
      },
    });

    return issue;
  }

  async update(me: any, issueId: string, dto: UpdateIssueDto) {
    const issue = await this.findTenantIssue(me, issueId);
    await this.requireCanActOnIssue(me, issue);

    const oldEstimate = issue.estimatedMinutes;
    const oldDueAt = issue.due_at;
    const activities: Promise<any>[] = [];

    if (dto.title !== undefined) issue.title = dto.title;
    if (dto.description !== undefined) issue.description = dto.description;
    if (dto.priority !== undefined) issue.priority = dto.priority;
    if (dto.causeId !== undefined) {
      const cause = await this.requireCause(issue.adminId, dto.causeId);
      issue.causeId = cause ? cause.id : null;
    }
    if (dto.assignedRoleId !== undefined) {
      const newRoleId: string | null = dto.assignedRoleId
        ? String(dto.assignedRoleId)
        : null;
      if (newRoleId) {
        await this.requireRole(issue.adminId, newRoleId);
      }

      const roleChanged = issue.assignedRoleId !== newRoleId;
      issue.assignedRoleId = newRoleId;

      const empIds =
        dto.employeeIds !== undefined
          ? dto.employeeIds
          : dto.assignedEmployeeIds;
      if (roleChanged && empIds === undefined) {
        await this.syncAssigneesToRole(issue, newRoleId);
      }
    }

    if (dto.estimatedMinutes !== undefined) {
      this.validateEstimate(dto.estimatedMinutes);
      issue.estimatedMinutes = dto.estimatedMinutes || null;

      issue.due_at = issue.estimatedMinutes
        ? new Date(issue.created_at.getTime() + issue.estimatedMinutes * 60_000)
        : null;

      if (oldEstimate !== issue.estimatedMinutes) {
        activities.push(
          this.logActivity(
            issue.id,
            issue.adminId,
            me.id,
            IssueActivityType.TIME_ESTIMATE_CHANGED,
            { oldEstimate, newEstimate: issue.estimatedMinutes },
          ),
        );
      }
    }

    const saved = await this.issueRepo.save(issue);

    const empIds =
      dto.employeeIds !== undefined ? dto.employeeIds : dto.assignedEmployeeIds;
    if (empIds !== undefined) {
      await this.replaceIssueUsers(
        issue.adminId,
        issue.id,
        empIds || [],
        issue.assignedRoleId || undefined,
      );
    }

    await Promise.all(activities);

    this.appGateway.emitIssueUpdated(
      await this.issueRecipientIds(saved),
      saved,
    );

    return {
      success: true,
      message: this.t("domains.issues.updated_successfully"),
      data: saved,
    };
  }

  async remove(me: any, issueId: string) {
    const issue = await this.findTenantIssue(me, issueId);
    await this.issueRepo.softDelete(issue.id);
    return {
      success: true,
      message: this.t("domains.issues.deleted_successfully"),
    };
  }

  /* ================= Messages ================= */

  async getMessages(me: any, issueId: string, q?: any) {
    const issue = await this.findTenantIssue(me, issueId);

    const limit = Number(q?.limit ?? 50);
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
    const cursor = q?.cursor;

    const qb = this.messageRepo
      .createQueryBuilder("message")
      .leftJoinAndSelect("message.sender", "sender")
      .where("message.issueId = :issueId", { issueId: issue.id })
      .andWhere("message.adminId = :adminId", { adminId: issue.adminId })
      .andWhere("message.isDeleted = false");

    DateFilterUtil.applyToQueryBuilder(
      qb,
      "message.created_at",
      q?.startDate,
      q?.endDate,
    );

    if (cursor) {
      const operator = sortDir === "DESC" ? "<" : ">";
      qb.andWhere(
        `(message.created_at, message.id) ${operator} (:cursorValue, :cursorId)`,
        {
          cursorValue: cursor.value,
          cursorId: cursor.id,
        },
      );
    }

    qb.orderBy("message.created_at", sortDir);
    qb.addOrderBy("message.id", sortDir);

    const rows = await qb.take(limit + 1).getMany();
    const hasMore = rows.length > limit;
    const records = hasMore ? rows.slice(0, limit) : rows;
    const last = records[records.length - 1];

    return {
      records,
      hasMore,
      limit,
      nextCursor: hasMore ? { value: last.created_at, id: last.id } : undefined,
      sortBy: "created_at",
      sortDir,
    };
  }

  async reply(me: any, issueId: string, dto: any) {
    const issue = await this.findTenantIssue(me, issueId);
    await this.requireCanActOnIssue(me, issue);

    if (!dto.message) {
      throw new BadRequestException(
        this.t("domains.issues.message_or_content_required"),
      );
    }

    const message = this.messageRepo.create({
      adminId: issue.adminId,
      issueId: issue.id,
      senderId: me.id,
      message: dto.message,
    });
    const saved = await this.messageRepo.save(message);

    const enriched =
      (await this.messageRepo.findOne({
        where: { id: saved.id } as any,
        relations: {
          sender: true
        },
      })) ?? saved;

    issue.last_message_at = new Date();
    issue.lastMessageByUserId = me.id;
    issue.lastMessageId = saved.id;
    await this.issueRepo.save(issue);

    await this.issueUserRepo
      .createQueryBuilder()
      .update(IssueUserEntity)
      .set({ unreadUserCount: () => "unreadUserCount + 1" })
      .where("issueId = :issueId", { issueId: issue.id })
      .andWhere("userId != :userId", { userId: me.id })
      .execute();

    const recipients = await this.issueRecipientIds(issue);
    await this.notifyUsers(
      issue.id,
      recipients,
      me.id,
      NotificationType.ISSUE_NEW_MESSAGE,
      "domains.issues.issue_new_message_title",
      "domains.issues.issue_new_message_message",
      { issueTitle: issue.title },
    );
    this.appGateway.emitIssueMessageCreated(recipients, enriched);
    this.appGateway.emitIssueUpdated(recipients, issue);

    return {
      success: true,
      message: this.t("domains.issues.message_sent_successfully"),
      data: enriched,
    };
  }

  async updateMessage(me: any, issueId: string, messageId: string, dto: any) {
    const issue = await this.findTenantIssue(me, issueId);

    const message = await this.messageRepo.findOne({
      where: {
        id: messageId,
        issueId: issue.id,
        adminId: issue.adminId,
        senderId: me.id,
      } as any,
    });
    if (!message) {
      throw new NotFoundException(this.t("domains.issues.message_not_found"));
    }
    if (message.isDeleted) {
      throw new BadRequestException(
        this.t("domains.support_tickets.cannot_edit_deleted_message"),
      );
    }

    message.message = dto.message;
    message.isEdited = true;
    message.edited_at = new Date();
    const saved = await this.messageRepo.save(message);

    const recipients = await this.issueRecipientIds(issue);
    this.appGateway.emitIssueMessageUpdated(recipients, saved);

    await this.notifyUsers(
      issue.id,
      recipients,
      me.id,
      NotificationType.ISSUE_MESSAGE_UPDATED,
      "domains.issues.issue_message_updated_title",
      "domains.issues.issue_message_updated_message",
      { issueTitle: issue.title },
    );

    return {
      success: true,
      message: this.t("domains.issues.message_updated_successfully"),
      data: saved,
    };
  }

  async deleteMessage(me: any, issueId: string, messageId: string) {
    const issue = await this.findTenantIssue(me, issueId);

    const message = await this.messageRepo.findOne({
      where: {
        id: messageId,
        issueId: issue.id,
        adminId: issue.adminId,
        senderId: me.id,
      } as any,
    });
    if (!message) {
      throw new NotFoundException(this.t("domains.issues.message_not_found"));
    }

    message.isDeleted = true;
    message.deleted_at = new Date();
    message.message = null;
    await this.messageRepo.save(message);

    const recipients = await this.issueRecipientIds(issue);
    await this.notifyUsers(
      issue.id,
      recipients,
      me.id,
      NotificationType.ISSUE_MESSAGE_DELETED,
      "domains.issues.issue_message_deleted_title",
      "domains.issues.issue_message_deleted_message",
      { issueTitle: issue.title },
    );

    return {
      success: true,
      message: this.t("domains.issues.message_deleted_successfully"),
    };
  }

  async markRead(me: any, issueId: string) {
    const issue = await this.findTenantIssue(me, issueId);

    const existing = await this.issueUserRepo.findOne({
      where: { issueId: issue.id, userId: me.id } as any,
    });
    if (existing) {
      existing.last_read_at = new Date();
      existing.unreadUserCount = 0;
      await this.issueUserRepo.save(existing);
    }

    this.appGateway.emitIssueRead(
      await this.issueRecipientIds(issue),
      issue,
      me.id,
    );

    return {
      success: true,
      message: this.t("domains.issues.issue_marked_read"),
    };
  }

  /* ================= State changes ================= */

  async changeStatus(me: any, issueId: string, dto: any) {
    const issue = await this.findTenantIssue(me, issueId);
    await this.requireCanActOnIssue(me, issue);

    const status = await this.statusRepo.findOne({
      where: { id: dto.statusId } as any,
    });
    if (
      !status ||
      (status.system !== true && status.adminId !== issue.adminId)
    ) {
      throw new NotFoundException(this.t("domains.issues.status_not_found"));
    }

    const oldStatusId = issue.statusId;
    issue.statusId = status.id;
    issue.status = status;
    if (status.code === IssueStatus.SOLVED) {
      issue.resolved_at = new Date();
      issue.resolvedByUserId = me.id;
    } else if (
      status.code !== IssueStatus.CANCELLED &&
      (issue.resolved_at || issue.resolvedByUserId)
    ) {
      issue.resolved_at = null;
      issue.resolvedByUserId = null;
    }

    const saved = await this.issueRepo.save(issue);

    await this.logActivity(
      issue.id,
      issue.adminId,
      me.id,
      IssueActivityType.STATUS_CHANGED,
      { oldStatusId, newStatusId: status.id, reason: dto.reason || null },
    );

    const recipients = await this.issueRecipientIds(saved);
    await this.notifyUsers(
      saved.id,
      recipients,
      me.id,
      NotificationType.ISSUE_STATUS_CHANGED,
      "domains.issues.issue_status_changed_title",
      "domains.issues.issue_status_changed_message",
      {
        issueTitle: saved.title,
        status: this.statusLabel(status.code as IssueStatus),
      },
    );

    this.appGateway.emitIssueUpdated(recipients, saved);

    return {
      success: true,
      message: this.t("domains.issues.status_changed_successfully"),
      data: saved,
    };
  }

  async changePriority(me: any, issueId: string, dto: any) {
    const issue = await this.findTenantIssue(me, issueId);
    await this.requireCanActOnIssue(me, issue);

    const oldPriority = issue.priority;
    issue.priority = dto.priority;
    const saved = await this.issueRepo.save(issue);

    await this.logActivity(
      issue.id,
      issue.adminId,
      me.id,
      IssueActivityType.PRIORITY_CHANGED,
      { oldPriority, newPriority: dto.priority },
    );

    const recipients = await this.issueRecipientIds(saved);
    await this.notifyUsers(
      saved.id,
      recipients,
      me.id,
      NotificationType.ISSUE_PRIORITY_CHANGED,
      "domains.issues.issue_priority_changed_title",
      "domains.issues.issue_priority_changed_message",
      {
        issueTitle: saved.title,
        priority: this.priorityLabel(saved.priority),
      },
    );

    this.appGateway.emitIssueUpdated(recipients, saved);

    return {
      success: true,
      message: this.t("domains.issues.priority_changed_successfully"),
      data: saved,
    };
  }

  async assign(me: any, issueId: string, dto: any) {
    const issue = await this.findTenantIssue(me, issueId);
    await this.requireCanActOnIssue(me, issue);

    if (dto.assignedRoleId !== undefined) {
      const newRoleId: string | null = dto.assignedRoleId
        ? String(dto.assignedRoleId)
        : null;
      if (newRoleId) {
        await this.requireRole(issue.adminId, newRoleId);
      }

      const roleChanged = issue.assignedRoleId !== newRoleId;
      issue.assignedRoleId = newRoleId;

      const empIds =
        dto.employeeIds !== undefined
          ? dto.employeeIds
          : dto.assignedEmployeeIds;
      if (roleChanged && empIds === undefined) {
        await this.syncAssigneesToRole(issue, newRoleId);
      }
    }
    const saved = await this.issueRepo.save(issue);

    const empIds =
      dto.employeeIds !== undefined ? dto.employeeIds : dto.assignedEmployeeIds;
    if (empIds !== undefined) {
      await this.replaceIssueUsers(
        issue.adminId,
        issue.id,
        empIds || [],
        issue.assignedRoleId || undefined,
      );
    }

    await this.logActivity(
      issue.id,
      issue.adminId,
      me.id,
      IssueActivityType.ASSIGNED,
      {
        assignedRoleId: issue.assignedRoleId,
        employeeIds: dto.employeeIds || null,
      },
    );

    const recipients = await this.issueRecipientIds(saved);
    await this.notifyUsers(
      saved.id,
      recipients,
      me.id,
      NotificationType.ISSUE_ASSIGNED,
      "domains.issues.issue_assigned_title",
      "domains.issues.issue_assigned_message",
      { issueTitle: saved.title },
    );

    this.appGateway.emitIssueUpdated(recipients, saved);

    return {
      success: true,
      message: this.t("domains.issues.assigned_successfully"),
      data: saved,
    };
  }

  async getActivity(me: any, issueId: string) {
    const issue = await this.findTenantIssue(me, issueId);

    return this.activityRepo.find({
      where: { issueId: issue.id } as any,
      relations: {
        performedByUser: true
      },
      order: { created_at: "DESC" } as any,
    });
  }

  /* ================= Statuses ================= */

  async getStatuses(me: any, q?: any) {
    const adminId = tenantId(me);

    const qb = this.statusRepo
      .createQueryBuilder("status")
      .leftJoin(IssueEntity, "issue", "issue.statusId = status.id")
      .select("status.id", "id")
      .addSelect("status.nameEn", "nameEn")
      .addSelect("status.nameAr", "nameAr")
      .addSelect("status.code", "code")
      .addSelect("status.description", "description")
      .addSelect("status.system", "system")
      .addSelect("status.sortOrder", "sortOrder")
      .addSelect("status.color", "color")
      .addSelect("COUNT(issue.id)::int", "issueCount")
      .where(
        new Brackets((b) => {
          b.where("status.system = true");
          if (adminId) b.orWhere("status.adminId = :adminId", { adminId });
        }),
      )
      .groupBy("status.id")
      .orderBy("status.sortOrder", "ASC");

    if (q?.search) {
      qb.andWhere(
        new Brackets((b) => {
          b.where("status.nameEn ILIKE :search", {
            search: `%${q.search}%`,
          }).orWhere("status.nameAr ILIKE :search");
        }),
      );
    }

    const rows = await qb.getRawMany();

    return rows.map((r) => ({
      id: r.id,
      nameEn: r.nameEn,
      nameAr: r.nameAr,
      code: r.code,
      description: r.description,
      system: r.system,
      sortOrder: Number(r.sortOrder),
      color: r.color,
      issueCount: parseInt(r.issueCount, 10),
    }));
  }

  async createStatus(me: any, dto: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(this.t("common.missing_admin_id"));
    }

    const nameEn = dto.nameEn?.trim();
    const nameAr = dto.nameAr?.trim();
    if (!nameEn) {
      throw new BadRequestException(
        this.t("domains.issues.status_name_required"),
      );
    }

    const code = slugify(nameEn).slice(0, 50);

    await this.assertStatusNameAvailable(adminId, null, nameEn, nameAr);
    await this.assertStatusCodeAvailable(adminId, null, code);

    const status = this.statusRepo.create({
      adminId,
      nameEn,
      nameAr,
      code,
      description: dto.description?.trim(),
      color: dto.color?.trim() || "#6C5CE7",
      sortOrder: dto.sortOrder ?? 0,
      system: false,
    });
    const saved = await this.statusRepo.save(status);

    return {
      success: true,
      message: this.t("domains.issues.status_created_successfully"),
      data: saved,
    };
  }

  async updateStatus(me: any, id: string, dto: any) {
    const adminId = tenantId(me);
    const status = await this.statusRepo.findOne({
      where: { id, adminId } as any,
    });
    if (!status) {
      throw new NotFoundException(this.t("domains.issues.status_not_found"));
    }
    if (status.system) {
      throw new ForbiddenException(
        this.t("domains.issues.cannot_edit_system_statuses"),
      );
    }

    const nameEn = dto.nameEn?.trim() ?? status.nameEn;
    const nameAr = dto.nameAr?.trim() ?? status.nameAr;
    const code = slugify(nameEn).slice(0, 50);

    if (nameEn !== status.nameEn || nameAr !== status.nameAr) {
      await this.assertStatusNameAvailable(adminId, id, nameEn, nameAr);
    }
    if (code !== status.code) {
      await this.assertStatusCodeAvailable(adminId, id, code);
    }

    Object.assign(status, {
      nameEn,
      nameAr,
      code,
      description:
        dto.description !== undefined
          ? dto.description?.trim()
          : status.description,
      color: dto.color?.trim() ?? status.color,
      sortOrder: dto.sortOrder ?? status.sortOrder,
    });
    const saved = await this.statusRepo.save(status);

    return {
      success: true,
      message: this.t("domains.issues.status_updated_successfully"),
      data: saved,
    };
  }

  private async assertStatusNameAvailable(
    adminId: string,
    excludeId: string | null,
    nameEn: string,
    nameAr?: string,
  ) {
    const buildQuery = (name: string) => {
      const qb = this.statusRepo
        .createQueryBuilder("status")
        .where(
          new Brackets((b) => {
            b.where("status.adminId = :adminId", { adminId }).orWhere(
              "status.system = true",
            );
          }),
        )
        .andWhere(
          new Brackets((b) => {
            b.where("status.nameEn = :name", { name }).orWhere(
              "status.nameAr = :name",
              { name },
            );
          }),
        );

      if (excludeId) {
        qb.andWhere("status.id != :id", { id: excludeId });
      }

      return qb;
    };

    const queries = [buildQuery(nameEn)];

    if (nameAr) {
      queries.push(buildQuery(nameAr));
    }

    const results = await Promise.all(queries.map((qb) => qb.getOne()));

    if (results.some(Boolean)) {
      throw new BadRequestException(
        this.t("domains.issues.status_name_exists"),
      );
    }
  }

  private async assertStatusCodeAvailable(
    adminId: string,
    excludeId: string | null,
    code: string,
  ) {
    const qb = this.statusRepo
      .createQueryBuilder("status")
      .where(
        new Brackets((b) => {
          b.where("status.adminId = :adminId", { adminId }).orWhere(
            "status.system = true",
          );
        }),
      )
      .andWhere("status.code = :code", { code });
    if (excludeId) {
      qb.andWhere("status.id != :id", { id: excludeId });
    }
    if (await qb.getOne()) {
      throw new BadRequestException(
        this.t("domains.issues.status_code_exists"),
      );
    }
  }

  async removeStatus(me: any, id: string) {
    const adminId = tenantId(me);
    const status = await this.statusRepo.findOne({
      where: { id, adminId } as any,
    });
    if (!status) {
      throw new NotFoundException(this.t("domains.issues.status_not_found"));
    }
    if (status.system) {
      throw new ForbiddenException(
        this.t("domains.issues.cannot_delete_system_statuses"),
      );
    }

    const inUse = await this.issueRepo.count({
      where: { statusId: id } as any,
    });
    if (inUse > 0) {
      throw new BadRequestException(this.t("domains.issues.status_in_use"));
    }

    await this.statusRepo.remove(status);

    return {
      success: true,
      message: this.t("domains.issues.status_deleted_successfully"),
    };
  }

  /* ================= Causes ================= */

  async getCauses(me: any, q?: any) {
    const adminId = tenantId(me);

    const rows = await this.causeListQuery(adminId, q?.search).getRawMany();

    return rows.map((r) => ({
      id: r.id,
      nameEn: r.nameEn,
      nameAr: r.nameAr,
      system: r.system,
      sortOrder: Number(r.sortOrder),
      issueCount: parseInt(r.issueCount, 10),
    }));
  }

  async listCauses(me: any, q?: any) {
    const adminId = tenantId(me);
    const { page, limit, skip } = this.pageParams(q);

    const countQb = this.causeRepo
      .createQueryBuilder("cause")
      .where(this.causeScope(adminId));

    if (q?.search) {
      countQb.andWhere(this.causeSearch(q.search));
    }

    const [total, rows] = await Promise.all([
      countQb.getCount(),
      this.causeListQuery(adminId, q?.search)
        .skip(skip)
        .take(limit)
        .getRawMany(),
    ]);

    const records = rows.map((r) => ({
      id: r.id,
      nameEn: r.nameEn,
      nameAr: r.nameAr,
      system: r.system,
      sortOrder: Number(r.sortOrder),
      created_at: r.created_at,
      updated_at: r.updated_at,
      issueCount: parseInt(r.issueCount, 10),
    }));

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  async exportCauses(me: any, q?: any) {
    const data = await this.listCauses(me, { ...q, page: 1, limit: 100000 });
    const records = data.records;

    const exportData = records.map((cause) => ({
      nameEn: cause.nameEn,
      nameAr: cause.nameAr,
      type: cause.system
        ? this.t("domains.issues.excel_cause_type_system")
        : this.t("domains.issues.excel_cause_type_custom"),
      sortOrder: cause.sortOrder,
      issueCount: cause.issueCount,
    }));

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      this.t("domains.issues.excel_causes_worksheet_title"),
    );

    worksheet.columns = [
      {
        header: this.t("domains.issues.excel_header_cause_name_en"),
        key: "nameEn",
        width: 30,
      },
      {
        header: this.t("domains.issues.excel_header_cause_name_ar"),
        key: "nameAr",
        width: 30,
      },
      {
        header: this.t("domains.issues.excel_header_cause_type"),
        key: "type",
        width: 14,
      },
      {
        header: this.t("domains.issues.excel_header_cause_sort_order"),
        key: "sortOrder",
        width: 12,
      },
      {
        header: this.t("domains.issues.excel_header_cause_issue_count"),
        key: "issueCount",
        width: 14,
      },
    ];

    worksheet.getRow(1).font = {
      bold: true,
      color: { argb: "FFFFFFFF" },
    };

    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF6C5CE7" },
    };

    exportData.forEach((row) => worksheet.addRow(row));

    return await workbook.xlsx.writeBuffer();
  }

  async getCausesStats(me: any) {
    const adminId = tenantId(me);

    const buildMostQuery = (timeFilter?: string) => {
      const qb = this.causeRepo
        .createQueryBuilder("cause")
        .leftJoin(IssueEntity, "issue", "issue.causeId = cause.id")
        .select("cause.id", "id")
        .addSelect("cause.nameEn", "nameEn")
        .addSelect("cause.nameAr", "nameAr")
        .addSelect("COUNT(issue.id)::int", "issueCount")
        .where(this.causeScope(adminId))
        .groupBy("cause.id")
        .orderBy("COUNT(issue.id)", "DESC")
        .addOrderBy("cause.sortOrder", "ASC")
        .having("COUNT(issue.id) > 0")
        .take(1);

      if (timeFilter) {
        qb.andWhere(timeFilter);
      }

      return qb;
    };

    const [
      totalCauses,
      systemCauses,
      customCauses,
      mostIssuedCause,
      mostIssuedLast7Days,
    ] = await Promise.all([
      this.causeRepo
        .createQueryBuilder("cause")
        .where(this.causeScope(adminId))
        .getCount(),
      this.causeRepo
        .createQueryBuilder("cause")
        .where("cause.system = true")
        .getCount(),
      this.causeRepo
        .createQueryBuilder("cause")
        .where("cause.system = false AND cause.adminId = :adminId", {
          adminId,
        })
        .getCount(),
      buildMostQuery(),
      buildMostQuery("issue.created_at >= CURRENT_DATE - INTERVAL '7 days'"),
    ]);

    const toCard = (r: any) =>
      r
        ? {
            id: r.id,
            nameEn: r.nameEn,
            nameAr: r.nameAr,
            issueCount: parseInt(r.issueCount, 10),
          }
        : null;

    return {
      totalCauses,
      systemCauses,
      customCauses,
      mostIssuedCause: toCard(mostIssuedCause),
      mostIssuedLast7Days: toCard(mostIssuedLast7Days),
    };
  }

  private causeScope(adminId?: string) {
    return new Brackets((b) => {
      b.where("cause.system = true");
      if (adminId) b.orWhere("cause.adminId = :adminId", { adminId });
    });
  }

  private causeSearch(search?: string) {
    return new Brackets((b) => {
      b.where("cause.nameEn ILIKE :search", { search: `%${search}%` }).orWhere(
        "cause.nameAr ILIKE :search",
      );
    });
  }

  private causeListQuery(adminId?: string, search?: string) {
    const qb = this.causeRepo
      .createQueryBuilder("cause")
      .leftJoin(IssueEntity, "issue", "issue.causeId = cause.id")
      .select("cause.id", "id")
      .addSelect("cause.nameEn", "nameEn")
      .addSelect("cause.nameAr", "nameAr")
      .addSelect("cause.system", "system")
      .addSelect("cause.sortOrder", "sortOrder")
      .addSelect("COUNT(issue.id)::int", "issueCount")
      .where(this.causeScope(adminId))
      .groupBy("cause.id")
      .orderBy("cause.sortOrder", "ASC");

    if (search) {
      qb.andWhere(this.causeSearch(search));
    }

    return qb;
  }

  async createCause(me: any, dto: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(this.t("common.missing_admin_id"));
    }

    const nameEn = dto.nameEn?.trim();
    const nameAr = dto.nameAr?.trim();
    if (!nameEn) {
      throw new BadRequestException(
        this.t("domains.issues.cause_name_required"),
      );
    }

    await this.assertCauseNameAvailable(adminId, null, nameEn, nameAr);

    const cause = this.causeRepo.create({
      adminId,
      nameEn,
      nameAr,
      sortOrder: dto.sortOrder ?? 0,
      system: false,
    });
    const saved = await this.causeRepo.save(cause);

    return {
      success: true,
      message: this.t("domains.issues.cause_created_successfully"),
      data: saved,
    };
  }

  async updateCause(me: any, id: string, dto: any) {
    const adminId = tenantId(me);
    const cause = await this.causeRepo.findOne({
      where: { id, adminId } as any,
    });
    if (!cause) {
      throw new NotFoundException(this.t("domains.issues.cause_not_found"));
    }
    if (cause.system) {
      throw new ForbiddenException(
        this.t("domains.issues.cannot_edit_system_causes"),
      );
    }

    const nameEn = dto.nameEn?.trim() ?? cause.nameEn;
    const nameAr = dto.nameAr?.trim() ?? cause.nameAr;

    if (nameEn !== cause.nameEn || nameAr !== cause.nameAr) {
      await this.assertCauseNameAvailable(adminId, id, nameEn, nameAr);
    }

    Object.assign(cause, {
      nameEn,
      nameAr,
      sortOrder: dto.sortOrder ?? cause.sortOrder,
    });
    const saved = await this.causeRepo.save(cause);

    return {
      success: true,
      message: this.t("domains.issues.cause_updated_successfully"),
      data: saved,
    };
  }

  async removeCause(me: any, id: string) {
    const adminId = tenantId(me);
    const cause = await this.causeRepo.findOne({
      where: { id, adminId } as any,
    });
    if (!cause) {
      throw new NotFoundException(this.t("domains.issues.cause_not_found"));
    }
    if (cause.system) {
      throw new ForbiddenException(
        this.t("domains.issues.cannot_delete_system_causes"),
      );
    }

    const inUse = await this.issueRepo.count({ where: { causeId: id } as any });
    if (inUse > 0) {
      throw new BadRequestException(this.t("domains.issues.cause_in_use"));
    }

    await this.causeRepo.remove(cause);

    return {
      success: true,
      message: this.t("domains.issues.cause_deleted_successfully"),
    };
  }

  private async assertCauseNameAvailable(
    adminId: string,
    excludeId: string | null,
    nameEn: string,
    nameAr?: string,
  ) {
    const buildQuery = (name: string) => {
      const qb = this.causeRepo
        .createQueryBuilder("cause")
        .where(
          new Brackets((b) => {
            b.where("cause.adminId = :adminId", { adminId }).orWhere(
              "cause.system = true",
            );
          }),
        )
        .andWhere(
          new Brackets((b) => {
            b.where("cause.nameEn = :name", { name }).orWhere(
              "cause.nameAr = :name",
              { name },
            );
          }),
        );

      if (excludeId) {
        qb.andWhere("cause.id != :id", { id: excludeId });
      }

      return qb;
    };

    const queries = [buildQuery(nameEn)];

    if (nameAr) {
      queries.push(buildQuery(nameAr));
    }

    const results = await Promise.all(queries.map((qb) => qb.getOne()));

    if (results.some(Boolean)) {
      throw new BadRequestException(this.t("domains.issues.cause_name_exists"));
    }
  }

  private async requireCause(adminId: string, causeId?: string | null) {
    if (!causeId) return null;
    const cause = await this.causeRepo.findOne({
      where: { id: causeId } as any,
    });
    if (!cause || (cause.system !== true && cause.adminId !== adminId)) {
      throw new BadRequestException(this.t("domains.issues.cause_not_found"));
    }
    return cause;
  }
}
