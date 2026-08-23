import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Not, Repository } from "typeorm";
import { TagEntity } from "entities/tag.entity";
import { CreateTagDto, UpdateTagDto } from "dto/tag.dto";
import { tenantId } from "src/category/category.service";
import { TranslationService } from "common/translation.service";
import * as ExcelJS from "exceljs";

@Injectable()
export class TagsService {
  constructor(
    @InjectRepository(TagEntity)
    private readonly tagRepo: Repository<TagEntity>,
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

  async list(me: any, q?: any) {
    const adminId = this.adminIdOf(me);
    const page = Math.max(1, Number(q?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q?.limit) || 10));
    const skip = (page - 1) * limit;

    const qb = this.tagRepo
      .createQueryBuilder("tag")
      .loadRelationCountAndMap("tag.automationsCount", "tag.automations")
      .where("tag.adminId = :adminId", { adminId });

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

    const sortBy =
      q?.sortBy === "name" || q?.sortBy === "priority" || q?.sortBy === "created_at"
        ? q.sortBy
        : "priority";
    const sortOrder =
      String(q?.sortOrder || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const [records, total] = await qb
      .orderBy(`tag.${sortBy}`, sortOrder)
      .addOrderBy("tag.created_at", "DESC")
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

  async listAssignable(me: any) {
    const adminId = this.adminIdOf(me);
    return this.tagRepo.find({
      where: { adminId, isActive: true, allowManualAssignment: true },
      order: { priority: "DESC", name: "ASC" },
    });
  }

  async get(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const tag = await this.tagRepo.findOne({
      where: { id, adminId },
      relations: ["automations"],
    });
    if (!tag) {
      throw new NotFoundException(this.translations.t("domains.tags.not_found"));
    }
    return tag;
  }

  private async assertUniqueName(
    adminId: string,
    name: string,
    excludeId?: string,
  ) {
    const existing = await this.tagRepo.findOne({
      where: excludeId
        ? { adminId, name, id: Not(excludeId) }
        : { adminId, name },
    });
    if (existing) {
      throw new BadRequestException(
        this.translations.t("domains.tags.name_exists"),
      );
    }
  }

  async create(me: any, dto: CreateTagDto) {
    const adminId = this.adminIdOf(me);
    await this.assertUniqueName(adminId, dto.name.trim());
    const tag = this.tagRepo.create({
      adminId,
      name: dto.name.trim(),
      color: dto.color || "#6C5CE7",
      description: dto.description ?? null,
      isActive: dto.isActive ?? true,
      allowManualAssignment: dto.allowManualAssignment ?? true,
      priority: dto.priority ?? 0,
    });
    return this.tagRepo.save(tag);
  }

  async update(me: any, id: string, dto: UpdateTagDto) {
    const tag = await this.get(me, id);
    if (dto.name && dto.name.trim() !== tag.name) {
      await this.assertUniqueName(tag.adminId, dto.name.trim(), tag.id);
      tag.name = dto.name.trim();
    }
    if (dto.color !== undefined) tag.color = dto.color;
    if (dto.description !== undefined) tag.description = dto.description;
    if (dto.isActive !== undefined) tag.isActive = dto.isActive;
    if (dto.allowManualAssignment !== undefined) {
      tag.allowManualAssignment = dto.allowManualAssignment;
    }
    if (dto.priority !== undefined) tag.priority = dto.priority;
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
      { header: this.translations.t("domains.tags.excel_manual"), key: "allowManualAssignment", width: 16 },
      { header: this.translations.t("domains.tags.excel_priority"), key: "priority", width: 12 },
    ];
    all.records.forEach((row: any) => {
      worksheet.addRow({
        name: row.name,
        color: row.color,
        description: row.description,
        isActive: row.isActive,
        allowManualAssignment: row.allowManualAssignment,
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
