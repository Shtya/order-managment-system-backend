import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, DataSource, EntityManager, In, Repository } from "typeorm";
import {
  ConversationAiMode,
  ConversationEntity,
  ConversationStatus,
  MessageDirection,
  WhatsappMessageEntity,
  WhatsappMessageType,
  UserWhatsappAccountAccessEntity,
  ConversationUserAccessEntity,
} from "entities/whatsapp.entity";
import { SystemRole, WhatsappAccessMode } from "entities/user.entity";
import { CustomerEntity } from "entities/customers.entity";
import { CreateConversationDto } from "dto/whatsapp.dto";
import { CustomerService } from "../customer/customer.service";
import { AppGateway } from "common/app.gateway";
import { tenantId } from "src/category/category.service";
import { RequestTranslationService, TranslationService } from "common/translation.service";
import { AgentTurnQueueService } from "src/queue/queues/agent-turn.queue";
import { NotificationService } from "src/notifications/notification.service";
import { NotificationType } from "entities/notifications.entity";
import { IssueService } from "src/issue/issue.service";
import { AgentEntity } from "entities/agent.entity";
import { IssuePriority } from "entities/issue.entity";

@Injectable()
export class ConversationService {
  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,
    @InjectRepository(UserWhatsappAccountAccessEntity)
    private readonly accessRepo: Repository<UserWhatsappAccountAccessEntity>,
    private readonly customerService: CustomerService,
    private readonly appGateway: AppGateway,
    private readonly dataSource: DataSource,
    private readonly translations: TranslationService,
    private readonly requestTranslations: RequestTranslationService,
    private readonly notificationService: NotificationService,
    @Inject(forwardRef(() => AgentTurnQueueService))
    private readonly agentTurnQueue: AgentTurnQueueService,
    @Inject(forwardRef(() => IssueService))
    private readonly issues: IssueService,
  ) { }

  private async allowedAccountIds(me: any): Promise<string[] | null> {
    if ([SystemRole.ADMIN, SystemRole.SUPER_ADMIN].includes(me?.role?.name) ||
      me?.whatsappAccessMode === WhatsappAccessMode.ALL) return null;
    const adminId = tenantId(me);
    const rows = await this.accessRepo.find({
      where: { adminId, userId: me.id },
      select: { whatsappAccountId: true },
    });
    return rows.map((row) => row.whatsappAccountId);
  }

  private async grantDirectConversationAccess(
    manager: EntityManager,
    me: any,
    adminId: string,
    conversationId: string,
  ) {
    if (!me?.id || me.adminId !== adminId) return;
    await manager
      .getRepository(ConversationUserAccessEntity)
      .createQueryBuilder()
      .insert()
      .values({ adminId, conversationId, userId: me.id })
      .orIgnore()
      .execute();
  }

  private async scopeCreatedConversation(
    manager: EntityManager,
    me: any,
    conversation: ConversationEntity,
  ) {
    if (!me?.adminId || me.whatsappAccessMode === WhatsappAccessMode.ALL) {
      return conversation;
    }
    const accessRows = await manager.getRepository(UserWhatsappAccountAccessEntity).find({
      where: { adminId: conversation.adminId, userId: me.id },
      select: { whatsappAccountId: true },
    });
    const allowedIds = accessRows.map((row) => row.whatsappAccountId);
    const lastMessage = allowedIds.length
      ? await manager.getRepository(WhatsappMessageEntity).findOne({
        where: {
          adminId: conversation.adminId,
          conversationId: conversation.id,
          accountId: In(allowedIds),
        },
        order: { createdAt: "DESC", id: "DESC" },
      })
      : null;
    conversation.lastMessage = lastMessage;
    conversation.lastMessageAt = lastMessage?.createdAt ?? conversation.createdAt;
    return conversation;
  }

  async getOrCreateConversation(me: any, payload: CreateConversationDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const customer = await this.customerService.getOrCreateCustomer(
        me,
        payload,
        manager,
      );

      const { conversation, created } = await this.ensureConversationForCustomer(manager, adminId, customer.id);
      await this.grantDirectConversationAccess(manager, me, adminId, conversation.id);
      return {
        conversation: await this.scopeCreatedConversation(manager, me, conversation),
        created,
      };
    });
    if (result.created) this.appGateway.emitNewConversation(adminId, result.conversation);
    return result.conversation;
  }

  async getOrCreateConversationByCustomerId(me: any, customerId: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const customer = await manager.getRepository(CustomerEntity).findOne({
        where: { id: customerId, adminId },
      });
      if (!customer) {
        throw new NotFoundException(
          this.translations.t("domains.customer.not_found"),
        );
      }

      const { conversation, created } = await this.ensureConversationForCustomer(manager, adminId, customer.id);
      await this.grantDirectConversationAccess(manager, me, adminId, conversation.id);
      return {
        conversation: await this.scopeCreatedConversation(manager, me, conversation),
        created,
      };
    });
    if (result.created) this.appGateway.emitNewConversation(adminId, result.conversation);
    return result.conversation;
  }

  private async ensureConversationForCustomer(
    manager: EntityManager,
    adminId: string,
    customerId: string,
  ) {
    const repo = manager.getRepository(ConversationEntity);

    // Try atomic insert (requires unique constraint on adminId + customerId)
    const insertResult = await repo
      .createQueryBuilder()
      .insert()
      .into(ConversationEntity)
      .values({
        adminId,
        customerId,
        status: ConversationStatus.OPEN,
      })
      .orIgnore()
      .returning("*")
      .execute();

    // This transaction created the conversation
    if (insertResult.raw?.length > 0) {
      const conversation = repo.create(
        insertResult.raw[0] as ConversationEntity,
      );

      const finalConversation = await repo.findOne({
        where: { id: conversation.id },
        relations: {
          customer: true,
          lastMessage: true
        },
      });

      return { conversation: finalConversation, created: true };
    }

    // Already existed
    const conversation = await repo.findOne({
      where: {
        adminId,
        customerId,
      },
      relations: {
        customer: true,
        lastMessage: true
      },
    });
    return { conversation, created: false };
  }

  async createConversation(me: any, payload: CreateConversationDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const customer = await this.customerService.getOrCreateCustomer(
        me,
        payload,
        manager,
      );

      const { conversation, created } = await this.ensureConversationForCustomer(manager, adminId, customer.id);
      await this.grantDirectConversationAccess(manager, me, adminId, conversation.id);
      return {
        conversation: await this.scopeCreatedConversation(manager, me, conversation),
        created,
      };
    });
    if (result.created) this.appGateway.emitNewConversation(adminId, result.conversation);
    return result.conversation;
  }

  async save(conversation: ConversationEntity) {
    const saved = await this.conversationRepo.save(conversation);
    return saved;
  }

  async getTabCounts(me: any, requestedAccountId?: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const accountId = String(requestedAccountId ?? "").trim();
    const allowedIds = await this.allowedAccountIds(me);
    if (accountId && accountId !== "all" && allowedIds && !allowedIds.includes(accountId)) {
      throw new NotFoundException(this.translations.t("domains.conversation.not_found"));
    }
    const scopedQuery = () => {
      const query = this.conversationRepo
        .createQueryBuilder("conversation")
        .where("conversation.adminId = :adminId", { adminId });

      if (accountId && accountId !== "all") {
        query.andWhere(
          `EXISTS (
            SELECT 1
            FROM "whatsapp_messages" account_message
            WHERE account_message."conversationId" = conversation.id
              AND account_message."adminId" = :adminId
              AND account_message."accountId" = :accountId
          )`,
          { accountId },
        );
      }
      if ((!accountId || accountId === "all") && allowedIds) {
        const scopes = [
          `EXISTS (SELECT 1 FROM "conversation_user_access" direct_access WHERE direct_access."conversationId" = conversation.id AND direct_access."adminId" = :adminId AND direct_access."userId" = :userId)`,
        ];
        if (allowedIds.length) {
          scopes.push(`EXISTS (SELECT 1 FROM "whatsapp_messages" allowed_message WHERE allowed_message."conversationId" = conversation.id AND allowed_message."adminId" = :adminId AND allowed_message."accountId" IN (:...allowedIds))`);
        }
        query.andWhere(`(${scopes.join(" OR ")})`, {
          userId: me.id,
          ...(allowedIds.length ? { allowedIds } : {}),
        });
      }

      return query;
    };

    const [all, unread, humanHandoff] = await Promise.all([
      scopedQuery().getCount(),
      scopedQuery().andWhere("conversation.unreadCount > 0").getCount(),
      scopedQuery().andWhere("conversation.humanHandoff = true").getCount(),
    ]);

    return {
      all,
      unread,
      humanHandoff,
    };
  }

  async getContactConversationStats(
    me: any,
    period?: { startDate: Date; endDate: Date },
  ) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    let effectivePeriod = period;
    if (!effectivePeriod) {
      const [bounds] = await this.dataSource.query(
        `
          SELECT
            LEAST(
              COALESCE(
                (SELECT MIN(customer."createdAt") FROM "customers" customer WHERE customer."adminId" = $1),
                NOW()
              ),
              COALESCE(
                (SELECT MIN(message."createdAt") FROM "whatsapp_messages" message WHERE message."adminId" = $1),
                NOW()
              )
            ) AS "startDate",
            NOW() AS "endDate"
        `,
        [adminId],
      );
      effectivePeriod = {
        startDate: new Date(bounds.startDate),
        endDate: new Date(bounds.endDate),
      };
    }

    const params = [
      adminId,
      effectivePeriod.startDate,
      effectivePeriod.endDate,
      WhatsappMessageType.REACTION,
      ConversationStatus.OPEN,
      ConversationStatus.ARCHIVED,
      "delivered",
    ];

    const [summaryRows, trendRows] = await Promise.all([
      this.dataSource.query(
        `
          WITH first_messages AS (
            SELECT
              m."conversationId",
              MIN(m."createdAt") AS "firstMessageAt"
            FROM "whatsapp_messages" m
            WHERE m."adminId" = $1
              AND m."conversationId" IS NOT NULL
              AND m."messageType" <> $4
            GROUP BY m."conversationId"
          ),
          active_conversations AS (
            SELECT DISTINCT m."conversationId"
            FROM "whatsapp_messages" m
            WHERE m."adminId" = $1
              AND m."conversationId" IS NOT NULL
              AND m."messageType" <> $4
              AND m."createdAt" BETWEEN $2 AND $3
          ),
          order_contacts AS (
            SELECT DISTINCT o."clientId"
            FROM "orders" o
            WHERE o."adminId" = $1
              AND o."clientId" IS NOT NULL
              AND o."deleted_at" IS NULL
          ),
          delivered_contacts AS (
            SELECT DISTINCT o."clientId"
            FROM "orders" o
            INNER JOIN "order_statuses" os ON os.id = o."statusId"
            WHERE o."adminId" = $1
              AND o."clientId" IS NOT NULL
              AND o."deleted_at" IS NULL
              AND os.code = $7
          ),
          contact_stats AS (
            SELECT
              COUNT(*) AS "total",
              COUNT(*) FILTER (WHERE customer."createdAt" BETWEEN $2 AND $3) AS "new",
              COUNT(*) FILTER (WHERE conversation.id IS NOT NULL) AS "withConversation",
              COUNT(*) FILTER (WHERE conversation.id IS NULL) AS "withoutConversation",
              COUNT(*) FILTER (WHERE customer."clientId" IS NOT NULL) AS "linkedToClient",
              COUNT(*) FILTER (WHERE customer."clientId" IS NULL) AS "unlinkedToClient",
              COUNT(*) FILTER (WHERE orders."clientId" IS NOT NULL) AS "withOrders",
              COUNT(*) FILTER (WHERE delivered."clientId" IS NOT NULL) AS "withDeliveredOrders"
            FROM "customers" customer
            LEFT JOIN "whatsapp_conversations" conversation
              ON conversation."adminId" = customer."adminId"
             AND conversation."customerId" = customer.id
            LEFT JOIN order_contacts orders ON orders."clientId" = customer."clientId"
            LEFT JOIN delivered_contacts delivered ON delivered."clientId" = customer."clientId"
            WHERE customer."adminId" = $1
          ),
          conversation_stats AS (
            SELECT
              COUNT(*) AS "total",
              COUNT(*) FILTER (WHERE first."conversationId" IS NOT NULL) AS "withMessages",
              COUNT(*) FILTER (WHERE first."conversationId" IS NULL) AS "withoutMessages",
              COUNT(*) FILTER (WHERE first."firstMessageAt" BETWEEN $2 AND $3) AS "new",
              COUNT(*) FILTER (WHERE active."conversationId" IS NOT NULL) AS "active",
              COUNT(*) FILTER (WHERE conversation.status = $5) AS "open",
              COUNT(*) FILTER (WHERE conversation.status = $6) AS "archived",
              COUNT(*) FILTER (WHERE conversation."unreadCount" > 0) AS "unread",
              COALESCE(SUM(conversation."unreadCount"), 0) AS "unreadMessages",
              COUNT(*) FILTER (WHERE conversation."humanHandoff" = TRUE) AS "humanHandoff",
              COUNT(*) FILTER (WHERE conversation."agentPausedUntil" > NOW()) AS "agentPaused"
            FROM "whatsapp_conversations" conversation
            LEFT JOIN first_messages first ON first."conversationId" = conversation.id
            LEFT JOIN active_conversations active ON active."conversationId" = conversation.id
            WHERE conversation."adminId" = $1
          )
          SELECT
            row_to_json(contact_stats) AS contacts,
            row_to_json(conversation_stats) AS conversations
          FROM contact_stats
          CROSS JOIN conversation_stats
        `,
        params,
      ),
      this.dataSource.query(
        `
          WITH days AS (
            SELECT generate_series(
              ($2::timestamptz AT TIME ZONE 'Africa/Cairo')::date,
              ($3::timestamptz AT TIME ZONE 'Africa/Cairo')::date,
              INTERVAL '1 day'
            )::date AS day
          ),
          first_messages AS (
            SELECT
              m."conversationId",
              MIN(m."createdAt") AS "firstMessageAt"
            FROM "whatsapp_messages" m
            WHERE m."adminId" = $1
              AND m."conversationId" IS NOT NULL
              AND m."messageType" <> $4
            GROUP BY m."conversationId"
          ),
          new_contacts AS (
            SELECT
              (customer."createdAt" AT TIME ZONE 'Africa/Cairo')::date AS day,
              COUNT(*) AS count
            FROM "customers" customer
            WHERE customer."adminId" = $1
              AND customer."createdAt" BETWEEN $2 AND $3
            GROUP BY 1
          ),
          new_conversations AS (
            SELECT
              (first."firstMessageAt" AT TIME ZONE 'Africa/Cairo')::date AS day,
              COUNT(*) AS count
            FROM first_messages first
            WHERE first."firstMessageAt" BETWEEN $2 AND $3
            GROUP BY 1
          ),
          active_conversations AS (
            SELECT
              (m."createdAt" AT TIME ZONE 'Africa/Cairo')::date AS day,
              COUNT(DISTINCT m."conversationId") AS count
            FROM "whatsapp_messages" m
            WHERE m."adminId" = $1
              AND m."conversationId" IS NOT NULL
              AND m."messageType" <> $4
              AND m."createdAt" BETWEEN $2 AND $3
            GROUP BY 1
          )
          SELECT
            TO_CHAR(days.day, 'YYYY-MM-DD') AS date,
            COALESCE(new_contacts.count, 0) AS "newContacts",
            COALESCE(new_conversations.count, 0) AS "newConversations",
            COALESCE(active_conversations.count, 0) AS "activeConversations"
          FROM days
          LEFT JOIN new_contacts ON new_contacts.day = days.day
          LEFT JOIN new_conversations ON new_conversations.day = days.day
          LEFT JOIN active_conversations ON active_conversations.day = days.day
          ORDER BY days.day ASC
        `,
        params.slice(0, 4),
      ),
    ]);

    const numericRecord = (value: Record<string, unknown> | undefined) =>
      Object.fromEntries(
        Object.entries(value ?? {}).map(([key, count]) => [key, Number(count ?? 0)]),
      );

    return {
      contacts: numericRecord(summaryRows[0]?.contacts),
      conversations: numericRecord(summaryRows[0]?.conversations),
      trend: trendRows.map((row: any) => ({
        date: row.date,
        newContacts: Number(row.newContacts ?? 0),
        newConversations: Number(row.newConversations ?? 0),
        activeConversations: Number(row.activeConversations ?? 0),
      })),
    };
  }

  async findAllPaginated(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const limit = Number(q?.limit ?? 50);
    const search = String(q?.search ?? "").trim();
    const accountId = String(q?.accountId ?? "").trim();
    const sortBy = String(q?.sortBy ?? "lastMessageAt"); // Default to lastMessageAt for chat
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    // Axios sends cursor[value]/cursor[id]; Nest does not nest those into q.cursor.
    const cursor =
      q?.cursor?.value != null && q?.cursor?.id != null
        ? { value: q.cursor.value, id: q.cursor.id }
        : q?.["cursor[value]"] != null && q?.["cursor[id]"] != null
          ? { value: q["cursor[value]"], id: q["cursor[id]"] }
          : undefined;

    const hasAccountFilter = !!accountId && accountId !== "all";
    const allowedIds = await this.allowedAccountIds(me);
    if (hasAccountFilter && allowedIds && !allowedIds.includes(accountId)) {
      throw new NotFoundException(this.translations.t("domains.conversation.not_found"));
    }
    const qb = this.conversationRepo
      .createQueryBuilder("conversation")
      .leftJoinAndSelect("conversation.customer", "customer")
      .where("conversation.adminId = :adminId", { adminId });

    if (hasAccountFilter) {
      qb.innerJoinAndMapOne(
        "conversation.lastMessage",
        WhatsappMessageEntity,
        "lastMessage",
        `lastMessage.id = (
          SELECT account_message.id
          FROM "whatsapp_messages" account_message
          WHERE account_message."conversationId" = conversation.id
            AND account_message."adminId" = :adminId
            AND account_message."accountId" = :accountId
          ORDER BY account_message."createdAt" DESC, account_message.id DESC
          LIMIT 1
        )`,
        { accountId },
      );
    } else {
      if (allowedIds?.length) {
        qb.leftJoinAndMapOne(
          "conversation.lastMessage",
          WhatsappMessageEntity,
          "lastMessage",
          `lastMessage.id = (
            SELECT allowed_message.id
            FROM "whatsapp_messages" allowed_message
            WHERE allowed_message."conversationId" = conversation.id
              AND allowed_message."adminId" = :adminId
              AND allowed_message."accountId" IN (:...allowedIds)
            ORDER BY allowed_message."createdAt" DESC, allowed_message.id DESC
            LIMIT 1
          )`,
          { allowedIds },
        );
      } else if (allowedIds) {
        qb.leftJoinAndMapOne(
          "conversation.lastMessage",
          WhatsappMessageEntity,
          "lastMessage",
          "1 = 0",
        );
      } else if (allowedIds === null) {
        qb.leftJoinAndSelect("conversation.lastMessage", "lastMessage");
      }
      if (allowedIds) {
        const scopes = [
          `EXISTS (SELECT 1 FROM "conversation_user_access" direct_access WHERE direct_access."conversationId" = conversation.id AND direct_access."adminId" = :adminId AND direct_access."userId" = :userId)`,
        ];
        if (allowedIds.length) {
          scopes.push(`EXISTS (SELECT 1 FROM "whatsapp_messages" allowed_message WHERE allowed_message."conversationId" = conversation.id AND allowed_message."adminId" = :adminId AND allowed_message."accountId" IN (:...allowedIds))`);
        }
        qb.andWhere(`(${scopes.join(" OR ")})`, {
          userId: me.id,
          ...(allowedIds.length ? { allowedIds } : {}),
        });
      }
    }

    // Filters
    if (q?.status) {
      qb.andWhere("conversation.status = :status", { status: q.status });
    }

    if (q?.customerId) {
      qb.andWhere("conversation.customerId = :customerId", {
        customerId: q.customerId,
      });
    }

    if (q?.unreadOnly === "true" || q?.unreadOnly === true) {
      qb.andWhere("conversation.unreadCount > 0");
    }

    if (q?.humanHandoffOnly === "true" || q?.humanHandoffOnly === true) {
      qb.andWhere("conversation.humanHandoff = true");
    }

    // Search (by customer name or phone number)
    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("customer.name ILIKE :s", { s: `%${search}%` }).orWhere(
            "customer.phoneNumber ILIKE :s",
            { s: `%${search}%` },
          );
        }),
      );
    }

    // Cursor Pagination Logic
    const sortColumns: Record<string, string> = {
      createdAt: "conversation.createdAt",
      updatedAt: "conversation.updatedAt",
      lastMessageAt: "conversation.lastMessageAt",
      status: "conversation.status",
    };

    const hasScopedLastMessage = hasAccountFilter || allowedIds !== null;
    const scopedLastMessageSort =
      "COALESCE(lastMessage.createdAt, conversation.createdAt)";
    const cursorSortCol =
      hasScopedLastMessage && sortBy === "lastMessageAt"
        ? scopedLastMessageSort
        : sortColumns[sortBy] || "conversation.lastMessageAt";
    const sortCol =
      hasScopedLastMessage && sortBy === "lastMessageAt"
        ? "scopedLastMessageAt"
        : cursorSortCol;
    if (sortCol === "scopedLastMessageAt") {
      // TypeORM cannot parse a COALESCE expression as an alias while building
      // its pagination query, so select it under a stable order-by alias.
      qb.addSelect(scopedLastMessageSort, "scopedLastMessageAt");
    }
    if (cursor) {
      const operator = sortDir === "DESC" ? "<" : ">";

      qb.andWhere(
        `(${cursorSortCol}, conversation.id) ${operator} (:cursorValue, :cursorId)`,
        {
          cursorValue: cursor.value,
          cursorId: cursor.id,
        },
      );
    }

    // Always sort by primary column AND id as tie-breaker
    qb.orderBy(sortCol, sortDir);
    qb.addOrderBy("conversation.id", sortDir);

    const recordsWithExtra = await qb.take(limit + 1).getMany();
    if (hasScopedLastMessage) {
      recordsWithExtra.forEach((record) => {
        record.lastMessage = record.lastMessage ?? null;
        record.lastMessageAt = record.lastMessage?.createdAt ?? record.createdAt;
      });
    }
    const hasMore = recordsWithExtra.length > limit;
    const records = hasMore
      ? recordsWithExtra.slice(0, limit)
      : recordsWithExtra;

    return {
      records,
      hasMore,
      limit,
      nextCursor: hasMore
        ? {
          value: records?.[records.length - 1]?.[sortBy],
          id: records?.[records.length - 1]?.id,
        }
        : undefined,
      sortBy,
      sortDir,
    };
  }

  async updateAi(me: any, id: string, aiMode: ConversationAiMode) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }
    const conversation = await this.findOne(me, id);
    conversation.aiMode = aiMode;
    return this.conversationRepo.save(conversation);
  }

  /** Ends the employee pause and runs catch-up for unanswered customer messages. */
  async resumeAgent(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }
    const conversation = await this.findOne(me, id);
    conversation.agentPausedUntil = null;
    const saved = await this.conversationRepo.save(conversation);
    this.emitConversationAi(saved);
    const lastInbound = await this.messageRepo.findOne({
      where: {
        adminId,
        conversationId: saved.id,
        direction: MessageDirection.INBOUND,
      },
      order: { createdAt: "DESC" },
      select: { accountId: true },
    });
    await this.agentTurnQueue.schedulePauseCatchup(
      {
        adminId,
        accountId: lastInbound?.accountId ?? null,
        conversationId: saved.id,
      },
      new Date(),
    );
    return saved;
  }

  async startHumanHandoff(input: {
    adminId: string;
    conversationId: string;
    agentId: string;
    title: string;
    description: string;
    causeId?: string | null;
    orderId?: string | null;
    priority?: IssuePriority;
  }): Promise<{
    ok: true;
    code: "ALREADY_HANDED_OFF" | "HANDED_OFF" | "ISSUE_CREATED";
    issueId?: string;
    humanHandoff: boolean;
  }> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: input.conversationId, adminId: input.adminId },
      relations: { customer: true },
    });
    if (!conversation) {
      throw new NotFoundException(
        this.translations.t("domains.conversation.not_found"),
      );
    }
    const alreadyOpen = await this.issues.hasOpenConversationIssue(
      input.adminId,
      input.conversationId,
    );
    if (conversation.humanHandoff || alreadyOpen) {
      return {
        ok: true,
        code: "ALREADY_HANDED_OFF",
        humanHandoff: true,
      };
    }

    const agent = await this.dataSource.getRepository(AgentEntity).findOne({
      where: { id: input.agentId, adminId: input.adminId },
    });
    if (!agent?.handoffAssignedRoleId) {
      throw new BadRequestException(
        this.translations.t("domains.agents.handoff_role_required"),
      );
    }

    const causeId = await this.issues.resolveHandoffCauseId(
      input.adminId,
      input.causeId,
    );
    const { issue, silencesAgent } = await this.issues.createFromAgentHandoff({
      adminId: input.adminId,
      conversationId: conversation.id,
      agent,
      title: input.title,
      description: input.description,
      causeId,
      orderId: input.orderId,
      priority: input.priority,
    });

    if (silencesAgent && !conversation.humanHandoff) {
      conversation.humanHandoff = true;
      const saved = await this.conversationRepo.save(conversation);
      this.emitConversationAi(saved);
      const customerName =
        conversation.customer?.name?.trim() ||
        conversation.customer?.phoneNumber ||
        "-";
      const phone = conversation.customer?.phoneNumber || "-";
      await this.notificationService.create({
        userId: input.adminId,
        type: NotificationType.HUMAN_HANDOFF,
        title: await this.requestTranslations.tAsync(
          "domains.conversation.human_handoff_title",
          input.adminId,
        ),
        message: await this.requestTranslations.tAsync(
          "domains.conversation.human_handoff_message",
          input.adminId,
          {
            args: {
              customerName,
              phone,
              ...(input.title.trim() ? { reason: input.title.trim() } : {}),
            },
          },
        ),
        relatedEntityType: "conversation",
        relatedEntityId: conversation.customerId,
      });
    }

    return {
      ok: true,
      code: silencesAgent ? "HANDED_OFF" : "ISSUE_CREATED",
      issueId: issue.id,
      humanHandoff: silencesAgent,
    };
  }

  async cancelHumanHandoff(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }
    const conversation = await this.findOne(me, id);
    await this.issues.solveOpenConversationIssues(adminId, id, me.id);
    conversation.humanHandoff = false;
    conversation.agentPausedUntil = null;
    const saved = await this.conversationRepo.save(conversation);
    this.emitConversationAi(saved);
    return saved;
  }

  private emitConversationAi(conversation: ConversationEntity) {
    this.appGateway.emitConversationAi(conversation.adminId, {
      conversationId: conversation.id,
      humanHandoff: !!conversation.humanHandoff,
      agentPausedUntil: conversation.agentPausedUntil ?? null,
    });
  }

  async findOne(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const allowedIds = await this.allowedAccountIds(me);
    const qb = this.conversationRepo
      .createQueryBuilder("conversation")
      .leftJoinAndSelect("conversation.customer", "customer")
      .where("conversation.id = :id", { id })
      .andWhere("conversation.adminId = :adminId", { adminId });

    if (allowedIds?.length) {
      qb.leftJoinAndMapOne(
        "conversation.lastMessage",
        WhatsappMessageEntity,
        "lastMessage",
        `lastMessage.id = (
          SELECT allowed_message.id
          FROM "whatsapp_messages" allowed_message
          WHERE allowed_message."conversationId" = conversation.id
            AND allowed_message."adminId" = :adminId
            AND allowed_message."accountId" IN (:...allowedIds)
          ORDER BY allowed_message."createdAt" DESC, allowed_message.id DESC
          LIMIT 1
        )`,
        { allowedIds },
      );
    } else if (allowedIds === null) {
      qb.leftJoinAndSelect("conversation.lastMessage", "lastMessage");
    }

    if (allowedIds) {
      const scopes = [
        `EXISTS (SELECT 1 FROM "conversation_user_access" direct_access WHERE direct_access."conversationId" = conversation.id AND direct_access."adminId" = :adminId AND direct_access."userId" = :userId)`,
      ];
      if (allowedIds.length) {
        scopes.push(`EXISTS (SELECT 1 FROM "whatsapp_messages" allowed_message WHERE allowed_message."conversationId" = conversation.id AND allowed_message."adminId" = :adminId AND allowed_message."accountId" IN (:...allowedIds))`);
      }
      qb.andWhere(`(${scopes.join(" OR ")})`, {
        userId: me.id,
        ...(allowedIds.length ? { allowedIds } : {}),
      });
    }

    const conversation = await qb.getOne();

    if (!conversation) {
      throw new NotFoundException(
        this.translations.t("domains.conversation.not_found"),
      );
    }

    if (allowedIds) {
      conversation.lastMessage = conversation.lastMessage ?? null;
      conversation.lastMessageAt = conversation.lastMessage?.createdAt ?? conversation.createdAt;
    }

    return conversation;
  }
}
