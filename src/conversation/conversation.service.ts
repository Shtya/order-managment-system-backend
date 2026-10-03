import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, DataSource, EntityManager, MoreThan, Repository } from "typeorm";
import {
  ConversationAiMode,
  ConversationEntity,
  ConversationStatus,
  MessageDirection,
  WhatsappMessageEntity,
} from "entities/whatsapp.entity";
import { CustomerEntity } from "entities/customers.entity";
import { CreateConversationDto } from "dto/whatsapp.dto";
import { CustomerService } from "../customer/customer.service";
import { AppGateway } from "common/app.gateway";
import { tenantId } from "src/category/category.service";
import { RequestTranslationService, TranslationService } from "common/translation.service";
import { AgentTurnQueueService } from "src/queue/queues/agent-turn.queue";
import { NotificationService } from "src/notifications/notification.service";
import { NotificationType } from "entities/notifications.entity";

@Injectable()
export class ConversationService {
  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(WhatsappMessageEntity)
    private readonly messageRepo: Repository<WhatsappMessageEntity>,
    private readonly customerService: CustomerService,
    private readonly appGateway: AppGateway,
    private readonly dataSource: DataSource,
    private readonly translations: TranslationService,
    private readonly requestTranslations: RequestTranslationService,
    private readonly notificationService: NotificationService,
    @Inject(forwardRef(() => AgentTurnQueueService))
    private readonly agentTurnQueue: AgentTurnQueueService,
  ) { }

  async getOrCreateConversation(me: any, payload: CreateConversationDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const customer = await this.customerService.getOrCreateCustomer(
        me,
        payload,
        manager,
      );

      return this.ensureConversationForCustomer(manager, adminId, customer.id);
    });
  }

  async getOrCreateConversationByCustomerId(me: any, customerId: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const customer = await manager.getRepository(CustomerEntity).findOne({
        where: { id: customerId, adminId },
      });
      if (!customer) {
        throw new NotFoundException(
          this.translations.t("domains.customer.not_found"),
        );
      }

      return this.ensureConversationForCustomer(manager, adminId, customer.id);
    });
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

      this.appGateway.emitNewConversation(adminId, finalConversation);

      return finalConversation;
    }

    // Already existed
    return await repo.findOne({
      where: {
        adminId,
        customerId,
      },
      relations: {
        customer: true,
        lastMessage: true
      },
    });
  }

  async createConversation(me: any, payload: CreateConversationDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const customer = await this.customerService.getOrCreateCustomer(
        me,
        payload,
        manager,
      );

      return this.ensureConversationForCustomer(manager, adminId, customer.id);
    });
  }

  async save(conversation: ConversationEntity) {
    const saved = await this.conversationRepo.save(conversation);
    return saved;
  }

  async getTabCounts(me: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const [unread, humanHandoff] = await Promise.all([
      this.conversationRepo.count({
        where: {
          adminId,
          unreadCount: MoreThan(0),
        },
      }),
      this.conversationRepo.count({
        where: {
          adminId,
          humanHandoff: true,
        },
      }),
    ]);

    return {
      unread,
      humanHandoff,
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

    const qb = this.conversationRepo
      .createQueryBuilder("conversation")
      .leftJoinAndSelect("conversation.customer", "customer")
      .leftJoinAndSelect("conversation.lastMessage", "lastMessage")
      .where("conversation.adminId = :adminId", { adminId });

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

    const sortCol = sortColumns[sortBy] || "conversation.lastMessageAt";
    if (cursor) {
      const operator = sortDir === "DESC" ? "<" : ">";

      qb.andWhere(
        `(${sortCol}, conversation.id) ${operator} (:cursorValue, :cursorId)`,
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
    const conversation = await this.conversationRepo.findOne({
      where: { id, adminId },
    });
    if (!conversation) {
      throw new NotFoundException(
        this.translations.t("domains.conversation.not_found"),
      );
    }
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
    const conversation = await this.conversationRepo.findOne({
      where: { id, adminId },
    });
    if (!conversation) {
      throw new NotFoundException(
        this.translations.t("domains.conversation.not_found"),
      );
    }
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
    reason?: string;
  }): Promise<{ ok: true; code: "ALREADY_HANDED_OFF" | "HANDED_OFF" }> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: input.conversationId, adminId: input.adminId },
      relations: { customer: true },
    });
    if (!conversation) {
      throw new NotFoundException(
        this.translations.t("domains.conversation.not_found"),
      );
    }
    if (conversation.humanHandoff) {
      return { ok: true, code: "ALREADY_HANDED_OFF" };
    }

    conversation.humanHandoff = true;
    const saved = await this.conversationRepo.save(conversation);
    this.emitConversationAi(saved);

    const customerName =
      conversation.customer?.name?.trim() ||
      conversation.customer?.phoneNumber ||
      "-";
    const phone = conversation.customer?.phoneNumber || "-";
    const args = {
      customerName,
      phone,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    };
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
        { args },
      ),
      relatedEntityType: "conversation",
      relatedEntityId: conversation.customerId,
    });

    return { ok: true, code: "HANDED_OFF" };
  }

  async cancelHumanHandoff(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }
    const conversation = await this.conversationRepo.findOne({
      where: { id, adminId },
    });
    if (!conversation) {
      throw new NotFoundException(
        this.translations.t("domains.conversation.not_found"),
      );
    }
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

    const conversation = await this.conversationRepo.findOne({
      where: { id, adminId },
      relations: {
        customer: true,

        messages: {
          account: true
        },

        lastMessage: true
      },
    });

    if (!conversation) {
      throw new NotFoundException(
        this.translations.t("domains.conversation.not_found"),
      );
    }

    return conversation;
  }
}
