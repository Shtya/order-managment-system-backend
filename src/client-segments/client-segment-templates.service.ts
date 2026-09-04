import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, Repository } from "typeorm";
import * as ExcelJS from "exceljs";
import {
  ClientSegmentTemplateEntity,
  ClientSegmentTemplateStatus,
} from "entities/clients-segments.entity";
import {
  ClientSegmentEntity,
  ClientSegmentType,
} from "entities/clients-segments.entity";
import {
  CreateClientSegmentTemplateDto,
  UpdateClientSegmentTemplateDto,
  CreateSegmentFromTemplateDto,
} from "dto/client-segment.dto";
import { TranslationService } from "common/translation.service";
import { tenantId } from "src/category/category.service";
import { isSuperAdmin } from "common/healpers";

@Injectable()
export class ClientSegmentTemplatesService {
  constructor(
    @InjectRepository(ClientSegmentTemplateEntity)
    private readonly templateRepo: Repository<ClientSegmentTemplateEntity>,
    @InjectRepository(ClientSegmentEntity)
    private readonly segmentRepo: Repository<ClientSegmentEntity>,
    private readonly translations: TranslationService,
  ) { }

  // ──────────────────────────────────────────────────────────────
  // Tenant-facing: list active templates
  // ──────────────────────────────────────────────────────────────

