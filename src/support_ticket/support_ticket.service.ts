import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, In, Repository, SelectQueryBuilder } from "typeorm";
import {
  SupportTicketActivityEntity,
  SupportTicketActivityType,
  SupportTicketAttachmentEntity,
  SupportTicketAttachmentType,
  SupportTicketEntity,
  SupportTicketMessageEntity,
  SupportTicketPriority,
  SupportTicketStatus,
} from "entities/support_tickets.entity";
import { Role, SystemRole, User } from "entities/user.entity";
import { tenantId } from "../category/category.service";
import {
  I18nKey,
  RequestTranslationService,
  TranslationService,
} from "common/translation.service";
import { DateFilterUtil } from "common/date-filter.util";
import * as ExcelJS from "exceljs";
import { NotificationType } from "entities/notifications.entity";
import { NotificationService } from "src/notifications/notification.service";
import { AppGateway } from "common/app.gateway";

export const SUPPORT_TICKET_STATUS_TRANSITIONS: Record<
  SupportTicketStatus,
  SupportTicketStatus[]
> = {
  [SupportTicketStatus.OPEN]: [
    SupportTicketStatus.IN_PROGRESS,
    SupportTicketStatus.WAITING_ON_CUSTOMER,
    SupportTicketStatus.ON_HOLD,
    SupportTicketStatus.RESOLVED,
    SupportTicketStatus.CANCELED,
  ],
  [SupportTicketStatus.IN_PROGRESS]: [
    SupportTicketStatus.WAITING_ON_CUSTOMER,
    SupportTicketStatus.ON_HOLD,
    SupportTicketStatus.RESOLVED,
    SupportTicketStatus.CLOSED,
    SupportTicketStatus.CANCELED,
  ],
  [SupportTicketStatus.WAITING_ON_CUSTOMER]: [
    SupportTicketStatus.IN_PROGRESS,
    SupportTicketStatus.ON_HOLD,
    SupportTicketStatus.RESOLVED,
    SupportTicketStatus.CLOSED,
    SupportTicketStatus.CANCELED,
  ],
  [SupportTicketStatus.ON_HOLD]: [
    SupportTicketStatus.IN_PROGRESS,
    SupportTicketStatus.WAITING_ON_CUSTOMER,
    SupportTicketStatus.RESOLVED,
    SupportTicketStatus.CLOSED,
    SupportTicketStatus.CANCELED,
  ],
  [SupportTicketStatus.RESOLVED]: [
    SupportTicketStatus.CLOSED,
  ],
  [SupportTicketStatus.CLOSED]: [SupportTicketStatus.REOPENED],
  [SupportTicketStatus.REOPENED]: [
    SupportTicketStatus.IN_PROGRESS,
    SupportTicketStatus.WAITING_ON_CUSTOMER,
    SupportTicketStatus.ON_HOLD,
    SupportTicketStatus.RESOLVED,
    SupportTicketStatus.CLOSED,
  ],
  [SupportTicketStatus.CANCELED]: [SupportTicketStatus.REOPENED],
};

const OPEN_ASSIGNED_STATUSES = [
  SupportTicketStatus.OPEN,
  SupportTicketStatus.IN_PROGRESS,
  SupportTicketStatus.WAITING_ON_CUSTOMER,
  SupportTicketStatus.ON_HOLD,
  SupportTicketStatus.REOPENED,
];

function detectAttachmentType(mimeType: string): SupportTicketAttachmentType {
  if (mimeType.startsWith("image/")) return SupportTicketAttachmentType.IMAGE;
  if (mimeType.startsWith("video/")) return SupportTicketAttachmentType.VIDEO;
  return SupportTicketAttachmentType.DOCUMENT;
}

