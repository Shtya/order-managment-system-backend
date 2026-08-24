import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { TagAutomationEntity, TagEntity } from "entities/tag.entity";
import { CreateTagAutomationDto, UpdateTagAutomationDto } from "dto/tag.dto";
import { tenantId } from "src/category/category.service";
import { TranslationService } from "common/translation.service";
import * as ExcelJS from "exceljs";

@Injectable()
export class TagAutomationsService {
  constructor(
    @InjectRepository(TagAutomationEntity)
    private readonly automationRepo: Repository<TagAutomationEntity>,
    @InjectRepository(TagEntity)
    private readonly tagRepo: Repository<TagEntity>,
    private readonly translations: TranslationService,
  ) { }

  private adminIdOf(me: any) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }
    return adminId;
  }

  private async requireTag(adminId: string, tagId: string) {
    const tag = await this.tagRepo.findOne({ where: { id: tagId, adminId } });
    if (!tag) {
      throw new NotFoundException(this.translations.t("domains.tags.not_found"));
    }
    return tag;
  }

  async list(me: any, q?: any) {
    const adminId = this.adminIdOf(me);
    const page = Math.max(1, Number(q?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q?.limit) || 10));
    const skip = (page - 1) * limit;

    const qb = this.automationRepo
      .createQueryBuilder("automation")
      .leftJoinAndSelect("automation.tag", "tag")
      .where("automation.adminId = :adminId", { adminId });

    if (q?.search) {
      qb.andWhere(
        "(automation.name ILIKE :search OR tag.name ILIKE :search)",
        { search: `%${q.search}%` },
      );
    }

    if (q?.tagId) {
      qb.andWhere("automation.tagId = :tagId", { tagId: q.tagId });
    }
    if (q?.isEnabled === true || q?.isEnabled === "true") {
      qb.andWhere("automation.isEnabled = true");
    } else if (q?.isEnabled === false || q?.isEnabled === "false") {
      qb.andWhere("automation.isEnabled = false");
    }

    const [records, total] = await qb
      .orderBy("automation.created_at", "DESC")
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

  async get(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const automation = await this.automationRepo.findOne({
      where: { id, adminId },
      relations: ["tag"],
    });
    if (!automation) {
      throw new NotFoundException(this.translations.t("domains.tags.not_found"));
    }
    return automation;
  }

  async create(me: any, dto: CreateTagAutomationDto) {
    const adminId = this.adminIdOf(me);
    await this.requireTag(adminId, dto.tagId);
    const automation = this.automationRepo.create({
      adminId,
      tagId: dto.tagId,
      name: dto.name.trim(),
      isEnabled: dto.isEnabled ?? true,
      conditions: dto.conditions,
    });
    return this.automationRepo.save(automation);
  }

  async update(me: any, id: string, dto: UpdateTagAutomationDto) {
    const automation = await this.get(me, id);
    if (dto.tagId && dto.tagId !== automation.tagId) {
      await this.requireTag(automation.adminId, dto.tagId);
      automation.tagId = dto.tagId;
    }
    if (dto.name !== undefined) automation.name = dto.name.trim();
    if (dto.isEnabled !== undefined) automation.isEnabled = dto.isEnabled;
    if (dto.conditions !== undefined) automation.conditions = dto.conditions;
    return this.automationRepo.save(automation);
  }

  async export(me: any, q?: any) {
    const all = await this.list(me, { ...q, page: 1, limit: 1000 });
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      this.translations.t("domains.tags.excel_automations_sheet"),
    );
    worksheet.columns = [
      { header: this.translations.t("domains.tags.excel_name"), key: "name", width: 28 },
      { header: this.translations.t("domains.tags.excel_tag"), key: "tag", width: 24 },
      { header: this.translations.t("domains.tags.excel_enabled"), key: "isEnabled", width: 12 },
      { header: this.translations.t("domains.tags.excel_logic"), key: "logic", width: 18 },
      { header: this.translations.t("domains.tags.excel_rules"), key: "rules", width: 10 },
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
        tag: row.tag?.name,
        isEnabled: this.translations.t(row.isEnabled ? "common.yes" : "common.no"),
        logic:
          row.conditions?.logic === "OR"
            ? this.translations.t("domains.tags.excel_logic_or")
            : this.translations.t("domains.tags.excel_logic_and"),
        rules: row.conditions?.rules?.length ?? 0,
      });
    });
    return workbook.xlsx.writeBuffer();
  }

  async remove(me: any, id: string) {
    const automation = await this.get(me, id);
    await this.automationRepo.remove(automation);
    return { success: true };
  }
}
