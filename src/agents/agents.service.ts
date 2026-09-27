import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, SelectQueryBuilder } from "typeorm";
import { AgentEntity, AgentGender, AgentLanguage } from "entities/agent.entity";
import { AiProviderEntity } from "entities/ai.entity";
import { CreateAgentDto, UpdateAgentDto } from "dto/agent.dto";
import { tenantId } from "src/category/category.service";
import { TranslationService } from "common/translation.service";
import * as ExcelJS from "exceljs";

const LIST_PAGE_LIMIT = 20;
const LIST_PAGE_LIMIT_MAX = 100;

@Injectable()
export class AgentsService {
  constructor(
    @InjectRepository(AgentEntity)
    private readonly agentRepo: Repository<AgentEntity>,
    @InjectRepository(AiProviderEntity)
    private readonly providerRepo: Repository<AiProviderEntity>,
    private readonly translations: TranslationService,
  ) {}

  private adminIdOf(me: any): string {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }
    return adminId;
  }

  private present(agent: AgentEntity) {
    const provider = agent.responseProvider;
    return {
      ...agent,
      responseProvider: provider
        ? { id: provider.id, name: provider.name, code: provider.code }
        : null,
    };
  }

  private async ensureUniqueName(
    adminId: string,
    name: string,
    excludeId?: string,
  ) {
    const qb = this.agentRepo
      .createQueryBuilder("agent")
      .select("agent.id")
      .where("agent.adminId = :adminId", { adminId })
      .andWhere("agent.name = :name", { name });
    if (excludeId) qb.andWhere("agent.id != :excludeId", { excludeId });
    const exists = await qb.getOne();
    if (exists) {
      throw new BadRequestException(
        this.translations.t("domains.agents.name_exists"),
      );
    }
  }

  private async assertProvider(adminId: string, providerId: string) {
    const provider = await this.providerRepo.findOne({
      where: { id: providerId, isActive: true },
    });
    const visible =
      provider && (provider.adminId == null || provider.adminId === adminId);
    if (!visible) {
      throw new BadRequestException(
        this.translations.t("domains.agents.provider_not_found"),
      );
    }
    return provider;
  }

  private filteredQuery(adminId: string, q: any): SelectQueryBuilder<AgentEntity> {
    const qb = this.agentRepo
      .createQueryBuilder("agent")
      .leftJoinAndSelect("agent.responseProvider", "responseProvider")
      .where("agent.adminId = :adminId", { adminId });

    if (q?.search) {
      qb.andWhere("agent.name ILIKE :search", { search: `%${String(q.search)}%` });
    }
    if (q?.isActive === true || q?.isActive === "true") {
      qb.andWhere("agent.isActive = true");
    } else if (q?.isActive === false || q?.isActive === "false") {
      qb.andWhere("agent.isActive = false");
    }
    if (
      q?.language &&
      Object.values(AgentLanguage).includes(q.language as AgentLanguage)
    ) {
      qb.andWhere("agent.language = :language", { language: q.language });
    }

    return qb.orderBy("agent.createdAt", "DESC");
  }

  async list(me: any, q: any) {
    const adminId = this.adminIdOf(me);
    const page = Math.max(1, parseInt(q?.page) || 1);
    const limit = Math.min(
      LIST_PAGE_LIMIT_MAX,
      Math.max(1, parseInt(q?.limit) || LIST_PAGE_LIMIT),
    );

    const qb = this.filteredQuery(adminId, q);

    const total = await qb.getCount();
    const records = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records: records.map((agent) => this.present(agent)),
    };
  }

  async get(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const agent = await this.agentRepo.findOne({
      where: { id, adminId },
      relations: { responseProvider: true },
    });
    if (!agent) {
      throw new NotFoundException(
        this.translations.t("domains.agents.not_found"),
      );
    }
    return this.present(agent);
  }

  async create(me: any, dto: CreateAgentDto) {
    const adminId = this.adminIdOf(me);
    const name = dto.name.trim();
    await this.ensureUniqueName(adminId, name);
    if (dto.responseProviderId) {
      await this.assertProvider(adminId, dto.responseProviderId);
    }

    const agent = await this.agentRepo.save(
      this.agentRepo.create({
        adminId,
        name,
        language: dto.language,
        gender: dto.gender ?? AgentGender.MALE,
        customInstructions: dto.customInstructions?.trim() || null,
        responseProviderId: dto.responseProviderId ?? null,
        isActive: dto.isActive ?? true,
      }),
    );
    return this.get(me, agent.id);
  }

  async update(me: any, id: string, dto: UpdateAgentDto) {
    const adminId = this.adminIdOf(me);
    const existing = await this.agentRepo.findOne({
      where: { id, adminId },
    });
    if (!existing) {
      throw new NotFoundException(
        this.translations.t("domains.agents.not_found"),
      );
    }

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name !== existing.name) {
        await this.ensureUniqueName(adminId, name, existing.id);
      }
      existing.name = name;
    }
    if (dto.language !== undefined) existing.language = dto.language;
    if (dto.gender !== undefined) existing.gender = dto.gender;
    if (dto.customInstructions !== undefined) {
      existing.customInstructions = dto.customInstructions?.trim() || null;
    }
    if (dto.isActive !== undefined) existing.isActive = dto.isActive;
    if (dto.responseProviderId !== undefined) {
      if (dto.responseProviderId) {
        await this.assertProvider(adminId, dto.responseProviderId);
        existing.responseProviderId = dto.responseProviderId;
      } else {
        existing.responseProviderId = null;
      }
    }

    await this.agentRepo.save(existing);
    return this.get(me, id);
  }

  async toggleActive(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const existing = await this.agentRepo.findOne({
      where: { id, adminId },
    });
    if (!existing) {
      throw new NotFoundException(
        this.translations.t("domains.agents.not_found"),
      );
    }
    existing.isActive = !existing.isActive;
    await this.agentRepo.save(existing);
    return this.get(me, id);
  }

  async remove(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const existing = await this.agentRepo.findOne({
      where: { id, adminId },
    });
    if (!existing) {
      throw new NotFoundException(
        this.translations.t("domains.agents.not_found"),
      );
    }
    await this.agentRepo.remove(existing);
    return {
      message: this.translations.t("domains.agents.deleted_successfully"),
    };
  }

  async stats(me: any) {
    const adminId = this.adminIdOf(me);
    const result = await this.agentRepo
      .createQueryBuilder("agent")
      .select("COUNT(*)", "total")
      .addSelect(
        `SUM(CASE WHEN agent.isActive = true THEN 1 ELSE 0 END)`,
        "active",
      )
      .where("agent.adminId = :adminId", { adminId })
      .getRawOne();

    return {
      total: Number(result?.total ?? 0),
      active: Number(result?.active ?? 0),
    };
  }

  async exportAgents(me: any, q?: any) {
    const adminId = this.adminIdOf(me);
    const records = await this.filteredQuery(adminId, q).take(10000).getMany();
    const na = this.translations.t("common.not_applicable");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(
      this.translations.t("domains.agents.export_sheet"),
    );
    sheet.columns = [
      {
        header: this.translations.t("domains.agents.export_name"),
        key: "name",
        width: 28,
      },
      {
        header: this.translations.t("domains.agents.export_language"),
        key: "language",
        width: 18,
      },
      {
        header: this.translations.t("domains.agents.export_provider"),
        key: "provider",
        width: 28,
      },
      {
        header: this.translations.t("domains.agents.export_status"),
        key: "status",
        width: 16,
      },
      {
        header: this.translations.t("domains.agents.export_created_at"),
        key: "createdAt",
        width: 22,
      },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFEFEFEF" },
    };

    for (const agent of records) {
      const presented = this.present(agent);
      sheet.addRow({
        name: presented.name || na,
        language: this.translations.t(
          `domains.agents.language_${presented.language}`,
        ),
        provider:
          presented.responseProvider?.name ||
          this.translations.t("domains.agents.provider_auto"),
        status: this.translations.t(
          presented.isActive
            ? "domains.agents.status_active"
            : "domains.agents.status_inactive",
        ),
        createdAt: presented.createdAt
          ? new Date(presented.createdAt).toLocaleString()
          : na,
      });
    }

    return workbook.xlsx.writeBuffer();
  }
}
