import {
  BadRequestException,
  forwardRef,
  Inject,
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
import { ClientSegmentQueueService } from "src/queue/queues/client-segments.queue";
import { AppGateway } from "common/app.gateway";

const FREEZE_PAGE_SIZE = 1000;

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
    @Inject(forwardRef(() => ClientSegmentQueueService))
    private readonly clientSegmentQueue: ClientSegmentQueueService,
    private readonly appGateway: AppGateway,
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

    const wantsFrozen = dto.type === ClientSegmentType.FROZEN;
    const seg = this.segmentRepo.create({
      adminId,
      name: dto.name,
      description: dto.description,
      type: wantsFrozen ? ClientSegmentType.FREEZING : ClientSegmentType.DYNAMIC,
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

    if (wantsFrozen) {
      try {
        await this.clientSegmentQueue.enqueueFreeze(adminId, saved.id, me?.id);
      } catch (_) {
        await this.markFreezeFailed(adminId, saved.id, me?.id);
        saved.type = ClientSegmentType.FREEZE_FAILED;
      }
    }

    return saved;
  }

  async update(me: any, id: string, dto: UpdateClientSegmentDto) {
    const adminId = this.adminIdOf(me);
    const seg = await this.segmentRepo.findOne({ where: { id, adminId } });
    if (!seg) throw new NotFoundException(this.translations.t("domains.client_segments.not_found"));
    const shouldRefreshEstimate = dto.audienceFilter !== undefined;

    if (
      (seg.type === ClientSegmentType.FROZEN ||
        seg.type === ClientSegmentType.FREEZING) &&
      dto.audienceFilter
    ) {
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
      if (seg.status !== ClientSegmentStatus.ACTIVE) {
        throw new BadRequestException(
          this.translations.t("domains.client_segments.cannot_use_inactive_frozen"),
        );
      }
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
      .addSelect(
        `SUM(CASE WHEN segment.type = :freezing THEN 1 ELSE 0 END)`,
        "freezing",
      )
      .addSelect(
        `SUM(CASE WHEN segment.type = :freezeFailed THEN 1 ELSE 0 END)`,
        "freeze_failed",
      )
      .where("segment.adminId = :adminId", { adminId })
      .setParameters({
        active: ClientSegmentStatus.ACTIVE,
        frozen: ClientSegmentType.FROZEN,
        dynamic: ClientSegmentType.DYNAMIC,
        freezing: ClientSegmentType.FREEZING,
        freezeFailed: ClientSegmentType.FREEZE_FAILED,
      })
      .getRawOne();

    return {
      total: Number(result.total),
      active: Number(result.active),
      frozen: Number(result.frozen),
      dynamic: Number(result.dynamic),
      freezing: Number(result.freezing),
      freeze_failed: Number(result.freeze_failed),
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

    if (seg.type === ClientSegmentType.FREEZING) {
      throw new BadRequestException(
        this.translations.t("domains.client_segments.freezing_in_progress"),
      );
    }

    if (seg.type === ClientSegmentType.FROZEN) {
      throw new BadRequestException(
        this.translations.t("domains.client_segments.already_frozen"),
      );
    }

    if (
      seg.type !== ClientSegmentType.DYNAMIC &&
      seg.type !== ClientSegmentType.FREEZE_FAILED
    ) {
      throw new BadRequestException(
        this.translations.t("domains.client_segments.cannot_freeze"),
      );
    }

    await this.segmentRepo.update(id, {
      type: ClientSegmentType.FREEZING,
      frozenAt: null,
      frozenRecipientsCount: 0,
    });

    try {
      await this.clientSegmentQueue.enqueueFreeze(adminId, id, me?.id);
    } catch (error) {
      await this.markFreezeFailed(adminId, id, me?.id);
      throw error;
    }

    return this.segmentRepo.findOne({ where: { id, adminId } });
  }

  async processFreezeJob(adminId: string, segmentId: string, userId?: string) {
    const seg = await this.segmentRepo.findOne({ where: { id: segmentId, adminId } });
    if (!seg) return;

    if (
      seg.type !== ClientSegmentType.FREEZING &&
      seg.type !== ClientSegmentType.FREEZE_FAILED
    ) {
      return;
    }

    await this.dataSource.transaction(async (mgr) => {
      const recipientRepo = mgr.getRepository(ClientSegmentRecipientEntity);
      const segRepo = mgr.getRepository(ClientSegmentEntity);

      await segRepo.update(segmentId, {
        type: ClientSegmentType.FREEZING,
        frozenAt: null,
        frozenRecipientsCount: 0,
      });
      await recipientRepo.delete({ segmentId });

      const seen = new Set<string>();
      let cursor: { value: Date; id: string } | undefined;
      let total = 0;

      while (true) {
        const page = await this.audienceService.listRecipientsPage(
          adminId,
          seg.audienceFilter,
          { cursor, limit: FREEZE_PAGE_SIZE },
        );

        const rows: Partial<ClientSegmentRecipientEntity>[] = [];
        for (const r of page.records) {
          const key = r.phoneNumber ? r.phoneNumber.replace(/\D/g, "") : r.clientId;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          rows.push({
            adminId,
            segmentId,
            clientId: r.clientId ?? null,
            customerId: r.customerId ?? null,
          });
        }

        if (rows.length > 0) {
          await recipientRepo.insert(rows);
          total += rows.length;
        }

        if (!page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
      }

      await segRepo.update(segmentId, {
        type: ClientSegmentType.FROZEN,
        frozenAt: new Date(),
        frozenRecipientsCount: total,
      });
    });

    const frozen = await this.segmentRepo.findOne({ where: { id: segmentId, adminId } });
    this.appGateway.emitClientSegmentFreezeStatus([adminId, userId], {
      status: "success",
      segment: frozen as any,
    });
  }

  async markFreezeFailed(adminId: string, segmentId: string, userId?: string) {
    await this.dataSource.transaction(async (mgr) => {
      await mgr.getRepository(ClientSegmentRecipientEntity).delete({ segmentId });
      await mgr.getRepository(ClientSegmentEntity).update(
        { id: segmentId, adminId },
        {
          type: ClientSegmentType.FREEZE_FAILED,
          frozenAt: null,
          frozenRecipientsCount: 0,
        },
      );
    });

    const failed = await this.segmentRepo.findOne({ where: { id: segmentId, adminId } });
    this.appGateway.emitClientSegmentFreezeStatus([adminId, userId], {
      status: "failed",
      segment: failed as any,
    });
  }

  async unfreeze(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const seg = await this.segmentRepo.findOne({ where: { id, adminId } });
    if (!seg) throw new NotFoundException(this.translations.t("domains.client_segments.not_found"));

    if (seg.type === ClientSegmentType.FREEZING) {
      throw new BadRequestException(
        this.translations.t("domains.client_segments.freezing_in_progress"),
      );
    }

    if (
      seg.type !== ClientSegmentType.FROZEN &&
      seg.type !== ClientSegmentType.FREEZE_FAILED
    ) {
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
    const cursor =
      q?.cursor ??
      (q?.["cursor[value]"] && q?.["cursor[id]"]
        ? {
            value: q["cursor[value]"],
            id: q["cursor[id]"],
          }
        : undefined);
  
    return this.audienceService.listRecipients(adminId, filter, {
      cursor,
      limit: Number(q?.limit ?? 10),
      sortDir:
        String(q?.sortDir ?? "DESC").toUpperCase() === "ASC"
          ? "ASC"
          : "DESC",
    });
  }

  private async listFrozenRecipients(adminId: string, segmentId: string, q?: any) {
    const qb = this.recipientRepo
      .createQueryBuilder("recipient")
      .leftJoinAndSelect("recipient.client", "client")
      .leftJoinAndSelect("recipient.customer", "customer")
      .where("recipient.adminId = :adminId", { adminId })
      .andWhere("recipient.segmentId = :segmentId", { segmentId });

    const limit = Math.min(100, Number(q?.limit ?? 10));
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const cursor =
      q?.cursor ??
      (q?.["cursor[value]"] && q?.["cursor[id]"]
        ? {
            value: q["cursor[value]"],
            id: q["cursor[id]"],
          }
        : undefined);
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
      name: record.client?.name ?? null,
      clientId: record.clientId,
      customerId: record.customerId ?? null,
      phoneNumber: record.customer?.phoneNumber ?? null,
      profilePicture: record.client?.profilePicture || record.customer?.profilePicture || null,
    };
  }
}