  async listActive(q?: any) {
    const limit = Number(q?.limit ?? 50);
    const sortBy = String(q?.sortBy ?? "sortOrder");
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC";
    const cursor = q?.cursor;

    const qb = this.templateRepo
      .createQueryBuilder("tpl")
      .where("tpl.status = :status", { status: ClientSegmentTemplateStatus.ACTIVE });

    if (q?.search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("tpl.name ILIKE :search", { search: `%${q.search}%` })
            .orWhere("tpl.description ILIKE :search", { search: `%${q.search}%` });
        }),
      );
    }

    const sortColumns: Record<string, string> = {
      sortOrder: "tpl.sortOrder",
      createdAt: "tpl.createdAt",
      name: "tpl.name",
    };
    const sortCol = sortColumns[sortBy] || "tpl.sortOrder";

    if (cursor) {
      const operator = sortDir === "DESC" ? "<" : ">";
      qb.andWhere(`(${sortCol}, tpl.id) ${operator} (:cursorValue, :cursorId)`, {
        cursorValue: cursor.value,
        cursorId: cursor.id,
      });
    }

    qb.orderBy(sortCol, sortDir).addOrderBy("tpl.id", sortDir);

    const recordsWithExtra = await qb.take(limit + 1).getMany();
    const hasMore = recordsWithExtra.length > limit;
    const records = hasMore ? recordsWithExtra.slice(0, limit) : recordsWithExtra;

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

  async getActive(id: string) {
    const tpl = await this.templateRepo.findOne({
      where: { id, status: ClientSegmentTemplateStatus.ACTIVE },
    });
    if (!tpl)
      throw new NotFoundException(this.translations.t("domains.client_segments.template_not_found"));
    return tpl;
  }

  /**
   * Tenant user instantiates a segment from a template.
   */
  async createSegmentFromTemplate(
    me: any,
    templateId: string,
    dto: CreateSegmentFromTemplateDto,
  ) {
    const adminId = tenantId(me);
    if (!adminId)
      throw new BadRequestException(this.translations.t("common.missing_admin_id"));

    const tpl = await this.getActive(templateId);
    await this.ensureUniqueSegmentName(adminId, dto.name ?? tpl.name);

    const seg = this.segmentRepo.create({
      adminId,
      name: dto.name ?? tpl.name,
      description: dto.description ?? tpl.description ?? undefined,
      type: dto.type ?? tpl.defaultType as ClientSegmentType,
      audienceFilter: tpl.audienceFilter,
    });

    return this.segmentRepo.save(seg);
  }

  // ──────────────────────────────────────────────────────────────
  // Super-admin: full CRUD
  // ──────────────────────────────────────────────────────────────

  private ensureSuperAdmin(me: any) {
    if (!isSuperAdmin(me)) {
      throw new ForbiddenException(this.translations.t("common.permission_denied"));
    }
  }

  async adminList(me: any, q?: any) {
    this.ensureSuperAdmin(me);

    const qb = this.templateRepo
      .createQueryBuilder("tpl");

    if (q?.status) qb.andWhere("tpl.status = :status", { status: q.status });
    if (q?.search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("tpl.name ILIKE :search", { search: `%${q.search}%` })
            .orWhere("tpl.description ILIKE :search", { search: `%${q.search}%` });
        }),
      );
    }

    const page = Math.max(1, parseInt(q?.page) || 1);
    const limit = Math.min(100, parseInt(q?.limit) || 20);
    const skip = (page - 1) * limit;
    const [records, total] = await qb
      .orderBy("tpl.sortOrder", "ASC")
      .addOrderBy("tpl.name", "ASC")
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

  async adminGet(me: any, id: string) {
    this.ensureSuperAdmin(me);
    const tpl = await this.templateRepo.findOne({ where: { id } });
    if (!tpl)
      throw new NotFoundException(this.translations.t("domains.client_segments.template_not_found"));
    return tpl;
  }

  async adminCreate(me: any, dto: CreateClientSegmentTemplateDto) {
    this.ensureSuperAdmin(me);
    await this.ensureUniqueTemplateName(dto.name);

    const tpl = this.templateRepo.create({
      name: dto.name,
      description: dto.description,
      defaultType: dto.defaultType ?? ("dynamic" as any),
      audienceFilter: dto.audienceFilter as any,
      sortOrder: dto.sortOrder ?? 0,
    });

    return this.templateRepo.save(tpl);
  }

  async adminUpdate(me: any, id: string, dto: UpdateClientSegmentTemplateDto) {
    this.ensureSuperAdmin(me);
    const tpl = await this.templateRepo.findOne({ where: { id } });
    if (!tpl)
      throw new NotFoundException(this.translations.t("domains.client_segments.template_not_found"));

    if (dto.name !== undefined && dto.name !== tpl.name) {
      await this.ensureUniqueTemplateName(dto.name, id);
    }

    if (dto.name !== undefined) tpl.name = dto.name;
    if (dto.description !== undefined) tpl.description = dto.description;
    if (dto.defaultType !== undefined) tpl.defaultType = dto.defaultType as any;
    if (dto.audienceFilter !== undefined) tpl.audienceFilter = dto.audienceFilter as any;
    if (dto.sortOrder !== undefined) tpl.sortOrder = dto.sortOrder;

    return this.templateRepo.save(tpl);
  }

  async adminDelete(me: any, id: string) {
    this.ensureSuperAdmin(me);
    const tpl = await this.templateRepo.findOne({ where: { id } });
    if (!tpl)
      throw new NotFoundException(this.translations.t("domains.client_segments.template_not_found"));

    await this.templateRepo.delete({ id });
    return { message: this.translations.t("domains.client_segments.template_deleted_successfully") };
  }

  async adminStats(me: any) {
    this.ensureSuperAdmin(me);

    const result = await this.templateRepo
      .createQueryBuilder("template")
      .select("COUNT(*)", "total")
      .addSelect(
        `COUNT(*) FILTER (WHERE template.status = :active)`,
        "active",
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE template.defaultType = :frozen)`,
        "frozen",
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE template.defaultType = :dynamic)`,
        "dynamic",
      )
      .setParameters({
        active: ClientSegmentTemplateStatus.ACTIVE,
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

  async adminExport(me: any, q?: any) {
    this.ensureSuperAdmin(me);
    const { records } = await this.adminList(me, {
      ...q,
      page: 1,
      limit: 10000,
    });
    const na = this.translations.t("common.not_applicable");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Client Segment Templates");
    sheet.columns = [
      { header: this.translations.t("common.name"), key: "name", width: 28 },
      { header: this.translations.t("common.description"), key: "description", width: 40 },
      { header: this.translations.t("common.status"), key: "status", width: 18 },
      { header: this.translations.t("common.type"), key: "defaultType", width: 18 },
      { header: "Sort Order", key: "sortOrder", width: 14 },
      { header: this.translations.t("common.created_at"), key: "createdAt", width: 22 },
      { header: "Updated At", key: "updatedAt", width: 22 },
    ];

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFEFEFEF" },
    };

    records.forEach((template) => {
      sheet.addRow({
        name: template.name || na,
        description: template.description || na,
        status: template.status || na,
        defaultType: template.defaultType || na,
        sortOrder: Number(template.sortOrder || 0),
        createdAt: template.createdAt ? new Date(template.createdAt).toLocaleString() : na,
        updatedAt: template.updatedAt ? new Date(template.updatedAt).toLocaleString() : na,
      });
    });

    return workbook.xlsx.writeBuffer();
  }

  private async ensureUniqueTemplateName(name: string, excludeId?: string) {
    const qb = this.templateRepo
      .createQueryBuilder("tpl")
      .where("LOWER(tpl.name) = LOWER(:name)", { name });

    if (excludeId) {
      qb.andWhere("tpl.id != :excludeId", { excludeId });
    }

    const exists = await qb.getOne();
    if (exists) {
      throw new BadRequestException(this.translations.t("domains.client_segments.template_name_exists"));
    }
  }

  private async ensureUniqueSegmentName(adminId: string, name: string) {
    const exists = await this.segmentRepo
      .createQueryBuilder("seg")
      .where("seg.adminId = :adminId", { adminId })
      .andWhere("LOWER(seg.name) = LOWER(:name)", { name })
      .getOne();

    if (exists) {
      throw new BadRequestException(this.translations.t("domains.client_segments.name_exists"));
    }
  }
}
