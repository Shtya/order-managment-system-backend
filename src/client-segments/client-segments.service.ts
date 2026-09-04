import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import * as ExcelJS from "exceljs";
import {
  ClientSegmentEntity,
  ClientSegmentRecipientEntity,
  ClientSegmentStatus,
  ClientSegmentType,
} from "entities/clients-segments.entity";
import {
  CreateClientSegmentDto,
  UpdateClientSegmentDto,
} from "dto/client-segment.dto";
import { TranslationService } from "common/translation.service";
import { tenantId } from "src/category/category.service";
import { AudienceService } from "src/audience/audience.service";
import {
  ClientAudienceFilter,
  ClientAudienceRecipient,
} from "common/client-audience-filter.types";

@Injectable()
export class ClientSegmentsService {
  constructor(
    @InjectRepository(ClientSegmentEntity)
    private readonly segmentRepo: Repository<ClientSegmentEntity>,
    @InjectRepository(ClientSegmentRecipientEntity)
    private readonly recipientRepo: Repository<ClientSegmentRecipientEntity>,
    private readonly audienceService: AudienceService,
    private readonly translations: TranslationService,
    private readonly dataSource: DataSource,
  ) { }

  private adminIdOf(me: any): string {
    const id = tenantId(me);
    if (!id)
      throw new BadRequestException(this.translations.t("common.missing_admin_id"));
    return id;
  }

  // ──────────────────────────────────────────────────────────────
  // List / Get
  // ──────────────────────────────────────────────────────────────

