import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Not, Repository, SelectQueryBuilder } from "typeorm";
import {
  ClientTagEntity,
  OrderTagEntity,
  TagAutomationEntity,
  TagEntity,
  TagTarget,
  resolveTagTarget,
} from "entities/tag.entity";
import { CreateTagDto, UpdateTagDto } from "dto/tag.dto";
import { tenantId } from "src/category/category.service";
import { TranslationService } from "common/translation.service";
import * as ExcelJS from "exceljs";

@Injectable()
export class TagsService {
  constructor(
    @InjectRepository(TagEntity)
    private readonly tagRepo: Repository<TagEntity>,
    @InjectRepository(TagAutomationEntity)
    private readonly automationRepo: Repository<TagAutomationEntity>,
    private readonly translations: TranslationService,
  ) {}

  private adminIdOf(me: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }
    return adminId;
  }

  private addTagCountSelects(qb: SelectQueryBuilder<TagEntity>) {
    return qb
      .addSelect((subQuery) => {
        return subQuery
          .select("COUNT(automation.id)")
          .from(TagAutomationEntity, "automation")
          .where("automation.tagId = tag.id");
      }, "tag_automationsCount")
      .addSelect((subQuery) => {
        return subQuery
          .select("COUNT(orderTag.id)")
          .from(OrderTagEntity, "orderTag")
          .where("orderTag.tagId = tag.id");
      }, "tag_ordersCount")
      .addSelect((subQuery) => {
        return subQuery
          .select("COUNT(clientTag.id)")
          .from(ClientTagEntity, "clientTag")
          .where("clientTag.tagId = tag.id");
      }, "tag_clientsCount");
  }

  private attachTagCounts(entities: TagEntity[], raw: Record<string, unknown>[]) {
    const countsById = new Map<
      string,
      {
        automationsCount: number;
        ordersCount: number;
        clientsCount: number;
      }
    >();
    for (const row of raw) {
      const id = String(row.tag_id ?? "");
      if (!id || countsById.has(id)) continue;
      countsById.set(id, {
        automationsCount: Number(row.tag_automationsCount ?? 0),
        ordersCount: Number(row.tag_ordersCount ?? 0),
        clientsCount: Number(row.tag_clientsCount ?? 0),
      });
    }
    for (const entity of entities) {
      const counts = countsById.get(entity.id);
      (entity as any).automationsCount = counts?.automationsCount ?? 0;
      (entity as any).ordersCount = counts?.ordersCount ?? 0;
      (entity as any).clientsCount = counts?.clientsCount ?? 0;
    }
  }

  async stats(me: any, q?: any) {
    const adminId = this.adminIdOf(me);
    const target = resolveTagTarget(q?.target);
    const [tagRow, automationRow] = await Promise.all([
      this.tagRepo
        .createQueryBuilder("tag")
        .select("COUNT(*)", "tags")
        .addSelect(
          "COUNT(*) FILTER (WHERE tag.isActive = true)",
          "activeTags",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE tag.allowManualAssignment = true)",
          "employeeTags",
        )
        .where("tag.adminId = :adminId", { adminId })
        .andWhere("tag.target = :target", { target })
        .getRawOne(),
      this.automationRepo
        .createQueryBuilder("automation")
        .innerJoin("automation.tag", "tag")
        .select("COUNT(*)", "automations")
        .addSelect(
          "COUNT(*) FILTER (WHERE automation.isEnabled = true)",
          "activeAutomations",
        )
        .where("automation.adminId = :adminId", { adminId })
        .andWhere("tag.target = :target", { target })
        .getRawOne(),
    ]);

    return {
      tags: Number(tagRow?.tags ?? 0),
      activeTags: Number(tagRow?.activeTags ?? 0),
      employeeTags: Number(tagRow?.employeeTags ?? tagRow?.manualTags ?? 0),
      manualTags: Number(tagRow?.employeeTags ?? tagRow?.manualTags ?? 0),
      automations: Number(automationRow?.automations ?? 0),
      activeAutomations: Number(automationRow?.activeAutomations ?? 0),
    };
  }
  
  async list(me: any, q?: any) {
    const adminId = this.adminIdOf(me);
    const target = resolveTagTarget(q?.target);
    const page = Math.max(1, Number(q?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q?.limit) || 10));
    const skip = (page - 1) * limit;

    const qb = this.tagRepo
      .createQueryBuilder("tag")
      .where("tag.adminId = :adminId", { adminId })
      .andWhere("tag.target = :target", { target });

    if (q?.search) {
      qb.andWhere(
        "(tag.name ILIKE :search OR tag.description ILIKE :search)",
        { search: `%${q.search}%` },
      );
    }
    if (q?.isActive === true || q?.isActive === "true") {
      qb.andWhere("tag.isActive = true");
    } else if (q?.isActive === false || q?.isActive === "false") {
      qb.andWhere("tag.isActive = false");
    }
    if (q?.allowManualAssignment === true || q?.allowManualAssignment === "true") {
      qb.andWhere("tag.allowManualAssignment = true");
    } else if (
      q?.allowManualAssignment === false ||
      q?.allowManualAssignment === "false"
    ) {
      qb.andWhere("tag.allowManualAssignment = false");
    }

    const sortBy =
      q?.sortBy === "name" || q?.sortBy === "priority" || q?.sortBy === "created_at"
        ? q.sortBy
        : "priority";
    const sortOrder =
      String(q?.sortOrder || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const total = await qb.getCount();
    const { entities: records, raw } = await this.addTagCountSelects(qb)
      .orderBy(`tag.${sortBy}`, sortOrder)
      .addOrderBy("tag.created_at", "DESC")
      .skip(skip)
      .take(limit)
      .getRawAndEntities();
    this.attachTagCounts(records, raw);

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  async listAssignable(me: any, q?: any) {
    const adminId = this.adminIdOf(me);
    const target = resolveTagTarget(q?.target);
    const qb = this.tagRepo
      .createQueryBuilder("tag")
      .where("tag.adminId = :adminId", { adminId })
      .andWhere("tag.isActive = true")
      .andWhere("tag.target = :target", { target });

    if (me?.role?.name !== "admin") {
      qb.andWhere("tag.allowManualAssignment = true").andWhere(
        `(tag."employeeIds" IS NULL OR tag."employeeIds" = '[]'::jsonb OR tag."employeeIds" @> :empJson)`,
        { empJson: JSON.stringify([me.id]) },
      );
    }

    return qb.orderBy("tag.priority", "DESC").addOrderBy("tag.name", "ASC").getMany();
  }

  async get(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const tag = await this.tagRepo.findOne({
      where: { id, adminId },
      relations: {
        automations: true
      },
    });
    if (!tag) {
      throw new NotFoundException(this.translations.t("domains.tags.not_found"));
    }
    return tag;
  }

  private async assertUniqueName(
    adminId: string,
    name: string,
    target: TagTarget,
    excludeId?: string,
  ) {
    const existing = await this.tagRepo.findOne({
      where: excludeId
        ? { adminId, name, target, id: Not(excludeId) }
        : { adminId, name, target },
    });
    if (existing) {
      throw new BadRequestException(
        this.translations.t("domains.tags.name_exists"),
      );
    }
  }

  async create(me: any, dto: CreateTagDto) {
    const adminId = this.adminIdOf(me);
    const target = resolveTagTarget(dto.target);
    await this.assertUniqueName(adminId, dto.name.trim(), target);
    const allowEmployees = dto.allowManualAssignment ?? true;
    const tag = this.tagRepo.create({
      adminId,
      name: dto.name.trim(),
      color: dto.color || "#6C5CE7",
      description: dto.description ?? null,
      isActive: dto.isActive ?? true,
      allowManualAssignment: allowEmployees,
      employeeIds: allowEmployees ? this.normalizeEmployeeIds(dto.employeeIds) : [],
      priority: dto.priority ?? 0,
      target,
    });
    return this.tagRepo.save(tag);
  }

  async update(me: any, id: string, dto: UpdateTagDto) {
    const tag = await this.get(me, id);
    if (dto.name && dto.name.trim() !== tag.name) {
      await this.assertUniqueName(tag.adminId, dto.name.trim(), tag.target, tag.id);
      tag.name = dto.name.trim();
    }
    if (dto.color !== undefined) tag.color = dto.color;
    if (dto.description !== undefined) tag.description = dto.description;
    if (dto.isActive !== undefined) tag.isActive = dto.isActive;
    if (dto.allowManualAssignment !== undefined) {
      tag.allowManualAssignment = dto.allowManualAssignment;
    }
    if (dto.employeeIds !== undefined) {
      tag.employeeIds = this.normalizeEmployeeIds(dto.employeeIds);
    }
    if (tag.allowManualAssignment === false) {
      tag.employeeIds = [];
    }
    if (dto.priority !== undefined) tag.priority = dto.priority;
    return this.tagRepo.save(tag);
  }

  private normalizeEmployeeIds(ids?: string[] | null) {
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids.filter(Boolean))];
  }

  async toggleActive(me: any, id: string) {
    const tag = await this.get(me, id);
    tag.isActive = !tag.isActive;
    return this.tagRepo.save(tag);
  }

  async toggleEmployeeUse(me: any, id: string) {
    const tag = await this.get(me, id);
    tag.allowManualAssignment = !tag.allowManualAssignment;
    if (!tag.allowManualAssignment) {
      tag.employeeIds = [];
    }
    return this.tagRepo.save(tag);
  }

  async export(me: any, q?: any) {
    const all = await this.list(me, { ...q, page: 1, limit: 1000 });
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      this.translations.t("domains.tags.excel_sheet"),
    );
    worksheet.columns = [
      { header: this.translations.t("domains.tags.excel_name"), key: "name", width: 28 },
      { header: this.translations.t("domains.tags.excel_color"), key: "color", width: 12 },
      { header: this.translations.t("domains.tags.excel_description"), key: "description", width: 36 },
      { header: this.translations.t("domains.tags.excel_active"), key: "isActive", width: 10 },
      { header: this.translations.t("domains.tags.excel_employee"), key: "allowManualAssignment", width: 18 },
      { header: this.translations.t("domains.tags.excel_priority"), key: "priority", width: 12 },
    ];
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };
    
    all.records.forEach((row: any) => {
      worksheet.addRow({
        name: row.name,
        color: row.color,
        description: row.description,
        isActive: this.translations.t(row.isActive ? "common.yes" : "common.no"),
        allowManualAssignment: this.translations.t(
          row.allowManualAssignment ? "common.yes" : "common.no",
        ),
        priority: row.priority,
      });
    });
    return workbook.xlsx.writeBuffer();
  }

  async remove(me: any, id: string) {
    const tag = await this.get(me, id);
    await this.tagRepo.remove(tag);
    return { success: true };
  }
}