@Injectable()
export class SupportTicketService {
  constructor(
    @InjectRepository(SupportTicketEntity)
    private ticketRepo: Repository<SupportTicketEntity>,
    @InjectRepository(SupportTicketMessageEntity)
    private messageRepo: Repository<SupportTicketMessageEntity>,
    @InjectRepository(SupportTicketAttachmentEntity)
    private attachmentRepo: Repository<SupportTicketAttachmentEntity>,
    @InjectRepository(SupportTicketActivityEntity)
    private activityRepo: Repository<SupportTicketActivityEntity>,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Role) private roleRepo: Repository<Role>,
    private translations: TranslationService,
    private requestTranslations: RequestTranslationService,
    private notificationService: NotificationService,
    private appGateway: AppGateway,
  ) {}

  private t(key: any) {
    return this.translations.t(key);
  }

  private isSuperAdmin(me: any): boolean {
    return me?.role?.name === SystemRole.SUPER_ADMIN;
  }

  private requireSuperAdmin(me: any) {
    if (!this.isSuperAdmin(me)) {
      throw new ForbiddenException(
        this.t("domains.support_tickets.super_admin_only"),
      );
    }
  }

  private requireCanActOnTicket(me: any, ticket: SupportTicketEntity) {
    if (this.isSuperAdmin(me)) return;
    if (ticket.assignedSupportUserId !== me.id) {
      throw new ForbiddenException(
        this.t("domains.support_tickets.access_denied"),
      );
    }
  }

  private async autoAssigneeUserId(): Promise<string | null> {
    const supportRole = await this.roleRepo.findOne({
      where: { name: "support" },
    });

    if (supportRole) {
      const supportCount = await this.userRepo.count({
        where: { roleId: supportRole.id, isActive: true } as any,
      });
      if (supportCount > 0) return null;
    }

    const superAdminRole = await this.roleRepo.findOne({
      where: { name: SystemRole.SUPER_ADMIN },
    });
    if (!superAdminRole) return null;

    const superAdmin = await this.userRepo
      .createQueryBuilder("u")
      .where("u.roleId = :roleId", { roleId: superAdminRole.id })
      .andWhere("u.isActive = :isActive", { isActive: true })
      .orderBy("u.createdAt", "ASC")
      .getOne();

    return superAdmin?.id || null;
  }

  private async superAdminUserIds(): Promise<string[]> {
    const role = await this.roleRepo.findOne({
      where: { name: SystemRole.SUPER_ADMIN },
    });
    if (!role) return [];
    const users = await this.userRepo.find({
      where: { roleId: role.id, isActive: true } as any,
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  private async supportRecipientIds(
    ticket: SupportTicketEntity,
  ): Promise<string[]> {
    return [
      ...(ticket.assignedSupportUserId ? [ticket.assignedSupportUserId] : []),
      ...(await this.superAdminUserIds()),
    ];
  }

  private tenantRecipientIds(ticket: SupportTicketEntity): string[] {
    return [ticket.adminId, ticket.createdByUserId];
  }

  private async notifyUsers(
    ticketId: string,
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
          relatedEntityType: "support_ticket",
          relatedEntityId: ticketId,
        });
      }),
    );
  }

  private uniqueUserIds(recipients: (string | null | undefined)[]): string[] {
    return [...new Set(recipients.filter((id): id is string => !!id))];
  }

  private notificationForStatus(status: SupportTicketStatus): {
    type: NotificationType;
    titleKey: I18nKey;
    messageKey: I18nKey;
  } {
    switch (status) {
      case SupportTicketStatus.REOPENED:
        return {
          type: NotificationType.SUPPORT_TICKET_REOPENED,
          titleKey: "domains.support_tickets.ticket_reopened_title",
          messageKey: "domains.support_tickets.ticket_reopened_message",
        };
      case SupportTicketStatus.RESOLVED:
        return {
          type: NotificationType.SUPPORT_TICKET_RESOLVED,
          titleKey: "domains.support_tickets.ticket_resolved_title",
          messageKey: "domains.support_tickets.ticket_resolved_message",
        };
      case SupportTicketStatus.CLOSED:
        return {
          type: NotificationType.SUPPORT_TICKET_CLOSED,
          titleKey: "domains.support_tickets.ticket_closed_title",
          messageKey: "domains.support_tickets.ticket_closed_message",
        };
      case SupportTicketStatus.CANCELED:
        return {
          type: NotificationType.SUPPORT_TICKET_CANCELED,
          titleKey: "domains.support_tickets.ticket_canceled_title",
          messageKey: "domains.support_tickets.ticket_canceled_message",
        };
      default:
        return {
          type: NotificationType.SUPPORT_TICKET_STATUS_CHANGED,
          titleKey: "domains.support_tickets.ticket_status_changed_title",
          messageKey: "domains.support_tickets.ticket_status_changed_message",
        };
    }
  }

  private statusLabel(status: SupportTicketStatus): string {
    const map: Record<SupportTicketStatus, string> = {
      [SupportTicketStatus.OPEN]: this.t("domains.support_tickets.status_open"),
      [SupportTicketStatus.IN_PROGRESS]: this.t(
        "domains.support_tickets.status_in_progress",
      ),
      [SupportTicketStatus.WAITING_ON_CUSTOMER]: this.t(
        "domains.support_tickets.status_waiting_on_customer",
      ),
      [SupportTicketStatus.ON_HOLD]: this.t(
        "domains.support_tickets.status_on_hold",
      ),
      [SupportTicketStatus.RESOLVED]: this.t(
        "domains.support_tickets.status_resolved",
      ),
      [SupportTicketStatus.CLOSED]: this.t(
        "domains.support_tickets.status_closed",
      ),
      [SupportTicketStatus.REOPENED]: this.t(
        "domains.support_tickets.status_reopened",
      ),
      [SupportTicketStatus.CANCELED]: this.t(
        "domains.support_tickets.status_canceled",
      ),
    };
    return map[status] ?? status;
  }

  private priorityLabel(priority: SupportTicketPriority): string {
    const map: Record<SupportTicketPriority, string> = {
      [SupportTicketPriority.LOW]: this.t(
        "domains.support_tickets.priority_low",
      ),
      [SupportTicketPriority.MEDIUM]: this.t(
        "domains.support_tickets.priority_medium",
      ),
      [SupportTicketPriority.HIGH]: this.t(
        "domains.support_tickets.priority_high",
      ),
      [SupportTicketPriority.URGENT]: this.t(
        "domains.support_tickets.priority_urgent",
      ),
    };
    return map[priority] ?? priority;
  }

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
      lastMessageAt: `${alias}.lastMessageAt`,
      priority: `${alias}.priority`,
    };
    const key = q?.sortBy || "created_at";
    return { column: map[key] || `${alias}.created_at`, order };
  }

  /* ================= Tenant helpers ================= */

  private async findTenantTicket(
    me: any,
    ticketId: string,
    relations: string[] = [],
  ) {
    const adminId = tenantId(me);
    const ticket = await this.ticketRepo.findOne({
      where: { id: ticketId, adminId } as any,
      relations,
    });
    if (!ticket) {
      throw new NotFoundException(this.t("domains.support_tickets.not_found"));
    }
    return ticket;
  }

  private async requireTicket(ticketId: string, relations: string[] = []) {
    const ticket = await this.ticketRepo.findOne({
      where: { id: ticketId } as any,
      relations,
    });
    if (!ticket) {
      throw new NotFoundException(this.t("domains.support_tickets.not_found"));
    }
    return ticket;
  }

  private async logActivity(
    ticketId: string,
    adminId: string,
    performedByUserId: string,
    type: SupportTicketActivityType,
    metadata?: Record<string, unknown>,
    isPublic = true,
  ) {
    return this.activityRepo.save(
      this.activityRepo.create({
        adminId,
        ticketId,
        performedByUserId,
        type,
        metadata: metadata || null,
        isPublic,
      }),
    );
  }

  private async saveAttachments(opts: {
    adminId: string;
    uploadedByUserId: string;
    ticketId: string;
    messageId: string;
    files: any[];
  }) {
    const { adminId, uploadedByUserId, ticketId, messageId, files } = opts;
    if (!files || files.length === 0) return [];

    const attachments = files.map((f: any) =>
      this.attachmentRepo.create({
        adminId,
        ticketId,
        messageId,
        uploadedByUserId,
        type: detectAttachmentType(f.mimetype),
        originalName: f.originalname,
        url: `/uploads/support-tickets/${f.filename}`,
        mimeType: f.mimetype,
        size: String(f.size),
        thumbnailUrl: null,
      }),
    );

    const saved = await this.attachmentRepo.save(attachments);

    // for (const a of saved) {
    //   await this.logActivity(
    //     ticketId,
    //     adminId,
    //     uploadedByUserId,
    //     SupportTicketActivityType.ATTACHMENT_ADDED,
    //     { attachmentId: a.id, originalName: a.originalName },
    //   );
    // }

    return saved;
  }

  /* ================= Tenant: create ================= */

  async create(me: any, dto: any, files: any[]) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(this.t("common.missing_admin_id"));
    }

    const assignedSupportUserId = await this.autoAssigneeUserId();

    const ticket = this.ticketRepo.create({
      adminId,
      createdByUserId: me.id,
      assignedSupportUserId,
      title: dto.title,
      status: SupportTicketStatus.OPEN,
      priority: SupportTicketPriority.MEDIUM,
      unreadUserCount: 0,
      unreadSupportCount: 1,
      lastMessageAt: new Date(),
      lastMessageByUserId: me.id,
    });
    const savedTicket = await this.ticketRepo.save(ticket);

    const message = this.messageRepo.create({
      adminId,
      ticketId: savedTicket.id,
      senderId: me.id,
      message: dto.message,
      isInitialMessage: true,
      isSupportMessage: false,
      attachmentCount: files?.length || 0,
    });
    const savedMessage = await this.messageRepo.save(message);

    savedTicket.lastMessageId = savedMessage.id;
    await this.ticketRepo.save(savedTicket);

    if (files?.length) {
      await this.saveAttachments({
        adminId,
        uploadedByUserId: me.id,
        ticketId: savedTicket.id,
        messageId: savedMessage.id,
        files,
      });
    }

    const activities = [
      this.logActivity(
        savedTicket.id,
        adminId,
        me.id,
        SupportTicketActivityType.CREATED,
        { title: savedTicket.title },
      ),
    ];

    if (assignedSupportUserId) {
      activities.push(
        this.logActivity(
          savedTicket.id,
          adminId,
          me.id,
          SupportTicketActivityType.ASSIGNED,
          { assignedSupportUserId, auto: true },
        ),
      );
    }

    await Promise.all(activities);

    const supportRecipients = await this.supportRecipientIds(savedTicket);

    await this.notifyUsers(
      savedTicket.id,
      supportRecipients,
      me.id,
      NotificationType.SUPPORT_TICKET_CREATED,
      "domains.support_tickets.ticket_created_title",
      "domains.support_tickets.ticket_created_message",
      { ticketTitle: savedTicket.title },
    );

    this.appGateway.emitSupportTicketCreated(
      this.uniqueUserIds(supportRecipients),
      savedTicket,
    );

    return {
      success: true,
      message: this.t("domains.support_tickets.created_successfully"),
      data: savedTicket,
    };
  }

  /* ================= Tenant: list ================= */

  async list(me: any, q?: any) {
    const adminId = tenantId(me);
    const { page, limit, skip } = this.pageParams(q);
    const { column, order } = this.sortClause(q, "ticket");

    const qb = this.ticketRepo
      .createQueryBuilder("ticket")
      .leftJoinAndSelect("ticket.assignedSupportUser", "assignedSupportUser")
      .leftJoinAndSelect("ticket.lastMessage", "lastMessage")
      .where("ticket.adminId = :adminId", { adminId });

    this.applyAdminFilters(qb, q, { skipAdminId: true });

    if (q?.search) {
      qb.andWhere(
        new Brackets((b) => {
          b.where("ticket.title ILIKE :search", { search: `%${q.search}%` });
        }),
      );
    }

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

  async get(me: any, ticketId: string) {
    const ticket = await this.findTenantTicket(me, ticketId, [
      "admin",
      "createdByUser",
      "lastMessage",
      "assignedSupportUser",
      "lastMessageByUser",
    ]);

    const counts = await this.getCountsForTickets(null, ticket.adminId, true);

    return {
      ...ticket,
      messageCount: counts.get(ticketId)?.messages || 0,
      attachmentCount: counts.get(ticketId)?.attachments || 0,
    };
  }

  /* ================= Tenant: messages ================= */

  async getMessages(me: any, ticketId: string, q?: any) {
    await this.findTenantTicket(me, ticketId);

    const adminId = tenantId(me);

    const limit = Number(q?.limit ?? 50);
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const cursor = q?.cursor;

    const qb = this.messageRepo
      .createQueryBuilder("message")
      .leftJoinAndSelect("message.sender", "sender")
      .leftJoinAndSelect("message.attachments", "attachments")
      .where("message.ticketId = :ticketId", { ticketId })
      .andWhere("message.adminId = :adminId", { adminId })
      .andWhere("message.isDeleted = false")
      .andWhere("message.isInternalNote = false");

    DateFilterUtil.rawDateFilter(
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
      nextCursor: hasMore
        ? {
            value: last.created_at,
            id: last.id,
          }
        : undefined,
      sortBy: "created_at",
      sortDir,
    };
  }

  async reply(me: any, ticketId: string, dto: any, files: any[]) {
    const adminId = tenantId(me);
    const ticket = await this.findTenantTicket(me, ticketId);

    if (!dto.message && (!files || files.length === 0)) {
      throw new BadRequestException(
        this.t("domains.support_tickets.message_or_files_required"),
      );
    }
    if (dto.isInternalNote) {
      throw new BadRequestException(
        this.t("domains.support_tickets.internal_note_not_allowed"),
      );
    }

    if (
      ticket.status === SupportTicketStatus.CLOSED ||
      ticket.status === SupportTicketStatus.CANCELED
    ) {
      throw new BadRequestException(
        this.t("domains.support_tickets.ticket_closed_or_canceled"),
      );
    }

    const message = this.messageRepo.create({
      adminId,
      ticketId: ticket.id,
      senderId: me.id,
      message: dto.message || null,
      isInternalNote: false,
      isSupportMessage: false,
      attachmentCount: files?.length || 0,
    });
    const saved = await this.messageRepo.save(message);

    if (files?.length) {
      await this.saveAttachments({
        adminId,
        uploadedByUserId: me.id,
        ticketId: ticket.id,
        messageId: saved.id,
        files,
      });
    }

    ticket.unreadSupportCount = (ticket.unreadSupportCount || 0) + 1;
    ticket.unreadUserCount = 0;
    ticket.lastMessageAt = new Date();
    ticket.lastMessageByUserId = me.id;
    ticket.lastMessageId = saved.id;

    const oldStatus = ticket.status;
    if (
      ticket.status === SupportTicketStatus.WAITING_ON_CUSTOMER ||
      ticket.status === SupportTicketStatus.RESOLVED
    ) {
      ticket.status = SupportTicketStatus.REOPENED;
    }

    await this.ticketRepo.save(ticket);

    const promises: Promise<any>[] = [];

    if (oldStatus !== ticket.status) {
      promises.push(
        this.logActivity(
          ticket.id,
          adminId,
          me.id,
          SupportTicketActivityType.STATUS_CHANGED,
          {
            oldStatus,
            newStatus: ticket.status,
          },
        ),
      );
    }

    // promises.push(
    //   this.logActivity(
    //     ticket.id,
    //     adminId,
    //     me.id,
    //     SupportTicketActivityType.MESSAGE_ADDED,
    //     {
    //       messageId: saved.id,
    //     },
    //   ),
    // );

    await Promise.all(promises);

    await this.notifyUsers(
      ticket.id,
      await this.supportRecipientIds(ticket),
      me.id,
      NotificationType.SUPPORT_TICKET_NEW_MESSAGE,
      "domains.support_tickets.new_message_title",
      "domains.support_tickets.new_message_message",
      { ticketTitle: ticket.title },
    );

    const withRelations = await this.messageRepo.findOne({
      where: { id: saved.id } as any,
      relations: ["sender", "attachments"],
    });

    const supportRecipients = await this.supportRecipientIds(ticket);
    this.appGateway.emitSupportTicketMessageCreated(
      this.uniqueUserIds(supportRecipients),
      withRelations || saved,
    );
    this.appGateway.emitSupportTicketUpdated(
      this.uniqueUserIds(supportRecipients),
      ticket,
    );

    return {
      success: true,
      message: this.t("domains.support_tickets.replied_successfully"),
      data: withRelations,
    };
  }

  async updateMessage(me: any, ticketId: string, messageId: string, dto: any) {
    const adminId = tenantId(me);
    await this.findTenantTicket(me, ticketId);

    const message = await this.messageRepo.findOne({
      where: { id: messageId, ticketId, adminId, senderId: me.id } as any,
      relations: {
        ticket: true,
      },
    });
    if (!message) {
      throw new NotFoundException(
        this.t("domains.support_tickets.message_not_found"),
      );
    }
    if (message.isDeleted) {
      throw new BadRequestException(
        this.t("domains.support_tickets.cannot_edit_deleted_message"),
      );
    }
    if (message.isInternalNote) {
      throw new ForbiddenException(
        this.t("domains.support_tickets.only_own_message"),
      );
    }

    if (
      message?.ticket?.status === SupportTicketStatus.CLOSED ||
      message?.ticket?.status === SupportTicketStatus.CANCELED
    ) {
      throw new BadRequestException(
        this.t("domains.support_tickets.ticket_closed_or_canceled"),
      );
    }

    message.message = dto.message;
    message.isEdited = true;
    message.edited_at = new Date();

    const saved = await this.messageRepo.save(message);

    this.appGateway.emitSupportTicketMessageUpdated(
      this.uniqueUserIds(await this.supportRecipientIds(message.ticket)),
      saved,
    );

    return {
      success: true,
      message: this.t("domains.support_tickets.message_updated_successfully"),
      data: saved,
    };
  }

  async deleteMessage(me: any, ticketId: string, messageId: string) {
    const adminId = tenantId(me);
    await this.findTenantTicket(me, ticketId);

    const message = await this.messageRepo.findOne({
      where: { id: messageId, ticketId, adminId, senderId: me.id } as any,
      relations: {
        ticket: true,
      },
    });
    if (!message) {
      throw new NotFoundException(
        this.t("domains.support_tickets.message_not_found"),
      );
    }

    if (
      message?.ticket?.status === SupportTicketStatus.CLOSED ||
      message?.ticket?.status === SupportTicketStatus.CANCELED
    ) {
      throw new BadRequestException(
        this.t("domains.support_tickets.ticket_closed_or_canceled"),
      );
    }

    message.isDeleted = true;
    message.deleted_at = new Date();
    message.message = null;

    await this.messageRepo.save(message);

    return {
      success: true,
      message: this.t("domains.support_tickets.message_deleted_successfully"),
    };
  }

  // async addAttachments(me: any, ticketId: string, messageId: string, files: any[]) {
  // 	const adminId = tenantId(me);
  // 	if (!files || files.length === 0) {
  // 		throw new BadRequestException(this.t("domains.support_tickets.files_required"));
  // 	}

  // 	await this.findTenantTicket(me, ticketId);

  // 	const message = await this.messageRepo.findOne({
  // 		where: { id: messageId, ticketId, adminId, senderId: me.id } as any,
  // 	});
  // 	if (!message) {
  // 		throw new NotFoundException(this.t("domains.support_tickets.message_not_found"));
  // 	}

  // 	const attachments = await this.saveAttachments({
  // 		adminId,
  // 		uploadedByUserId: me.id,
  // 		ticketId,
  // 		messageId,
  // 		files,
  // 	});

  // 	return { success: true, data: attachments };
  // }

  // async deleteAttachment(me: any, ticketId: string, messageId: string, attachmentId: string) {
  // 	const adminId = tenantId(me);
  // 	await this.findTenantTicket(me, ticketId);

  // 	const message = await this.messageRepo.findOne({
  // 		where: { id: messageId, ticketId, adminId, senderId: me.id } as any,
  // 	});
  // 	if (!message) {
  // 		throw new ForbiddenException(this.t("domains.support_tickets.only_own_message"));
  // 	}

  // 	const attachment = await this.attachmentRepo.findOne({
  // 		where: { id: attachmentId, ticketId, messageId, adminId } as any,
  // 	});
  // 	if (!attachment) {
  // 		throw new NotFoundException(this.t("domains.support_tickets.attachment_not_found"));
  // 	}

  // 	await deleteFile(attachment.url);
  // 	await this.attachmentRepo.remove(attachment);

  // 	await this.logActivity(
  // 		ticketId,
  // 		adminId,
  // 		me.id,
  // 		SupportTicketActivityType.ATTACHMENT_DELETED,
  // 		{ attachmentId, originalName: attachment.originalName },
  // 	);

  // 	return {
  // 		success: true,
  // 		message: this.t("domains.support_tickets.attachment_deleted_successfully"),
  // 	};
  // }

  async getAttachmentForTenant(
    me: any,
    ticketId: string,
    attachmentId: string,
  ) {
    const adminId = tenantId(me);
    await this.findTenantTicket(me, ticketId);

    const attachment = await this.attachmentRepo.findOne({
      where: { id: attachmentId, ticketId, adminId } as any,
    });
    if (!attachment) {
      throw new NotFoundException(
        this.t("domains.support_tickets.attachment_not_found"),
      );
    }
    return attachment;
  }

  async getAttachmentForSupport(
    me: any,
    ticketId: string,
    attachmentId: string,
  ) {
    await this.requireTicket(ticketId);

    const attachment = await this.attachmentRepo.findOne({
      where: { id: attachmentId, ticketId } as any,
    });
    if (!attachment) {
      throw new NotFoundException(
        this.t("domains.support_tickets.attachment_not_found"),
      );
    }
    return attachment;
  }

  /* ================= Tenant: state changes ================= */

  async markRead(me: any, ticketId: string) {
    const ticket = await this.findTenantTicket(me, ticketId);
    ticket.unreadUserCount = 0;
    await this.ticketRepo.save(ticket);
    this.appGateway.emitSupportTicketRead(
      this.uniqueUserIds([
        ...this.tenantRecipientIds(ticket),
        ...(await this.supportRecipientIds(ticket)),
      ]),
      ticket,
      me.id,
      "tenant",
    );
    return {
      success: true,
      message: this.t("domains.support_tickets.ticket_marked_read"),
    };
  }

  async close(me: any, ticketId: string, dto: any) {
    const ticket = await this.findTenantTicket(me, ticketId);

    ticket.status = SupportTicketStatus.CLOSED;
    ticket.closed_at = new Date();
    ticket.closedByUserId = me.id;
    if (
      ticket.status === SupportTicketStatus.CLOSED ||
      ticket.status === SupportTicketStatus.CANCELED
    ) {
      throw new BadRequestException(
        this.t("domains.support_tickets.ticket_closed_or_canceled"),
      );
    }
    await this.ticketRepo.save(ticket);
    await this.logActivity(
      ticket.id,
      ticket.adminId,
      me.id,
      SupportTicketActivityType.CLOSED,
      { reason: dto?.reason || null },
    );

    await this.notifyUsers(
      ticket.id,
      await this.supportRecipientIds(ticket),
      me.id,
      NotificationType.SUPPORT_TICKET_CLOSED,
      "domains.support_tickets.ticket_closed_title",
      "domains.support_tickets.ticket_closed_message",
      { ticketTitle: ticket.title },
    );

    this.appGateway.emitSupportTicketUpdated(
      this.uniqueUserIds(await this.supportRecipientIds(ticket)),
      ticket,
    );

    return {
      success: true,
      message: this.t("domains.support_tickets.ticket_closed_successfully"),
      data: ticket,
    };
  }

  async cancel(me: any, ticketId: string, dto: any) {
    const ticket = await this.findTenantTicket(me, ticketId);
    if (
      ticket.status === SupportTicketStatus.CLOSED ||
      ticket.status === SupportTicketStatus.CANCELED
    ) {
      throw new BadRequestException(
        this.t("domains.support_tickets.ticket_closed_or_canceled"),
      );
    }

    ticket.status = SupportTicketStatus.CANCELED;
    ticket.closed_at = new Date();
    ticket.closedByUserId = me.id;

    await this.ticketRepo.save(ticket);
    await this.logActivity(
      ticket.id,
      ticket.adminId,
      me.id,
      SupportTicketActivityType.CANCELED,
      { reason: dto?.reason || null },
    );

    await this.notifyUsers(
      ticket.id,
      await this.supportRecipientIds(ticket),
      me.id,
      NotificationType.SUPPORT_TICKET_CANCELED,
      "domains.support_tickets.ticket_canceled_title",
      "domains.support_tickets.ticket_canceled_message",
      { ticketTitle: ticket.title },
    );

    this.appGateway.emitSupportTicketUpdated(
      this.uniqueUserIds(await this.supportRecipientIds(ticket)),
      ticket,
    );

    return {
      success: true,
      message: this.t("domains.support_tickets.ticket_canceled_successfully"),
      data: ticket,
    };
  }

  async reopen(me: any, ticketId: string, dto: any) {
    const ticket = await this.findTenantTicket(me, ticketId);

    if (
      ticket.status !== SupportTicketStatus.RESOLVED &&
      ticket.status !== SupportTicketStatus.CLOSED
    ) {
      throw new BadRequestException(
        this.t("domains.support_tickets.cannot_reopen"),
      );
    }

    ticket.status = SupportTicketStatus.REOPENED;
    ticket.solved_at = null;
    ticket.solvedByUserId = null;
    ticket.closed_at = null;
    ticket.closedByUserId = null;

    await this.ticketRepo.save(ticket);

    let message: SupportTicketMessageEntity | undefined;
    if (dto?.message) {
      message = await this.messageRepo.save(
        this.messageRepo.create({
          adminId: ticket.adminId,
          ticketId: ticket.id,
          senderId: me.id,
          isSupportMessage: false,
          message: dto.message,
        }),
      );
    }

    await this.logActivity(
      ticket.id,
      ticket.adminId,
      me.id,
      SupportTicketActivityType.REOPENED,
      { messageId: message?.id || null },
    );

    await this.notifyUsers(
      ticket.id,
      await this.supportRecipientIds(ticket),
      me.id,
      NotificationType.SUPPORT_TICKET_REOPENED,
      "domains.support_tickets.ticket_reopened_title",
      "domains.support_tickets.ticket_reopened_message",
      { ticketTitle: ticket.title },
    );

    const supportRecipients = await this.supportRecipientIds(ticket);
    this.appGateway.emitSupportTicketUpdated(
      this.uniqueUserIds(supportRecipients),
      ticket,
    );
    if (message) {
      this.appGateway.emitSupportTicketMessageCreated(
        this.uniqueUserIds(supportRecipients),
        message,
      );
    }

    return {
      success: true,
      message: this.t("domains.support_tickets.ticket_reopened_successfully"),
      data: ticket,
    };
  }

  async getActivity(me: any, ticketId: string) {
    await this.findTenantTicket(me, ticketId);

    return this.activityRepo.find({
      where: { ticketId, isPublic: true } as any,
      relations: ["performedByUser"],
      order: { created_at: "ASC" } as any,
    });
  }
  async getStats(me: any) {
    const adminId = tenantId(me);

    const [rows, unread] = await Promise.all([
      this.ticketRepo
        .createQueryBuilder("t")
        .select("t.status", "status")
        .addSelect("COUNT(*)", "count")
        .where("t.adminId = :adminId", { adminId })
        .groupBy("t.status")
        .getRawMany(),

      this.ticketRepo
        .createQueryBuilder("t")
        .where("t.adminId = :adminId", { adminId })
        .andWhere("t.unreadUserCount > 0")
        .getCount(),
    ]);

    const counts: Record<string, number> = {};
    rows.forEach((r) => {
      counts[r.status] = parseInt(r.count, 10);
    });

    return {
      total: rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0),
      open: counts[SupportTicketStatus.OPEN] || 0,
      inProgress: counts[SupportTicketStatus.IN_PROGRESS] || 0,
      waitingOnCustomer: counts[SupportTicketStatus.WAITING_ON_CUSTOMER] || 0,
      onHold: counts[SupportTicketStatus.ON_HOLD] || 0,
      resolved: counts[SupportTicketStatus.RESOLVED] || 0,
      closed: counts[SupportTicketStatus.CLOSED] || 0,
      reopened: counts[SupportTicketStatus.REOPENED] || 0,
      canceled: counts[SupportTicketStatus.CANCELED] || 0,
      unread,
    };
  }

  /* ================= Admin: list ================= */

  private applyAdminFilters(
    qb: SelectQueryBuilder<SupportTicketEntity>,
    q?: any,
    opts?: { skipAdminId?: boolean },
  ) {
    if (!opts?.skipAdminId && q?.adminId) {
      qb.andWhere("ticket.adminId = :adminId", { adminId: q.adminId });
    }
    if (q?.createdByUserId) {
      qb.andWhere("ticket.createdByUserId = :createdByUserId", {
        createdByUserId: q.createdByUserId,
      });
    }
    if (q?.assignedSupportUserId) {
      qb.andWhere("ticket.assignedSupportUserId = :assignedSupportUserId", {
        assignedSupportUserId: q.assignedSupportUserId,
      });
    }
    if (q?.status) qb.andWhere("ticket.status = :status", { status: q.status });
    if (q?.priority) {
      qb.andWhere("ticket.priority = :priority", { priority: q.priority });
    }

    if (q?.unassigned === true || q?.unassigned === "true") {
      qb.andWhere("ticket.assignedSupportUserId IS NULL");
    }
    if (q?.hasUnreadSupport === true || q?.hasUnreadSupport === "true") {
      qb.andWhere("ticket.unreadSupportCount > 0");
    }

    DateFilterUtil.rawDateFilter(
      qb,
      "ticket.created_at",
      q?.startDate,
      q?.endDate,
    );
  }

  private adminListQuery(q?: any, tenantAdminId?: string | null) {
    const qb = this.ticketRepo
      .createQueryBuilder("ticket")
      .leftJoinAndSelect("ticket.admin", "admin")
      .leftJoinAndSelect("ticket.createdByUser", "createdByUser")
      .leftJoinAndSelect("ticket.assignedSupportUser", "assignedSupportUser")
      .leftJoinAndSelect("ticket.lastMessageByUser", "lastMessageByUser")
      .leftJoinAndSelect("ticket.lastMessage", "lastMessage");

    if (tenantAdminId) {
      qb.where("ticket.adminId = :tenantAdminId", { tenantAdminId });
    }

    this.applyAdminFilters(qb, q, { skipAdminId: !!tenantAdminId });

    if (q?.search) {
      qb.andWhere(
        new Brackets((b) => {
          b.where("ticket.title ILIKE :search", { search: `%${q.search}%` })
            .orWhere("ticket.id::text ILIKE :search", {
              search: `%${q.search}%`,
            })
            .orWhere("admin.name ILIKE :search", { search: `%${q.search}%` })
            .orWhere("admin.email ILIKE :search", { search: `%${q.search}%` })
            .orWhere("createdByUser.name ILIKE :search", {
              search: `%${q.search}%`,
            })
            .orWhere("createdByUser.email ILIKE :search", {
              search: `%${q.search}%`,
            });
        }),
      );
    }

    return qb;
  }

  async adminList(me: any, q?: any) {
    const { page, limit, skip } = this.pageParams(q);
    const { column, order } = this.sortClause(q, "ticket");

    const qb = this.adminListQuery(q);

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

  async adminGet(me: any, ticketId: string) {
    const ticket = await this.requireTicket(ticketId, [
      "admin",
      "createdByUser",
      "assignedSupportUser",
      "lastMessage",
      "lastMessageByUser",
      "solvedByUser",
      "closedByUser",
    ]);

    const counts = await this.getCountsForTickets(null, ticket.adminId);

    return {
      ...ticket,
      messageCount: counts.get(ticketId)?.messages || 0,
      attachmentCount: counts.get(ticketId)?.attachments || 0,
    };
  }

  async adminGetMessages(me: any, ticketId: string, q?: any) {
    await this.requireTicket(ticketId);

    const limit = Number(q?.limit ?? 50);
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const cursor = q?.cursor;

    const qb = this.messageRepo
      .createQueryBuilder("message")
      .leftJoinAndSelect("message.sender", "sender")
      .leftJoinAndSelect("message.attachments", "attachments")
      .where("message.ticketId = :ticketId", { ticketId });

    DateFilterUtil.rawDateFilter(
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
      nextCursor: hasMore
        ? {
            value: last.created_at,
            id: last.id,
          }
        : undefined,
      sortBy: "created_at",
      sortDir,
    };
  }

  async adminReply(me: any, ticketId: string, dto: any, files: any[]) {
    const ticket = await this.requireTicket(ticketId);
    this.requireCanActOnTicket(me, ticket);

    // No replies on finished tickets
    if (
      [SupportTicketStatus.CLOSED, SupportTicketStatus.CANCELED].includes(
        ticket.status,
      )
    ) {
      throw new BadRequestException(
        this.t("domains.support_tickets.ticket_closed_or_canceled"),
      );
    }

    if (!dto.message && (!files || files.length === 0)) {
      throw new BadRequestException(
        this.t("domains.support_tickets.message_or_files_required"),
      );
    }

    const isInternalNote = !!dto.isInternalNote;

    const message = this.messageRepo.create({
      adminId: ticket.adminId,
      ticketId: ticket.id,
      senderId: me.id,
      message: dto.message || null,
      isInternalNote,
      isSupportMessage: true,
      attachmentCount: files?.length || 0,
    });
    const saved = await this.messageRepo.save(message);

    if (files?.length) {
      await this.saveAttachments({
        adminId: ticket.adminId,
        uploadedByUserId: me.id,
        ticketId: ticket.id,
        messageId: saved.id,
        files,
      });
    }

    const promises: Promise<any>[] = [];
    if (!isInternalNote) {
      ticket.unreadUserCount = (ticket.unreadUserCount || 0) + 1;
      ticket.unreadSupportCount = 0;
      ticket.lastMessageAt = new Date();
      ticket.lastMessageByUserId = me.id;
      ticket.lastMessageId = saved.id;
      const oldStatus = ticket.status;
      if (
        ticket.status === SupportTicketStatus.OPEN ||
        ticket.status === SupportTicketStatus.REOPENED
      ) {
        ticket.status = SupportTicketStatus.IN_PROGRESS;
      }

      if (oldStatus !== ticket.status) {
        promises.push(
          this.logActivity(
            ticket.id,
            ticket.adminId,
            me.id,
            SupportTicketActivityType.STATUS_CHANGED,
            {
              oldStatus,
              newStatus: ticket.status,
            },
          ),
        );
      }

      await this.ticketRepo.save(ticket);

      // promises.push(
      //   this.logActivity(
      //     ticket.id,
      //     ticket.adminId,
      //     me.id,
      //     SupportTicketActivityType.MESSAGE_ADDED,
      //     { messageId: saved.id },
      //   ),
      // );
    }

    await Promise.all(promises);

    if (isInternalNote) {
      await this.notifyUsers(
        ticket.id,
        await this.superAdminUserIds(),
        me.id,
        NotificationType.SUPPORT_TICKET_INTERNAL_NOTE,
        "domains.support_tickets.internal_note_title",
        "domains.support_tickets.internal_note_message",
        { ticketTitle: ticket.title },
      );
    } else {
      await this.notifyUsers(
        ticket.id,
        this.tenantRecipientIds(ticket),
        me.id,
        NotificationType.SUPPORT_TICKET_NEW_MESSAGE,
        "domains.support_tickets.new_message_title",
        "domains.support_tickets.new_message_message",
        { ticketTitle: ticket.title },
      );
    }

    const withRelations = await this.messageRepo.findOne({
      where: { id: saved.id } as any,
      relations: ["sender", "attachments"],
    });

    if (isInternalNote) {
      this.appGateway.emitSupportTicketMessageCreated(
        this.uniqueUserIds(await this.superAdminUserIds()),
        withRelations || saved,
      );
    } else {
      this.appGateway.emitSupportTicketMessageCreated(
        this.uniqueUserIds(this.tenantRecipientIds(ticket)),
        withRelations || saved,
      );
      this.appGateway.emitSupportTicketUpdated(
        this.uniqueUserIds(this.tenantRecipientIds(ticket)),
        ticket,
      );
    }

    return {
      success: true,
      message: this.t("domains.support_tickets.replied_successfully"),
      data: withRelations,
    };
  }

  /* ================= Admin: assign / status / priority ================= */

  async assign(me: any, ticketId: string, dto: any) {
    this.requireSuperAdmin(me);

    const ticket = await this.requireTicket(ticketId);

    if (
      [SupportTicketStatus.CLOSED, SupportTicketStatus.CANCELED].includes(
        ticket.status,
      )
    ) {
      throw new BadRequestException(
        this.t(
          "domains.support_tickets.cannot_assign_closed_or_canceled_ticket",
        ),
      );
    }

    const user = await this.userRepo.findOne({
      where: { id: dto.assignedSupportUserId } as any,
    });
    if (!user) {
      throw new BadRequestException(
        this.t("domains.support_tickets.support_user_not_found"),
      );
    }

    const oldAssignee = ticket.assignedSupportUserId;
    ticket.assignedSupportUserId = dto.assignedSupportUserId;
    const oldStatus = ticket.status;
    if (ticket.status === SupportTicketStatus.OPEN) {
      ticket.status = SupportTicketStatus.IN_PROGRESS;
    }
    const promises: Promise<any>[] = [];

    if (oldStatus !== ticket.status) {
      promises.push(
        this.logActivity(
          ticket.id,
          ticket.adminId,
          me.id,
          SupportTicketActivityType.STATUS_CHANGED,
          {
            oldStatus,
            newStatus: ticket.status,
          },
        ),
      );
    }

    await this.ticketRepo.save(ticket);
    promises.push(
      this.logActivity(
        ticket.id,
        ticket.adminId,
        me.id,
        SupportTicketActivityType.ASSIGNED,
        {
          assignedSupportUserId: dto.assignedSupportUserId,
          oldAssignedSupportUserId: oldAssignee,
        },
      ),
    );

    await Promise.all(promises);

    await this.notifyUsers(
      ticket.id,
      [dto.assignedSupportUserId],
      me.id,
      NotificationType.SUPPORT_TICKET_ASSIGNED,
      "domains.support_tickets.ticket_assigned_title",
      "domains.support_tickets.ticket_assigned_message",
      { ticketTitle: ticket.title },
    );

    this.appGateway.emitSupportTicketUpdated(
      this.uniqueUserIds([
        ...this.tenantRecipientIds(ticket),
        ...(await this.supportRecipientIds(ticket)),
      ]),
      ticket,
    );

    return {
      success: true,
      message: this.t("domains.support_tickets.ticket_assigned_successfully"),
      data: ticket,
    };
  }

  async unassign(me: any, ticketId: string) {
    this.requireSuperAdmin(me);

    const ticket = await this.requireTicket(ticketId);

    if (
      [SupportTicketStatus.CLOSED, SupportTicketStatus.CANCELED].includes(
        ticket.status,
      )
    ) {
      throw new BadRequestException(
        this.t(
          "domains.support_tickets.cannot_unassign_closed_or_canceled_ticket",
        ),
      );
    }

    const oldAssignee = ticket.assignedSupportUserId;
    ticket.assignedSupportUserId = null;

    await this.ticketRepo.save(ticket);
    await this.logActivity(
      ticket.id,
      ticket.adminId,
      me.id,
      SupportTicketActivityType.UNASSIGNED,
      { oldAssignedSupportUserId: oldAssignee },
    );

    await this.notifyUsers(
      ticket.id,
      [oldAssignee],
      me.id,
      NotificationType.SUPPORT_TICKET_UNASSIGNED,
      "domains.support_tickets.ticket_unassigned_title",
      "domains.support_tickets.ticket_unassigned_message",
      { ticketTitle: ticket.title },
    );

    this.appGateway.emitSupportTicketUpdated(
      this.uniqueUserIds([
        ...this.tenantRecipientIds(ticket),
        ...(await this.supportRecipientIds(ticket)),
      ]),
      ticket,
    );

    return {
      success: true,
      message: this.t("domains.support_tickets.ticket_unassigned_successfully"),
      data: ticket,
    };
  }

  private async applyStatus(
    ticket: SupportTicketEntity,
    me: any,
    status: SupportTicketStatus,
    reason?: string,
  ) {
    const allowed = SUPPORT_TICKET_STATUS_TRANSITIONS[ticket.status] || [];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        this.t("domains.support_tickets.invalid_status_transition"),
      );
    }

    this.requireCanActOnTicket(me, ticket);
    const oldStatus = ticket.status;
    ticket.status = status;

    if (status === SupportTicketStatus.RESOLVED) {
      ticket.solved_at = new Date();
      ticket.solvedByUserId = me.id;
    }
    if (status === SupportTicketStatus.CLOSED) {
      ticket.closed_at = new Date();
      ticket.closedByUserId = me.id;
    }
    if (status === SupportTicketStatus.REOPENED) {
      ticket.solved_at = null;
      ticket.solvedByUserId = null;
      ticket.closed_at = null;
      ticket.closedByUserId = null;
    }

    await this.ticketRepo.save(ticket);
    if (oldStatus !== status) {
      await this.logActivity(
        ticket.id,
        ticket.adminId,
        me.id,
        SupportTicketActivityType.STATUS_CHANGED,
        { oldStatus, newStatus: status, reason: reason || null },
      );
    }
    const notification = this.notificationForStatus(status);
    const statusRecipients = this.tenantRecipientIds(ticket);
    if (this.isSuperAdmin(me)) {
      statusRecipients.push(...(await this.supportRecipientIds(ticket)));
    }
    await this.notifyUsers(
      ticket.id,
      statusRecipients,
      me.id,
      notification.type,
      notification.titleKey,
      notification.messageKey,
      { ticketTitle: ticket.title, status: this.statusLabel(status) },
    );

    this.appGateway.emitSupportTicketUpdated(
      this.uniqueUserIds(statusRecipients),
      ticket,
    );

    return ticket;
  }

  async changeStatus(me: any, ticketId: string, dto: any) {
    const ticket = await this.requireTicket(ticketId);
    this.requireCanActOnTicket(me, ticket);
    const updated = await this.applyStatus(ticket, me, dto.status, dto.reason);

    return {
      success: true,
      message: this.t(
        "domains.support_tickets.ticket_status_updated_successfully",
      ),
      data: updated,
    };
  }

  async changePriority(me: any, ticketId: string, dto: any) {
    this.requireSuperAdmin(me);

    const ticket = await this.requireTicket(ticketId);

    const oldPriority = ticket.priority;
    ticket.priority = dto.priority;

    await this.ticketRepo.save(ticket);
    await this.logActivity(
      ticket.id,
      ticket.adminId,
      me.id,
      SupportTicketActivityType.PRIORITY_CHANGED,
      { oldPriority, newPriority: dto.priority },
    );

    await this.notifyUsers(
      ticket.id,
      [...(await this.supportRecipientIds(ticket))],
      me.id,
      NotificationType.SUPPORT_TICKET_PRIORITY_CHANGED,
      "domains.support_tickets.ticket_priority_changed_title",
      "domains.support_tickets.ticket_priority_changed_message",
      {
        ticketTitle: ticket.title,
        priority: this.priorityLabel(dto.priority),
      },
    );

    this.appGateway.emitSupportTicketUpdated(
      this.uniqueUserIds([
        ...this.tenantRecipientIds(ticket),
        ...(await this.supportRecipientIds(ticket)),
      ]),
      ticket,
    );

    return {
      success: true,
      message: this.t(
        "domains.support_tickets.ticket_priority_updated_successfully",
      ),
      data: ticket,
    };
  }

  async resolve(me: any, ticketId: string, dto: any) {
    const ticket = await this.requireTicket(ticketId);
    this.requireCanActOnTicket(me, ticket);

    let savedMessage: SupportTicketMessageEntity | undefined;
    if (dto?.message) {
      savedMessage = await this.messageRepo.save(
        this.messageRepo.create({
          adminId: ticket.adminId,
          ticketId: ticket.id,
          senderId: me.id,
          isSupportMessage: true,
          message: dto.message,
          isInternalNote: false,
        }),
      );
    }

    ticket.status = SupportTicketStatus.RESOLVED;
    ticket.solved_at = new Date();
    ticket.solvedByUserId = me.id;

    await this.ticketRepo.save(ticket);
    await this.logActivity(
      ticket.id,
      ticket.adminId,
      me.id,
      SupportTicketActivityType.RESOLVED,
      { message: dto?.message || null },
    );

    await this.notifyUsers(
      ticket.id,
      this.tenantRecipientIds(ticket),
      me.id,
      NotificationType.SUPPORT_TICKET_RESOLVED,
      "domains.support_tickets.ticket_resolved_title",
      "domains.support_tickets.ticket_resolved_message",
      { ticketTitle: ticket.title },
    );

    if (savedMessage) {
      this.appGateway.emitSupportTicketMessageCreated(
        this.uniqueUserIds(this.tenantRecipientIds(ticket)),
        savedMessage,
      );
    }
    this.appGateway.emitSupportTicketUpdated(
      this.uniqueUserIds([
        ...this.tenantRecipientIds(ticket),
        ...(await this.supportRecipientIds(ticket)),
      ]),
      ticket,
    );

    return {
      success: true,
      message: this.t("domains.support_tickets.ticket_resolved_successfully"),
      data: ticket,
    };
  }

  async closeBySupport(me: any, ticketId: string, dto: any) {
    const ticket = await this.requireTicket(ticketId);
    this.requireCanActOnTicket(me, ticket);

    ticket.status = SupportTicketStatus.CLOSED;
    ticket.closed_at = new Date();
    ticket.closedByUserId = me.id;

    await this.ticketRepo.save(ticket);
    await this.logActivity(
      ticket.id,
      ticket.adminId,
      me.id,
      SupportTicketActivityType.CLOSED,
      { reason: dto?.reason || null },
    );

    await this.notifyUsers(
      ticket.id,
      this.tenantRecipientIds(ticket),
      me.id,
      NotificationType.SUPPORT_TICKET_CLOSED,
      "domains.support_tickets.ticket_closed_title",
      "domains.support_tickets.ticket_closed_message",
      { ticketTitle: ticket.title },
    );

    this.appGateway.emitSupportTicketUpdated(
      this.uniqueUserIds([
        ...this.tenantRecipientIds(ticket),
        ...(await this.supportRecipientIds(ticket)),
      ]),
      ticket,
    );

    return {
      success: true,
      message: this.t("domains.support_tickets.ticket_closed_successfully"),
      data: ticket,
    };
  }

  async hold(me: any, ticketId: string, dto: any) {
    const ticket = await this.requireTicket(ticketId);
    this.requireCanActOnTicket(me, ticket);
    const oldStatus = ticket.status;
    ticket.status = SupportTicketStatus.ON_HOLD;

    await this.ticketRepo.save(ticket);

    if (oldStatus !== ticket.status) {
      await this.logActivity(
        ticket.id,
        ticket.adminId,
        me.id,
        SupportTicketActivityType.STATUS_CHANGED,
        {
          oldStatus,
          newStatus: SupportTicketStatus.ON_HOLD,
          reason: dto?.reason || null,
        },
      );
    }

    await this.notifyUsers(
      ticket.id,
      this.tenantRecipientIds(ticket),
      me.id,
      NotificationType.SUPPORT_TICKET_STATUS_CHANGED,
      "domains.support_tickets.ticket_status_changed_title",
      "domains.support_tickets.ticket_status_changed_message",
      {
        ticketTitle: ticket.title,
        status: this.statusLabel(SupportTicketStatus.ON_HOLD),
      },
    );

    this.appGateway.emitSupportTicketUpdated(
      this.uniqueUserIds([
        ...this.tenantRecipientIds(ticket),
        ...(await this.supportRecipientIds(ticket)),
      ]),
      ticket,
    );

    return {
      success: true,
      message: this.t("domains.support_tickets.ticket_on_hold"),
      data: ticket,
    };
  }

  async waitingOnCustomer(me: any, ticketId: string, dto: any) {
    const ticket = await this.requireTicket(ticketId);
    this.requireCanActOnTicket(me, ticket);
    const oldStatus = ticket.status;
    ticket.status = SupportTicketStatus.WAITING_ON_CUSTOMER;

    await this.ticketRepo.save(ticket);

    let savedMessage: SupportTicketMessageEntity | undefined;
    if (dto?.message) {
      savedMessage = await this.messageRepo.save(
        this.messageRepo.create({
          adminId: ticket.adminId,
          ticketId: ticket.id,
          senderId: me.id,
          message: dto.message,
          isSupportMessage: true,
          isInternalNote: false,
        }),
      );
    }

    if (oldStatus !== ticket.status) {
      await this.logActivity(
        ticket.id,
        ticket.adminId,
        me.id,
        SupportTicketActivityType.STATUS_CHANGED,
        {
          oldStatus,
          newStatus: SupportTicketStatus.WAITING_ON_CUSTOMER,
          message: dto?.message || null,
        },
      );
    }

    await this.notifyUsers(
      ticket.id,
      this.tenantRecipientIds(ticket),
      me.id,
      NotificationType.SUPPORT_TICKET_STATUS_CHANGED,
      "domains.support_tickets.ticket_status_changed_title",
      "domains.support_tickets.ticket_status_changed_message",
      {
        ticketTitle: ticket.title,
        status: this.statusLabel(SupportTicketStatus.WAITING_ON_CUSTOMER),
      },
    );

    if (savedMessage) {
      this.appGateway.emitSupportTicketMessageCreated(
        this.uniqueUserIds(this.tenantRecipientIds(ticket)),
        savedMessage,
      );
    }
    this.appGateway.emitSupportTicketUpdated(
      this.uniqueUserIds([
        ...this.tenantRecipientIds(ticket),
        ...(await this.supportRecipientIds(ticket)),
      ]),
      ticket,
    );

    return {
      success: true,
      message: this.t("domains.support_tickets.ticket_waiting_on_customer"),
      data: ticket,
    };
  }

  async markReadBySupport(me: any, ticketId: string) {
    const ticket = await this.requireTicket(ticketId);
    ticket.unreadSupportCount = 0;
    await this.ticketRepo.save(ticket);
    this.appGateway.emitSupportTicketRead(
      this.uniqueUserIds([
        ...this.tenantRecipientIds(ticket),
        ...(await this.supportRecipientIds(ticket)),
      ]),
      ticket,
      me.id,
      "support",
    );
    return {
      success: true,
      message: this.t("domains.support_tickets.ticket_marked_read"),
    };
  }

  async getActivityAdmin(me: any, ticketId: string) {
    await this.requireTicket(ticketId);

    return this.activityRepo.find({
      where: { ticketId } as any,
      relations: ["performedByUser"],
      order: { created_at: "ASC" } as any,
    });
  }

  /* ================= Admin: support users ================= */

  async supportUsers(me: any, q?: any) {
    const supportRole = await this.roleRepo.findOne({
      where: { name: "support" },
      select: { id: true },
    });

    if (!supportRole) {
      return [];
    }

    const qb = this.userRepo
      .createQueryBuilder("u")
      .where("u.roleId = :roleId", { roleId: supportRole.id });

    if (q?.search) {
      qb.andWhere(
        new Brackets((b) => {
          b.where("u.name ILIKE :search", { search: `%${q.search}%` }).orWhere(
            "u.email ILIKE :search",
            { search: `%${q.search}%` },
          );
        }),
      );
    }

    if (q?.activeOnly === true || q?.activeOnly === "true") {
      qb.andWhere("u.isActive = true");
    }

    const users = await qb.getMany();

    if (!users.length) {
      return [];
    }

    const counts = await this.ticketRepo
      .createQueryBuilder("t")
      .select("t.assignedSupportUserId", "userId")
      .addSelect("COUNT(*)::int", "count")
      .where("t.assignedSupportUserId IN (:...ids)", {
        ids: users.map((u) => u.id),
      })
      .andWhere("t.status IN (:...statuses)", {
        statuses: OPEN_ASSIGNED_STATUSES,
      })
      .groupBy("t.assignedSupportUserId")
      .getRawMany();

    const countMap = new Map(counts.map((r) => [r.userId, Number(r.count)]));

    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatarUrl,
      isActive: u.isActive,
      assignedOpenTickets: countMap.get(u.id) ?? 0,
    }));
  }

  /* ================= Admin: statistics ================= */

  async adminStats(me: any, q?: any) {
    const countsQb = this.ticketRepo.createQueryBuilder("ticket");
    this.applyAdminFilters(countsQb, q);

    const rows = await countsQb
      .clone()
      .select("ticket.status", "status")
      .addSelect("COUNT(*)", "count")
      .groupBy("ticket.status")
      .getRawMany();

    const counts: Record<string, number> = {};
    rows.forEach((r) => {
      counts[r.status] = Number(r.count);
    });

    const filterQb = (
      where?: (qb: SelectQueryBuilder<SupportTicketEntity>) => void,
    ) => {
      const qb = this.ticketRepo.createQueryBuilder("ticket");
      this.applyAdminFilters(qb, q);
      where?.(qb);
      return qb.getCount();
    };

    const [total, unassigned, urgent, unreadBySupport] = await Promise.all([
      filterQb(),
      filterQb((qb) => qb.andWhere("ticket.assignedSupportUserId IS NULL")),
      filterQb((qb) =>
        qb.andWhere("ticket.priority = :urgent", {
          urgent: SupportTicketPriority.URGENT,
        }),
      ),
      filterQb((qb) => qb.andWhere("ticket.unreadSupportCount > 0")),
    ]);

    return {
      total,
      open: counts[SupportTicketStatus.OPEN] ?? 0,
      inProgress: counts[SupportTicketStatus.IN_PROGRESS] ?? 0,
      waitingOnCustomer: counts[SupportTicketStatus.WAITING_ON_CUSTOMER] ?? 0,
      onHold: counts[SupportTicketStatus.ON_HOLD] ?? 0,
      resolved: counts[SupportTicketStatus.RESOLVED] ?? 0,
      closed: counts[SupportTicketStatus.CLOSED] ?? 0,
      reopened: counts[SupportTicketStatus.REOPENED] ?? 0,
      canceled: counts[SupportTicketStatus.CANCELED] ?? 0,
      unassigned,
      urgent,
      unreadBySupport,
    };
  }

  /* ================= Export ================= */

  private async getCountsForTickets(
    q?: any,
    tenantAdminId?: string | null,
    excludeInternalNotes = false,
  ): Promise<Map<string, { messages: number; attachments: number }>> {
    const qb = this.ticketRepo
      .createQueryBuilder("ticket")
      .leftJoin(
        SupportTicketMessageEntity,
        "message",
        `
				message."ticketId" = ticket.id
				AND message."isDeleted" = :isDeleted
				${excludeInternalNotes ? `AND message."isInternalNote" = :isInternalNote` : ""}
			`,
        excludeInternalNotes
          ? { isDeleted: false, isInternalNote: false }
          : { isDeleted: false },
      )
      .leftJoin(
        SupportTicketAttachmentEntity,
        "attachment",
        "attachment.ticketId = ticket.id",
      )
      .select("ticket.id", "ticketId")
      .addSelect("COUNT(DISTINCT message.id)", "messages")
      .addSelect("COUNT(DISTINCT attachment.id)", "attachments");

    if (tenantAdminId) {
      qb.where("ticket.adminId = :tenantAdminId", {
        tenantAdminId,
      });
    }

    this.applyAdminFilters(qb, q, {
      skipAdminId: Boolean(tenantAdminId),
    });

    qb.groupBy("ticket.id");

    const rows = await qb.getRawMany<{
      ticketId: string;
      messages: string;
      attachments: string;
    }>();

    return new Map(
      rows.map((row) => [
        row.ticketId,
        {
          messages: Number(row.messages),
          attachments: Number(row.attachments),
        },
      ]),
    );
  }

  async exportTickets(me: any, q?: any) {
    const qb = this.adminListQuery(q);

    const [tickets, counts] = await Promise.all([
      qb
        .leftJoinAndSelect("ticket.solvedByUser", "solvedByUser")
        .leftJoinAndSelect("ticket.closedByUser", "closedByUser")
        .limit(10_000)
        .getMany(),

      this.getCountsForTickets(q, null),
    ]);

    const exportData = tickets.map((t) => ({
      id: t.id,
      title: t.title,
      tenantName: t.admin?.name ?? "",
      tenantEmail: t.admin?.email ?? "",
      openedBy: t.createdByUser?.name ?? "",
      openedByEmail: t.createdByUser?.email ?? "",
      assignedSupport: t.assignedSupportUser?.name ?? "",
      status: t.status,
      priority: t.priority,
      messagesCount: counts.get(t.id)?.messages ?? 0,
      attachmentsCount: counts.get(t.id)?.attachments ?? 0,
      unreadUserCount: t.unreadUserCount,
      unreadSupportCount: t.unreadSupportCount,
      lastMessageAt: t.lastMessageAt,
      solvedAt: t.solved_at,
      solvedBy: t.solvedByUser?.name ?? "",
      closedAt: t.closed_at,
      closedBy: t.closedByUser?.name ?? "",
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Support Tickets");

    worksheet.columns = [
      {
        header: this.t("domains.support_tickets.excel_header_ticket_id"),
        key: "id",
        width: 40,
      },
      {
        header: this.t("domains.support_tickets.excel_header_title"),
        key: "title",
        width: 35,
      },
      {
        header: this.t("domains.support_tickets.excel_header_tenant_name"),
        key: "tenantName",
        width: 24,
      },
      {
        header: this.t("domains.support_tickets.excel_header_tenant_email"),
        key: "tenantEmail",
        width: 30,
      },
      {
        header: this.t("domains.support_tickets.excel_header_opened_by"),
        key: "openedBy",
        width: 24,
      },
      {
        header: this.t("domains.support_tickets.excel_header_opened_by_email"),
        key: "openedByEmail",
        width: 30,
      },
      {
        header: this.t("domains.support_tickets.excel_header_assigned_support"),
        key: "assignedSupport",
        width: 24,
      },
      {
        header: this.t("domains.support_tickets.excel_header_status"),
        key: "status",
        width: 18,
      },
      {
        header: this.t("domains.support_tickets.excel_header_priority"),
        key: "priority",
        width: 16,
      },
      {
        header: this.t("domains.support_tickets.excel_header_messages_count"),
        key: "messagesCount",
        width: 18,
      },
      {
        header: this.t(
          "domains.support_tickets.excel_header_attachments_count",
        ),
        key: "attachmentsCount",
        width: 18,
      },
      {
        header: this.t(
          "domains.support_tickets.excel_header_unread_user_count",
        ),
        key: "unreadUserCount",
        width: 18,
      },
      {
        header: this.t(
          "domains.support_tickets.excel_header_unread_support_count",
        ),
        key: "unreadSupportCount",
        width: 18,
      },
      {
        header: this.t("domains.support_tickets.excel_header_last_message_at"),
        key: "lastMessageAt",
        width: 22,
      },
      {
        header: this.t("domains.support_tickets.excel_header_solved_at"),
        key: "solvedAt",
        width: 22,
      },
      {
        header: this.t("domains.support_tickets.excel_header_solved_by"),
        key: "solvedBy",
        width: 22,
      },
      {
        header: this.t("domains.support_tickets.excel_header_closed_at"),
        key: "closedAt",
        width: 22,
      },
      {
        header: this.t("domains.support_tickets.excel_header_closed_by"),
        key: "closedBy",
        width: 22,
      },
      {
        header: this.t("domains.support_tickets.excel_header_created_at"),
        key: "created_at",
        width: 22,
      },
      {
        header: this.t("domains.support_tickets.excel_header_updated_at"),
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

  async exportTenantTickets(me: any, q?: any) {
    const adminId = tenantId(me);

    if (!adminId) {
      throw new BadRequestException(this.t("common.missing_admin_id"));
    }

    const qb = this.ticketRepo
      .createQueryBuilder("ticket")
      .leftJoinAndSelect("ticket.assignedSupportUser", "assignedSupportUser")
      .leftJoinAndSelect("ticket.solvedByUser", "solvedByUser")
      .leftJoinAndSelect("ticket.closedByUser", "closedByUser")
      .where("ticket.adminId = :adminId", { adminId });

    this.applyAdminFilters(qb, q, {
      skipAdminId: true,
    });

    if (q?.search) {
      qb.andWhere(
        new Brackets((b) => {
          b.where("ticket.title ILIKE :search", {
            search: `%${q.search}%`,
          });
        }),
      );
    }

    const [tickets, counts] = await Promise.all([
      qb.limit(10000).getMany(),
      this.getCountsForTickets(q, adminId, true),
    ]);

    const exportData = tickets.map((t) => ({
      id: t.id,
      title: t.title,
      assignedSupport: t.assignedSupportUser?.name ?? "",
      status: t.status,
      priority: t.priority,
      messagesCount: counts.get(t.id)?.messages ?? 0,
      attachmentsCount: counts.get(t.id)?.attachments ?? 0,
      unreadUserCount: t.unreadUserCount,
      unreadSupportCount: t.unreadSupportCount,
      lastMessageAt: t.lastMessageAt,
      solvedAt: t.solved_at,
      solvedBy: t.solvedByUser?.name ?? "",
      closedAt: t.closed_at,
      closedBy: t.closedByUser?.name ?? "",
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Support Tickets");

    worksheet.columns = [
      {
        header: this.t("domains.support_tickets.excel_header_ticket_id"),
        key: "id",
        width: 40,
      },
      {
        header: this.t("domains.support_tickets.excel_header_title"),
        key: "title",
        width: 35,
      },
      {
        header: this.t("domains.support_tickets.excel_header_assigned_support"),
        key: "assignedSupport",
        width: 25,
      },
      {
        header: this.t("domains.support_tickets.excel_header_status"),
        key: "status",
        width: 18,
      },
      {
        header: this.t("domains.support_tickets.excel_header_priority"),
        key: "priority",
        width: 18,
      },
      {
        header: this.t("domains.support_tickets.excel_header_messages_count"),
        key: "messagesCount",
        width: 18,
      },
      {
        header: this.t(
          "domains.support_tickets.excel_header_attachments_count",
        ),
        key: "attachmentsCount",
        width: 18,
      },
      {
        header: this.t(
          "domains.support_tickets.excel_header_unread_user_count",
        ),
        key: "unreadUserCount",
        width: 18,
      },
      {
        header: this.t(
          "domains.support_tickets.excel_header_unread_support_count",
        ),
        key: "unreadSupportCount",
        width: 18,
      },
      {
        header: this.t("domains.support_tickets.excel_header_last_message_at"),
        key: "lastMessageAt",
        width: 22,
      },
      {
        header: this.t("domains.support_tickets.excel_header_solved_at"),
        key: "solvedAt",
        width: 22,
      },
      {
        header: this.t("domains.support_tickets.excel_header_solved_by"),
        key: "solvedBy",
        width: 22,
      },
      {
        header: this.t("domains.support_tickets.excel_header_closed_at"),
        key: "closedAt",
        width: 22,
      },
      {
        header: this.t("domains.support_tickets.excel_header_closed_by"),
        key: "closedBy",
        width: 22,
      },
      {
        header: this.t("domains.support_tickets.excel_header_created_at"),
        key: "created_at",
        width: 22,
      },
      {
        header: this.t("domains.support_tickets.excel_header_updated_at"),
        key: "updated_at",
        width: 22,
      },
    ];

    worksheet.getRow(1).font = {
      bold: true,
      color: {
        argb: "FFFFFFFF",
      },
    };

    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: {
        argb: "FF6C5CE7",
      },
    };

    exportData.forEach((row) => worksheet.addRow(row));

    return await workbook.xlsx.writeBuffer();
  }

  /* ================= Admin: delete + bulk ================= */

  async delete(me: any, ticketId: string) {
    this.requireSuperAdmin(me);
    await this.requireTicket(ticketId);
    await this.ticketRepo.softDelete(ticketId);
    return {
      success: true,
      message: this.t("domains.support_tickets.ticket_deleted_successfully"),
    };
  }

  async bulkAssign(me: any, dto: any) {
    this.requireSuperAdmin(me);

    const { ticketIds, assignedSupportUserId } = dto;

    const user = await this.userRepo.findOne({
      where: { id: assignedSupportUserId } as any,
    });

    if (!user) {
      throw new BadRequestException(
        this.t("domains.support_tickets.support_user_not_found"),
      );
    }

    const tickets = await this.ticketRepo.find({
      where: { id: In(ticketIds) } as any,
      select: {
        id: true,
        adminId: true,
        createdByUserId: true,
        status: true,
        title: true,
      },
    });

    const invalidTickets = tickets.filter((t) =>
      [SupportTicketStatus.CLOSED, SupportTicketStatus.CANCELED].includes(
        t.status,
      ),
    );

    if (invalidTickets.length) {
      throw new BadRequestException(
        this.t(
          "domains.support_tickets.cannot_assign_closed_or_canceled_ticket",
        ),
      );
    }

    const openTicketIds = tickets
      .filter((t) => t.status === SupportTicketStatus.OPEN)
      .map((t) => t.id);

    await Promise.all([
      this.ticketRepo.update({ id: In(ticketIds) } as any, {
        assignedSupportUserId,
      }),

      openTicketIds.length
        ? this.ticketRepo.update({ id: In(openTicketIds) } as any, {
            status: SupportTicketStatus.IN_PROGRESS,
          })
        : Promise.resolve(),

      Promise.all(
        tickets.map((ticket) => {
          ticket.assignedSupportUserId = assignedSupportUserId;
          if (
            ticket.status === SupportTicketStatus.OPEN &&
            openTicketIds.includes(ticket.id)
          ) {
            ticket.status = SupportTicketStatus.IN_PROGRESS;
          }
          return Promise.all([
            this.logActivity(
              ticket.id,
              ticket.adminId,
              me.id,
              SupportTicketActivityType.ASSIGNED,
              { assignedSupportUserId },
            ),
            this.notifyUsers(
              ticket.id,
              [assignedSupportUserId],
              me.id,
              NotificationType.SUPPORT_TICKET_ASSIGNED,
              "domains.support_tickets.ticket_assigned_title",
              "domains.support_tickets.ticket_assigned_message",
              { ticketTitle: ticket.title },
            ),
            this.appGateway.emitSupportTicketUpdated(
              this.uniqueUserIds([
                ticket.adminId,
                ticket.createdByUserId,
                assignedSupportUserId,
              ]),
              ticket,
            ),
          ]);
        }),
      ),
    ]);

    return {
      success: true,
      message: this.t("domains.support_tickets.bulk_updated_successfully"),
      updated: tickets.length,
    };
  }

  async bulkStatus(me: any, dto: any) {
    this.requireSuperAdmin(me);

    const { ticketIds, status, reason } = dto;

    const tickets = await this.ticketRepo.find({
      where: { id: In(ticketIds) } as any,
    });

    await Promise.all(
      tickets.map((ticket) => this.applyStatus(ticket, me, status, reason)),
    );

    return {
      success: true,
      message: this.t("domains.support_tickets.bulk_updated_successfully"),
      updated: tickets.length,
    };
  }

  async bulkPriority(me: any, dto: any) {
    this.requireSuperAdmin(me);

    const { ticketIds, priority } = dto;

    const tickets = await this.ticketRepo.find({
      where: { id: In(ticketIds) } as any,
      select: {
        id: true,
        adminId: true,
        createdByUserId: true,
        title: true,
        assignedSupportUserId: true,
      },
    });

    await Promise.all([
      this.ticketRepo.update({ id: In(ticketIds) } as any, { priority }),

      Promise.all(
        tickets.map(async (ticket) => {
          ticket.priority = priority;
          await this.logActivity(
            ticket.id,
            ticket.adminId,
            me.id,
            SupportTicketActivityType.PRIORITY_CHANGED,
            { newPriority: priority },
          );
          await this.notifyUsers(
            ticket.id,
            await this.supportRecipientIds(ticket),
            me.id,
            NotificationType.SUPPORT_TICKET_PRIORITY_CHANGED,
            "domains.support_tickets.ticket_priority_changed_title",
            "domains.support_tickets.ticket_priority_changed_message",
            {
              ticketTitle: ticket.title,
              priority: this.priorityLabel(priority),
            },
          );
          this.appGateway.emitSupportTicketUpdated(
            this.uniqueUserIds([
              ...this.tenantRecipientIds(ticket),
              ...(await this.supportRecipientIds(ticket)),
            ]),
            ticket,
          );
        }),
      ),
    ]);

    return {
      success: true,
      message: this.t("domains.support_tickets.bulk_updated_successfully"),
      updated: tickets.length,
    };
  }
}
