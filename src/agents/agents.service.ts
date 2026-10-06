import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
  DataSource,
  EntityManager,
  In,
  Repository,
  SelectQueryBuilder,
} from "typeorm";
import {
  AgentCapability,
  AgentEntity,
  AgentGender,
  AgentLanguage,
} from "entities/agent.entity";
import { AgentKnowledgeAgentEntity, AgentKnowledgeEntity } from "entities/agent.entity";
import { AiProviderEntity } from "entities/ai.entity";
import { Role, User } from "entities/user.entity";
import { IssuePriority, IssueStatusEntity } from "entities/issue.entity";
import { AGENT_USER_CAPABILITIES, expandAgentCapabilities, resolveAgentCapabilities } from "./runtime/agent-runtime.constants";
import {
  CreateAgentDto,
  CreateAgentKnowledgeDto,
  ResetAgentKnowledgeDto,
  UpdateAgentDto,
  UpdateAgentKnowledgeDto,
} from "dto/agent.dto";
import { tenantId } from "src/category/category.service";
import { TranslationService } from "common/translation.service";
import * as ExcelJS from "exceljs";

const LIST_PAGE_LIMIT = 20;
const LIST_PAGE_LIMIT_MAX = 100;
const AGENT_KNOWLEDGE_PROMPT_LIMIT = 20;
const AGENT_KNOWLEDGE_CONTENT_CLIP = 2000;

