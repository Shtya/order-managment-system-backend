import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  OrderEntity,
  OrderInternalNoteEntity,
} from "entities/order.entity";
import { User } from "entities/user.entity";
import { tenantId } from "src/category/category.service";
import { isSuperAdmin } from "common/healpers";
import { TranslationService } from "common/translation.service";
import { DateFilterUtil } from "common/date-filter.util";
import { AppGateway } from "common/app.gateway";
import { CreateOrderInternalNoteDto } from "dto/order.dto";

@Injectable()
export class OrderInternalNotesService {
  constructor(
    @InjectRepository(OrderInternalNoteEntity)
    private noteRepo: Repository<OrderInternalNoteEntity>,
    @InjectRepository(OrderEntity)
    private orderRepo: Repository<OrderEntity>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private translations: TranslationService,
    private appGateway: AppGateway,
  ) {}

  private parseCursor(raw: any): { value: string; id: string } | undefined {
    if (!raw) return undefined;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        return undefined;
      }
    }
    if (raw?.value && raw?.id) {
      return { value: raw.value, id: raw.id };
    }
    return undefined;
  }

  private async findTenantOrder(me: any, orderId: string) {
    const superAdmin = isSuperAdmin(me);
    const adminId = tenantId(me);

    const order = await this.orderRepo.findOne({
      where: { id: orderId } as any,
    });

    if (!order) {
      throw new NotFoundException(
        this.translations.t("domains.orders.order_not_found"),
      );
    }

    if (!superAdmin && order.adminId !== adminId) {
      throw new NotFoundException(
        this.translations.t("domains.orders.order_not_found"),
      );
    }

    return order;
  }

  private async tenantUserIds(adminId: string): Promise<string[]> {
    const users = await this.userRepo.find({
      where: [{ id: adminId }, { adminId }] as any,
      select: { id: true },
    });
    return [...new Set(users.map((u) => u.id).filter(Boolean))];
  }

  private isUnreadForMe(
    note: OrderInternalNoteEntity,
    meId: string,
    lastReadAt: Record<string, string> | null | undefined,
  ) {
    if (String(note.authorUserId) === String(meId)) return false;
    const lastRead = lastReadAt?.[meId];
    if (!lastRead) return true;
    return new Date(note.created_at).getTime() > new Date(lastRead).getTime();
  }

  private withUnreadFlag(
    note: OrderInternalNoteEntity,
    meId: string,
    lastReadAt: Record<string, string> | null | undefined,
  ) {
    return {
      ...note,
      isUnreadForMe: this.isUnreadForMe(note, meId, lastReadAt),
    };
  }

  async list(me: any, orderId: string, q?: any) {
    const order = await this.findTenantOrder(me, orderId);
    const adminId = order.adminId;

    const limit = Number(q?.limit ?? 50);
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
    const cursor = this.parseCursor(q?.cursor);

    const qb = this.noteRepo
      .createQueryBuilder("note")
      .leftJoinAndSelect("note.author", "author")
      .where("note.orderId = :orderId", { orderId })
      .andWhere("note.adminId = :adminId", { adminId });

    DateFilterUtil.applyToQueryBuilder(
      qb,
      "note.created_at",
      q?.startDate,
      q?.endDate,
    );

    if (cursor) {
      const operator = sortDir === "DESC" ? "<" : ">";
      qb.andWhere(
        `(note.created_at, note.id) ${operator} (:cursorValue, :cursorId)`,
        {
          cursorValue: cursor.value,
          cursorId: cursor.id,
        },
      );
    }

    qb.orderBy("note.created_at", sortDir);
    qb.addOrderBy("note.id", sortDir);

    const rows = await qb.take(limit + 1).getMany();
    const hasMore = rows.length > limit;
    const records = hasMore ? rows.slice(0, limit) : rows;
    const last = records[records.length - 1];
    const lastReadAt = order.internalNotesLastReadAt || {};

    return {
      records: records.map((note) =>
        this.withUnreadFlag(note, me.id, lastReadAt),
      ),
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
      myUnreadCount: Number(order.internalNotesUnreadCounts?.[me.id] || 0),
    };
  }

  async add(me: any, orderId: string, dto: CreateOrderInternalNoteDto) {
    const body = String(dto?.body || "").trim();
    if (!body) {
      throw new BadRequestException(
        this.translations.t("domains.orders.internal_note_empty"),
      );
    }

    const order = await this.findTenantOrder(me, orderId);
    const adminId = order.adminId;
    const authorId = String(me.id);

    const saved = await this.noteRepo.save(
      this.noteRepo.create({
        adminId,
        orderId: order.id,
        authorUserId: authorId,
        body,
        authorName: me.name || "",
        authorRoleName: me.role?.name || null,
      }),
    );

    const tenantIds = await this.tenantUserIds(adminId);
    const counts = { ...(order.internalNotesUnreadCounts || {}) };
    for (const id of tenantIds) {
      if (id === authorId) {
        counts[id] = 0;
      } else {
        counts[id] = (Number(counts[id]) || 0) + 1;
      }
    }

    const lastReadAt = { ...(order.internalNotesLastReadAt || {}) };
    lastReadAt[authorId] = new Date().toISOString();

    order.lastInternalNoteId = saved.id;
    order.lastInternalNoteAt = saved.created_at;
    order.internalNotesUnreadCounts = counts;
    order.internalNotesLastReadAt = lastReadAt;
    await this.orderRepo.save(order);

    const withAuthor = await this.noteRepo.findOne({
      where: { id: saved.id } as any,
      relations: {
        author: true
      },
    });

    const note = this.withUnreadFlag(
      withAuthor || saved,
      authorId,
      lastReadAt,
    );

    this.appGateway.emitOrderInternalNoteCreated(tenantIds, {
      note,
      orderId: order.id,
      lastInternalNote: note,
      internalNotesUnreadCounts: counts,
    });

    return {
      success: true,
      data: note,
    };
  }

  async markRead(me: any, orderId: string) {
    const order = await this.findTenantOrder(me, orderId);
    const userId = String(me.id);
    const counts = { ...(order.internalNotesUnreadCounts || {}) };
    const lastReadAt = { ...(order.internalNotesLastReadAt || {}) };

    counts[userId] = 0;
    lastReadAt[userId] = new Date().toISOString();

    order.internalNotesUnreadCounts = counts;
    order.internalNotesLastReadAt = lastReadAt;
    await this.orderRepo.save(order);

    const tenantIds = await this.tenantUserIds(order.adminId);
    this.appGateway.emitOrderInternalNoteRead(tenantIds, {
      orderId: order.id,
      readByUserId: userId,
    });

    return {
      success: true,
      myUnreadCount: 0,
    };
  }
}