  async list(me: any, q: any) {
    const adminId = this.adminIdOf(me);
    const qb = this.segmentRepo
      .createQueryBuilder("seg")
      .where("seg.adminId = :adminId", { adminId });

    if (q?.status) qb.andWhere("seg.status = :status", { status: q.status });
    if (q?.type) qb.andWhere("seg.type = :type", { type: q.type });
    if (q?.search) {
      qb.andWhere("seg.name ILIKE :search", { search: `%${q.search}%` });
    }

    qb.orderBy("seg.createdAt", "DESC");

    const page = Math.max(1, parseInt(q?.page) || 1);
    const limit = Math.min(100, parseInt(q?.limit) || 20);
    qb.skip((page - 1) * limit).take(limit);

    const [items, total] = await qb.getManyAndCount();
    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records: items,
    };
  }

  async get(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const seg = await this.segmentRepo.findOne({ where: { id, adminId } });
    if (!seg) throw new NotFoundException(this.translations.t("domains.client_segments.not_found"));
    return seg;
  }

  // ──────────────────────────────────────────────────────────────
  // Create / Update
  // ──────────────────────────────────────────────────────────────

  async create(me: any, dto: CreateClientSegmentDto) {
    const adminId = this.adminIdOf(me);
    await this.ensureUniqueName(adminId, dto.name);

    const seg = this.segmentRepo.create({
      adminId,
      name: dto.name,
      description: dto.description,
      type: dto.type ?? ClientSegmentType.DYNAMIC,
      audienceFilter: dto.audienceFilter as any,
    });

    const saved = await this.segmentRepo.save(seg);

    // Kick off an estimate right away
    try {
      saved.estimatedRecipientsCount = await this.audienceService.countRecipients(
        adminId,
        saved.audienceFilter,
      );
      await this.segmentRepo.update(saved.id, {
        estimatedRecipientsCount: saved.estimatedRecipientsCount,
      });
    } catch (_) {
      // non-fatal
    }

    return saved;
  }

  async update(me: any, id: string, dto: UpdateClientSegmentDto) {
    const adminId = this.adminIdOf(me);
    const seg = await this.segmentRepo.findOne({ where: { id, adminId } });
    if (!seg) throw new NotFoundException(this.translations.t("domains.client_segments.not_found"));
    const shouldRefreshEstimate = dto.audienceFilter !== undefined;

    if (seg.type === ClientSegmentType.FROZEN && dto.audienceFilter) {
      throw new BadRequestException(
        this.translations.t("domains.client_segments.cannot_edit_filter_of_frozen"),
      );
    }

    if (dto.name !== undefined && dto.name !== seg.name) {
      await this.ensureUniqueName(adminId, dto.name, id);
    }

    if (dto.name !== undefined) seg.name = dto.name;
    if (dto.description !== undefined) seg.description = dto.description;
    if (dto.status !== undefined) seg.status = dto.status;
    if (dto.audienceFilter !== undefined) seg.audienceFilter = dto.audienceFilter as any;

    const saved = await this.segmentRepo.save(seg);
    if (shouldRefreshEstimate) {
      const estimatedRecipientsCount = await this.audienceService.countRecipients(
        adminId,
        saved.audienceFilter,
      );
      await this.segmentRepo.update(saved.id, { estimatedRecipientsCount });
      saved.estimatedRecipientsCount = estimatedRecipientsCount;
    }

    return saved;
  }

  async remove(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const seg = await this.segmentRepo.findOne({ where: { id, adminId } });
    if (!seg) throw new NotFoundException(this.translations.t("domains.client_segments.not_found"));

    await this.segmentRepo.delete({ id, adminId });
    return { message: this.translations.t("domains.client_segments.deleted_successfully") };
  }

  // ──────────────────────────────────────────────────────────────
  // Preview
  // ──────────────────────────────────────────────────────────────

  async preview(me: any, filter: ClientAudienceFilter) {
    const adminId = this.adminIdOf(me);
    const count = await this.audienceService.countRecipients(adminId, filter);
    return { count };
  }

  async previewRecipients(me: any, filter: ClientAudienceFilter, q?: any) {
    const adminId = this.adminIdOf(me);
    return this.resolveAudienceRecipients(adminId, filter, q);
  }

  async listRecipients(me: any, id: string, q?: any) {
    const adminId = this.adminIdOf(me);
    const seg = await this.segmentRepo.findOne({ where: { id, adminId } });
    if (!seg) throw new NotFoundException(this.translations.t("domains.client_segments.not_found"));

    if (seg.type === ClientSegmentType.FROZEN) {
      return this.listFrozenRecipients(adminId, id, q);
    }

    return this.resolveAudienceRecipients(adminId, seg.audienceFilter, q);
  }

  // ──────────────────────────────────────────────────────────────
  // Refresh estimate
  // ──────────────────────────────────────────────────────────────

  async refreshEstimate(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const seg = await this.segmentRepo.findOne({ where: { id, adminId } });
    if (!seg) throw new NotFoundException(this.translations.t("domains.client_segments.not_found"));

    const count = await this.audienceService.countRecipients(adminId, seg.audienceFilter);
    await this.segmentRepo.update(id, { estimatedRecipientsCount: count });
    return { estimatedRecipientsCount: count };
  }

  async stats(me: any) {
    const adminId = this.adminIdOf(me);

    const result = await this.segmentRepo
      .createQueryBuilder("segment")
      .select("COUNT(*)", "total")
      .addSelect(
        `SUM(CASE WHEN segment.status = :active THEN 1 ELSE 0 END)`,
        "active",
      )
      .addSelect(
        `SUM(CASE WHEN segment.type = :frozen THEN 1 ELSE 0 END)`,
        "frozen",
      )
      .addSelect(
        `SUM(CASE WHEN segment.type = :dynamic THEN 1 ELSE 0 END)`,
        "dynamic",
      )
      .where("segment.adminId = :adminId", { adminId })
      .setParameters({
        active: ClientSegmentStatus.ACTIVE,
        frozen: ClientSegmentType.FROZEN,
        dynamic: ClientSegmentType.DYNAMIC,
      })
      .getRawOne();

    return {
      total: Number(result.total),
      active: Number(result.active),
      frozen: Number(result.frozen),
      dynamic: Number(result.dynamic),
    };
  }
  
  async exportSegments(me: any, q?: any) {
    const { records } = await this.list(me, {
      ...q,
      page: 1,
      limit: 10000,
    });
    const na = this.translations.t("common.not_applicable");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Client Segments");
    sheet.columns = [
      { header: this.translations.t("common.name"), key: "name", width: 28 },
      { header: this.translations.t("common.description"), key: "description", width: 40 },
      { header: this.translations.t("common.status"), key: "status", width: 18 },
      { header: this.translations.t("common.type"), key: "type", width: 18 },
      { header: "Estimated Recipients", key: "estimatedRecipientsCount", width: 22 },
      { header: "Frozen Recipients", key: "frozenRecipientsCount", width: 20 },
      { header: "Frozen At", key: "frozenAt", width: 22 },
      { header: this.translations.t("common.created_at"), key: "createdAt", width: 22 },
    ];

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFEFEFEF" },
    };

    records.forEach((segment) => {
      sheet.addRow({
        name: segment.name || na,
        description: segment.description || na,
        status: segment.status || na,
        type: segment.type || na,
        estimatedRecipientsCount: Number(segment.estimatedRecipientsCount || 0),
        frozenRecipientsCount: Number(segment.frozenRecipientsCount || 0),
        frozenAt: segment.frozenAt ? new Date(segment.frozenAt).toLocaleString() : na,
        createdAt: segment.createdAt ? new Date(segment.createdAt).toLocaleString() : na,
      });
    });

    return workbook.xlsx.writeBuffer();
  }

  // ──────────────────────────────────────────────────────────────
  // Freeze
  // ──────────────────────────────────────────────────────────────

  async freeze(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const seg = await this.segmentRepo.findOne({ where: { id, adminId } });
    if (!seg) throw new NotFoundException(this.translations.t("domains.client_segments.not_found"));

    if (seg.type === ClientSegmentType.FROZEN) {
      throw new BadRequestException(
        this.translations.t("domains.client_segments.already_frozen"),
      );
    }

    const recipients = await this.audienceService.getAllRecipients(adminId, seg.audienceFilter);

    await this.dataSource.transaction(async (mgr) => {
      const recipientRepo = mgr.getRepository(ClientSegmentRecipientEntity);
      const segRepo = mgr.getRepository(ClientSegmentEntity);

      // Remove any previously frozen recipients (e.g., partial re-freeze)
      await recipientRepo.delete({ segmentId: id });

      // Deduplicate by phoneNumber
      const seen = new Set<string>();
      const rows: Partial<ClientSegmentRecipientEntity>[] = [];

      for (const r of recipients) {
        const key = r.phoneNumber ? r.phoneNumber.replace(/\D/g, "") : r.clientId;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          adminId,
          segmentId: id,
          clientId: r.clientId ?? null,
          customerId: r.customerId ?? null,
        });
      }

      if (rows.length > 0) {
        await recipientRepo.insert(rows);
      }

      await segRepo.update(id, {
        type: ClientSegmentType.FROZEN,
        frozenAt: new Date(),
        frozenRecipientsCount: rows.length,
      });
    });

    return this.segmentRepo.findOne({ where: { id } });
  }

  // ──────────────────────────────────────────────────────────────
  // Unfreeze
  // ──────────────────────────────────────────────────────────────

  async unfreeze(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const seg = await this.segmentRepo.findOne({ where: { id, adminId } });
    if (!seg) throw new NotFoundException(this.translations.t("domains.client_segments.not_found"));

    if (seg.type !== ClientSegmentType.FROZEN) {
      throw new BadRequestException(
        this.translations.t("domains.client_segments.not_frozen"),
      );
    }

    await this.dataSource.transaction(async (mgr) => {
      await mgr.getRepository(ClientSegmentRecipientEntity).delete({ segmentId: id });
      await mgr.getRepository(ClientSegmentEntity).update(id, {
        type: ClientSegmentType.DYNAMIC,
        frozenAt: null,
        frozenRecipientsCount: 0,
      });
    });

    return this.segmentRepo.findOne({ where: { id } });
  }

  private async ensureUniqueName(adminId: string, name: string, excludeId?: string) {
    const qb = this.segmentRepo
      .createQueryBuilder("seg")
      .where("seg.adminId = :adminId", { adminId })
      .andWhere("LOWER(seg.name) = LOWER(:name)", { name });

    if (excludeId) {
      qb.andWhere("seg.id != :excludeId", { excludeId });
    }

    const exists = await qb.getOne();
    if (exists) {
      throw new BadRequestException(this.translations.t("domains.client_segments.name_exists"));
    }
  }

  private async resolveAudienceRecipients(
    adminId: string,
    filter: ClientAudienceFilter,
    q?: any,
  ) {
    if (q?.all === "true" || q?.all === true) {
      return this.audienceService.getAllRecipients(adminId, filter, {
        max: Number(q?.max ?? 10000),
      });
    }

    return this.audienceService.listRecipients(adminId, filter, {
      cursor: q?.cursor,
      limit: Number(q?.limit ?? 10),
      sortDir: String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC",
    });
  }

  private async listFrozenRecipients(adminId: string, segmentId: string, q?: any) {
    const qb = this.recipientRepo
      .createQueryBuilder("recipient")
      .leftJoinAndSelect("recipient.client", "client")
      .leftJoinAndSelect("recipient.customer", "customer")
      .where("recipient.adminId = :adminId", { adminId })
      .andWhere("recipient.segmentId = :segmentId", { segmentId });

    if (q?.all === "true" || q?.all === true) {
      const records = await qb
        .orderBy("recipient.createdAt", "DESC")
        .take(Math.min(50000, Number(q?.max ?? 10000)))
        .getMany();
      return records.map((record) => this.mapFrozenRecipient(record));
    }

    const limit = Math.min(100, Number(q?.limit ?? 10));
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    if (q?.cursor) {
      const operator = sortDir === "DESC" ? "<" : ">";
      qb.andWhere(
        `(recipient."createdAt", recipient.id) ${operator} (:cursorValue, :cursorId)`,
        { cursorValue: q.cursor.value, cursorId: q.cursor.id },
      );
    }

    const rows = await qb
      .orderBy("recipient.createdAt", sortDir)
      .addOrderBy("recipient.id", sortDir)
      .take(limit + 1)
      .getMany();
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    return {
      records: pageRows.map((record) => this.mapFrozenRecipient(record)),
      hasMore,
      limit,
      nextCursor: hasMore
        ? {
            value: pageRows[pageRows.length - 1]?.createdAt,
            id: pageRows[pageRows.length - 1]?.id,
          }
        : undefined,
      sortBy: "createdAt",
      sortDir,
    };
  }

  private mapFrozenRecipient(record: ClientSegmentRecipientEntity): ClientAudienceRecipient {
    return {
      clientId: record.clientId,
      customerId: record.customerId ?? null,
      phoneNumber: record.customer?.phoneNumber ?? null,
    };
  }
}