@Injectable()
export class AgentsService {
  constructor(
    @InjectRepository(AgentEntity)
    private readonly agentRepo: Repository<AgentEntity>,
    @InjectRepository(AiProviderEntity)
    private readonly providerRepo: Repository<AiProviderEntity>,
    @InjectRepository(AgentKnowledgeEntity)
    private readonly knowledgeRepo: Repository<AgentKnowledgeEntity>,
    @InjectRepository(AgentKnowledgeAgentEntity)
    private readonly knowledgeAgentRepo: Repository<AgentKnowledgeAgentEntity>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(IssueStatusEntity)
    private readonly issueStatusRepo: Repository<IssueStatusEntity>,
    private readonly dataSource: DataSource,
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

  private present(
    agent: AgentEntity,
    knowledgeIds?: string[],
    knowledgeCount?: number,
  ) {
    const provider = agent.responseProvider;
    return {
      ...agent,
      responseProvider: provider
        ? { id: provider.id, name: provider.name, code: provider.code }
        : null,
      ...(knowledgeIds !== undefined ? { knowledgeIds } : {}),
      ...(knowledgeCount !== undefined ? { knowledgeCount } : {}),
    };
  }

  private presentKnowledge(knowledge: AgentKnowledgeEntity, agentIds?: string[]) {
    return {
      ...knowledge,
      ...(agentIds !== undefined ? { agentIds } : {}),
    };
  }

  /** Dedupe + drop unknown values; undefined stays undefined (no change). */
  private sanitizeCapabilities(
    capabilities: AgentCapability[] | undefined,
  ): AgentCapability[] | undefined {
    if (capabilities === undefined) return undefined;
    return expandAgentCapabilities(capabilities);
  }

  private async applyHandoffConfig(
    adminId: string,
    agent: AgentEntity,
    dto: CreateAgentDto | UpdateAgentDto,
    capabilities: AgentCapability[],
  ) {
    const enabled = capabilities.includes(AgentCapability.HUMAN_HANDOFF);
    if (!enabled) {
      agent.handoffAssignedRoleId = null;
      agent.handoffEmployeeIds = null;
      agent.handoffEstimatedMinutes = null;
      agent.handoffPriority = IssuePriority.MEDIUM;
      agent.handoffStatusId = null;
      return;
    }

    const roleId =
      dto.handoffAssignedRoleId !== undefined
        ? dto.handoffAssignedRoleId
        : agent.handoffAssignedRoleId;
    if (!roleId) {
      throw new BadRequestException(
        this.translations.t("domains.agents.handoff_role_required"),
      );
    }
    const role = await this.roleRepo.findOne({ where: { id: roleId } as any });
    if (!role || (!role.isGlobal && role.adminId !== adminId)) {
      throw new BadRequestException(
        this.translations.t("domains.issues.role_not_found"),
      );
    }
    agent.handoffAssignedRoleId = roleId;

    const employeeIds =
      dto.handoffEmployeeIds !== undefined
        ? dto.handoffEmployeeIds
        : agent.handoffEmployeeIds;
    if (employeeIds?.length) {
      const unique = [...new Set(employeeIds)];
      const users = await this.userRepo.find({
        where: { id: In(unique) } as any,
      });
      const ok = users.filter(
        (u) =>
          (u.id === adminId || u.adminId === adminId) &&
          String(u.roleId) === String(roleId),
      );
      if (ok.length !== unique.length) {
        throw new BadRequestException(
          this.translations.t("domains.issues.employee_not_found"),
        );
      }
      agent.handoffEmployeeIds = unique;
    } else {
      agent.handoffEmployeeIds = null;
    }

    if (dto.handoffEstimatedMinutes !== undefined) {
      agent.handoffEstimatedMinutes = dto.handoffEstimatedMinutes || null;
    }
    if (dto.handoffPriority !== undefined) {
      agent.handoffPriority = dto.handoffPriority;
    } else if (!agent.handoffPriority) {
      agent.handoffPriority = IssuePriority.MEDIUM;
    }

    const statusId =
      dto.handoffStatusId !== undefined
        ? dto.handoffStatusId
        : agent.handoffStatusId;
    if (statusId) {
      const status = await this.issueStatusRepo.findOne({
        where: { id: statusId } as any,
      });
      if (!status || (status.system !== true && status.adminId !== adminId)) {
        throw new BadRequestException(
          this.translations.t("domains.issues.status_not_found"),
        );
      }
      agent.handoffStatusId = status.id;
    } else {
      agent.handoffStatusId = null;
    }
  }

  private async assertKnowledge(adminId: string, id: string) {
    const knowledge = await this.knowledgeRepo.findOne({
      where: { id, adminId },
    });
    if (!knowledge) {
      throw new NotFoundException(
        this.translations.t("domains.agents.knowledge_not_found"),
      );
    }
    return knowledge;
  }

  private async assertAgentIds(adminId: string, ids: string[]) {
    const uniqueIds = Array.from(new Set((ids ?? []).filter(Boolean)));
    if (!uniqueIds.length) return uniqueIds;
    const rows = await this.agentRepo.find({
      where: { id: In(uniqueIds), adminId },
      select: { id: true },
    });
    if (rows.length !== uniqueIds.length) {
      throw new BadRequestException(
        this.translations.t("domains.agents.agents_invalid_ids"),
      );
    }
    return uniqueIds;
  }

  private async assertKnowledgeIds(adminId: string, ids: string[]) {
    const uniqueIds = Array.from(new Set((ids ?? []).filter(Boolean)));
    if (!uniqueIds.length) return uniqueIds;
    const rows = await this.knowledgeRepo.find({
      where: { id: In(uniqueIds), adminId },
      select: { id: true },
    });
    if (rows.length !== uniqueIds.length) {
      throw new BadRequestException(
        this.translations.t("domains.agents.knowledge_invalid_ids"),
      );
    }
    return uniqueIds;
  }

  private async knowledgeIdsForAgents(agentIds: string[]) {
    if (!agentIds.length) return new Map<string, string[]>();
    const rows = await this.knowledgeAgentRepo.find({
      where: { agentId: In(agentIds) },
      select: { agentId: true, knowledgeId: true },
    });
    const map = new Map<string, string[]>();
    for (const id of agentIds) map.set(id, []);
    for (const row of rows) map.get(row.agentId)?.push(row.knowledgeId);
    return map;
  }

  private async activeKnowledgeCountForAgents(
    adminId: string,
    agentIds: string[],
  ) {
    if (!agentIds.length) return new Map<string, number>();
    const rows = await this.knowledgeAgentRepo
      .createQueryBuilder("link")
      .innerJoin(
        AgentKnowledgeEntity,
        "knowledge",
        'knowledge.id = link."knowledgeId" AND knowledge."isActive" = true AND knowledge."adminId" = :adminId',
        { adminId },
      )
      .select('link."agentId"', "agentId")
      .addSelect("COUNT(*)", "count")
      .where('link."agentId" IN (:...agentIds)', { agentIds })
      .groupBy('link."agentId"')
      .getRawMany();
    const map = new Map<string, number>();
    for (const id of agentIds) map.set(id, 0);
    for (const row of rows) map.set(row.agentId, Number(row.count ?? 0));
    return map;
  }

  private async replaceAgentKnowledgeWithManager(
    manager: EntityManager,
    agentId: string,
    knowledgeIds: string[],
  ) {
    await manager
      .getRepository(AgentKnowledgeAgentEntity)
      .delete({ agentId });
    if (!knowledgeIds.length) return;
    await manager
      .getRepository(AgentKnowledgeAgentEntity)
      .createQueryBuilder()
      .insert()
      .into(AgentKnowledgeAgentEntity)
      .values(knowledgeIds.map((knowledgeId) => ({ agentId, knowledgeId })))
      .orIgnore()
      .execute();
  }

  private async replaceAgentKnowledge(agentId: string, knowledgeIds: string[]) {
    await this.dataSource.transaction((manager) =>
      this.replaceAgentKnowledgeWithManager(manager, agentId, knowledgeIds),
    );
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
    qb.addSelect(
      `(SELECT COUNT(*) FROM agent_knowledge_agents link` +
        ` INNER JOIN agent_knowledge knowledge ON knowledge.id = link."knowledgeId"` +
        ` AND knowledge."isActive" = true AND knowledge."adminId" = :adminId` +
        ` WHERE link."agentId" = agent.id)`,
      "agent_knowledgeCount",
    );
    const { entities: records, raw } = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getRawAndEntities();

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records: records.map((agent, index) =>
        this.present(
          agent,
          undefined,
          Number(raw[index]?.agent_knowledgeCount ?? 0),
        ),
      ),
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
    const [knowledgeByAgent, countByAgent] = await Promise.all([
      this.knowledgeIdsForAgents([agent.id]),
      this.activeKnowledgeCountForAgents(adminId, [agent.id]),
    ]);
    return this.present(
      agent,
      knowledgeByAgent.get(agent.id) ?? [],
      countByAgent.get(agent.id) ?? 0,
    );
  }

  async create(me: any, dto: CreateAgentDto) {
    const adminId = this.adminIdOf(me);
    const name = dto.name.trim();
    await this.ensureUniqueName(adminId, name);
    if (dto.responseProviderId) {
      await this.assertProvider(adminId, dto.responseProviderId);
    }
    const knowledgeIds =
      dto.knowledgeIds !== undefined
        ? await this.assertKnowledgeIds(adminId, dto.knowledgeIds)
        : undefined;
    const capabilities = this.sanitizeCapabilities(dto.capabilities) ?? [
      ...AGENT_USER_CAPABILITIES,
    ];

    const agent = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AgentEntity);
      const row = repo.create({
          adminId,
          name,
          language: dto.language,
          gender: dto.gender ?? AgentGender.MALE,
          customInstructions: dto.customInstructions?.trim() || null,
          responseProviderId: dto.responseProviderId ?? null,
          isActive: dto.isActive ?? true,
          capabilities,
          acceptImage: dto.acceptImage ?? false,
          acceptVideo: dto.acceptVideo ?? false,
          acceptDocument: dto.acceptDocument ?? false,
          acceptAudio: dto.acceptAudio ?? false,
        });
      await this.applyHandoffConfig(adminId, row, dto, capabilities);
      const saved = await repo.save(row);
      if (knowledgeIds !== undefined) {
        await this.replaceAgentKnowledgeWithManager(
          manager,
          saved.id,
          knowledgeIds,
        );
      }
      return saved;
    });
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
    const knowledgeIds =
      dto.knowledgeIds !== undefined
        ? await this.assertKnowledgeIds(adminId, dto.knowledgeIds)
        : undefined;
    const capabilities = this.sanitizeCapabilities(dto.capabilities);
    if (capabilities !== undefined) existing.capabilities = capabilities;
    if (dto.acceptImage !== undefined) existing.acceptImage = dto.acceptImage;
    if (dto.acceptVideo !== undefined) existing.acceptVideo = dto.acceptVideo;
    if (dto.acceptDocument !== undefined) existing.acceptDocument = dto.acceptDocument;
    if (dto.acceptAudio !== undefined) existing.acceptAudio = dto.acceptAudio;
    await this.applyHandoffConfig(
      adminId,
      existing,
      dto,
      resolveAgentCapabilities(
        capabilities !== undefined ? capabilities : existing.capabilities,
      ),
    );

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(AgentEntity).save(existing);
      if (knowledgeIds !== undefined) {
        await this.replaceAgentKnowledgeWithManager(
          manager,
          existing.id,
          knowledgeIds,
        );
      }
    });
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
    await this.knowledgeAgentRepo.delete({ agentId: existing.id });
    await this.agentRepo.remove(existing);
    return {
      message: this.translations.t("domains.agents.deleted_successfully"),
    };
  }

  private knowledgeFilteredQuery(adminId: string, q: any): SelectQueryBuilder<AgentKnowledgeEntity> {
    const qb = this.knowledgeRepo
      .createQueryBuilder("knowledge")
      .where("knowledge.adminId = :adminId", { adminId });

    if (q?.search) {
      qb.andWhere("(knowledge.title ILIKE :search OR knowledge.content ILIKE :search)", {
        search: `%${String(q.search)}%`,
      });
    }
    if (q?.isActive === true || q?.isActive === "true") {
      qb.andWhere("knowledge.isActive = true");
    } else if (q?.isActive === false || q?.isActive === "false") {
      qb.andWhere("knowledge.isActive = false");
    }

    return qb.orderBy("knowledge.createdAt", "DESC");
  }

  async listKnowledge(me: any, q: any) {
    const adminId = this.adminIdOf(me);
    const page = Math.max(1, parseInt(q?.page) || 1);
    const limit = Math.min(
      LIST_PAGE_LIMIT_MAX,
      Math.max(1, parseInt(q?.limit) || LIST_PAGE_LIMIT),
    );

    const qb = this.knowledgeFilteredQuery(adminId, q);

    const [total, records] = await Promise.all([
      qb.getCount(),
      qb.skip((page - 1) * limit).take(limit).getMany(),
    ]);

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records: records.map((knowledge) => this.presentKnowledge(knowledge)),
    };
  }

  async getKnowledge(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const knowledge = await this.assertKnowledge(adminId, id);
    const links = await this.knowledgeAgentRepo.find({
      where: { knowledgeId: id },
      select: { agentId: true },
    });
    return this.presentKnowledge(
      knowledge,
      links.map((link) => link.agentId),
    );
  }

  async createKnowledge(me: any, dto: CreateAgentKnowledgeDto) {
    const adminId = this.adminIdOf(me);
    const agentIds =
      dto.agentIds !== undefined
        ? await this.assertAgentIds(adminId, dto.agentIds)
        : undefined;
    const knowledge = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AgentKnowledgeEntity);
      const saved = await repo.save(
        repo.create({
          adminId,
          title: dto.title.trim(),
          content: dto.content.trim(),
          isActive: dto.isActive ?? true,
        }),
      );
      if (agentIds?.length) {
        await manager
          .getRepository(AgentKnowledgeAgentEntity)
          .createQueryBuilder()
          .insert()
          .into(AgentKnowledgeAgentEntity)
          .values(agentIds.map((agentId) => ({ agentId, knowledgeId: saved.id })))
          .orIgnore()
          .execute();
      }
      return saved;
    });
    return this.getKnowledge(me, knowledge.id);
  }

  async updateKnowledge(me: any, id: string, dto: UpdateAgentKnowledgeDto) {
    const adminId = this.adminIdOf(me);
    const existing = await this.assertKnowledge(adminId, id);

    if (dto.title !== undefined) existing.title = dto.title.trim();
    if (dto.content !== undefined) existing.content = dto.content.trim();
    if (dto.isActive !== undefined) existing.isActive = dto.isActive;

    await this.knowledgeRepo.save(existing);
    return this.getKnowledge(me, id);
  }

  async removeKnowledge(me: any, id: string) {
    const adminId = this.adminIdOf(me);
    const existing = await this.assertKnowledge(adminId, id);
    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(AgentKnowledgeAgentEntity)
        .delete({ knowledgeId: existing.id });
      await manager.getRepository(AgentKnowledgeEntity).remove(existing);
    });
    return {
      message: this.translations.t("domains.agents.knowledge_deleted_successfully"),
    };
  }

  async resetAgentKnowledge(me: any, agentId: string, dto: ResetAgentKnowledgeDto) {
    const adminId = this.adminIdOf(me);
    const agent = await this.agentRepo.findOne({
      where: { id: agentId, adminId },
    });
    if (!agent) {
      throw new NotFoundException(
        this.translations.t("domains.agents.not_found"),
      );
    }
    const knowledgeIds = await this.assertKnowledgeIds(adminId, dto.knowledgeIds ?? []);
    await this.replaceAgentKnowledge(agent.id, knowledgeIds);
    return this.get(me, agent.id);
  }

  async getPromptKnowledge(adminId: string, agentId: string) {
    if (!adminId || !agentId) return [];
    const rows = await this.knowledgeRepo
      .createQueryBuilder("knowledge")
      .innerJoin(
        AgentKnowledgeAgentEntity,
        "link",
        'link."knowledgeId" = knowledge.id AND link."agentId" = :agentId',
        { agentId },
      )
      .where("knowledge.adminId = :adminId", { adminId })
      .andWhere("knowledge.isActive = true")
      .orderBy("knowledge.createdAt", "ASC")
      // .take(AGENT_KNOWLEDGE_PROMPT_LIMIT)
      .getMany();
    return rows.map((row) => ({
      title: row.title,
      content:
        row.content.length > AGENT_KNOWLEDGE_CONTENT_CLIP
          ? `${row.content.slice(0, AGENT_KNOWLEDGE_CONTENT_CLIP)}…`
          : row.content,
    }));
  }

  async getKnowledgeByIds(adminId: string, ids: string[]) {
    const rows = await this.knowledgeRepo.find({
      where: { id: In(ids), adminId, isActive: true },
      order: { createdAt: "ASC" },
    });
    return rows.map((row) => ({
      title: row.title,
      content:
        row.content.length > AGENT_KNOWLEDGE_CONTENT_CLIP
          ? `${row.content.slice(0, AGENT_KNOWLEDGE_CONTENT_CLIP)}…`
          : row.content,
    }));
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

  async knowledgeStats(me: any) {
    const adminId = this.adminIdOf(me);
    const result = await this.knowledgeRepo
      .createQueryBuilder("knowledge")
      .select("COUNT(*)", "total")
      .addSelect(
        `SUM(CASE WHEN knowledge.isActive = true THEN 1 ELSE 0 END)`,
        "active",
      )
      .where("knowledge.adminId = :adminId", { adminId })
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

  async exportKnowledge(me: any, q?: any) {
    const adminId = this.adminIdOf(me);
    const records = await this.knowledgeFilteredQuery(adminId, q)
      .take(10000)
      .getMany();
    const na = this.translations.t("common.not_applicable");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(
      this.translations.t("domains.agents.export_knowledge_sheet"),
    );
    sheet.columns = [
      {
        header: this.translations.t("domains.agents.export_knowledge_title"),
        key: "title",
        width: 28,
      },
      {
        header: this.translations.t("domains.agents.export_knowledge_content"),
        key: "content",
        width: 60,
      },
      {
        header: this.translations.t("domains.agents.export_knowledge_status"),
        key: "status",
        width: 16,
      },
      {
        header: this.translations.t(
          "domains.agents.export_knowledge_created_at",
        ),
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

    for (const knowledge of records) {
      sheet.addRow({
        title: knowledge.title || na,
        content: knowledge.content || na,
        status: this.translations.t(
          knowledge.isActive
            ? "domains.agents.status_active"
            : "domains.agents.status_inactive",
        ),
        createdAt: knowledge.createdAt
          ? new Date(knowledge.createdAt).toLocaleString()
          : na,
      });
    }

    return workbook.xlsx.writeBuffer();
  }
}
