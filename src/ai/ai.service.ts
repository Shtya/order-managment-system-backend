import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { DateFilterUtil } from "../../common/date-filter.util";
import { EncryptionService } from "../../common/encryption.service";
import { maskSensitiveValue } from "../../common/healpers";
import {
  AiAuthType,
  AiEntityScope,
  AiIntegrationEntity,
  AiIntegrationScope,
  AiModelEntity,
  AiProviderEntity,
  AiProviderProtocol,
  AiRequestSummaryEntity,
  AiRequestSummaryStatus,
  AiWriteToolCallEntity,
  AiWriteToolCallStatus,
  AiDefaultModelEntity,
  AiModelTier,
  AiModelAvailabilityEntity,
} from "../../entities/ai.entity";
import {
  CreateModelDto,
  CreateProviderDto,
  ExportIntegrationsQueryDto,
  ExportModelsQueryDto,
  ExportProvidersQueryDto,
  ExportRequestSummariesQueryDto,
  ExportWriteToolCallsQueryDto,
  IntegrationResponseDto,
  ListIntegrationsQueryDto,
  ListModelsQueryDto,
  ListProvidersQueryDto,
  ListRequestSummariesQueryDto,
  ListWriteToolCallsQueryDto,
  ModelResponseDto,
  ProviderResponseDto,
  RequestSummaryResponseDto,
  SetCredentialsDto,
  SetDefaultModelDto,
  UpdateModelDto,
  UpdateProviderDto,
  WriteToolCallResponseDto,
} from "../../dto/ai.dto";
import { TranslationService } from "../../common/translation.service";
import { AI_CONFIG_TOKEN } from "./ai.constants";
import { AiConfig } from "./interfaces/provider-config.interface";
import { AiProviderCredentials } from "./interfaces/ai-types";
import { AiProviderSelectorService } from "./orchestrator/provider-selector.service";
import { AiProviderAbstract } from "./providers/ai-provider.abstract";
import { AiProviderError } from "./errors/provider.errors";
import { tenantId } from "src/category/category.service";
import { SystemRole } from "entities/user.entity";
import { AiModelType } from "../../entities/ai.entity";

const PROTOCOL_AUTH_MAP: Record<string, AiAuthType> = {
  [AiProviderProtocol.OPENAI_COMPATIBLE]: AiAuthType.API_KEY,
};

@Injectable()
export class AiService {
  constructor(
    @InjectRepository(AiProviderEntity)
    private readonly providerRepo: Repository<AiProviderEntity>,
    @InjectRepository(AiModelEntity)
    private readonly modelRepo: Repository<AiModelEntity>,
    @InjectRepository(AiIntegrationEntity)
    private readonly integrationRepo: Repository<AiIntegrationEntity>,
    @InjectRepository(AiRequestSummaryEntity)
    private readonly summaryRepo: Repository<AiRequestSummaryEntity>,
    @InjectRepository(AiWriteToolCallEntity)
    private readonly writeCallRepo: Repository<AiWriteToolCallEntity>,
    @InjectRepository(AiDefaultModelEntity)
    private readonly defaultModelRepo: Repository<AiDefaultModelEntity>,
    @InjectRepository(AiModelAvailabilityEntity)
    private readonly availabilityRepo: Repository<AiModelAvailabilityEntity>,
    private readonly dataSource: DataSource,
    private readonly translations: TranslationService,
    @Inject(AI_CONFIG_TOKEN) private readonly config: AiConfig,
    private readonly selector: AiProviderSelectorService,
    private readonly encryptionService: EncryptionService,
  ) { }

  // ──────────────────────────── DEFAULT MODEL ────────────────────────────

  async getDefaultModel(me: any) {
    const myAdminId = tenantId(me);
    const isSuperAdmin = me.role?.name === SystemRole.SUPER_ADMIN;

    let record: AiDefaultModelEntity | null = null;

    if (myAdminId) {
      record = await this.defaultModelRepo.findOne({
        where: { adminId: myAdminId },
        relations: ["model", "model.provider"],
      });
    }

    if (!record && isSuperAdmin) {
      record = await this.defaultModelRepo.findOne({
        where: { adminId: null },
        relations: ["model", "model.provider"],
      });
    }

    if (!record) return null;

    const provider = record.model?.provider;
    return {
      id: record.id,
      adminId: record.adminId,
      modelId: record.modelId,
      model: record.model ? record.model : undefined,
      provider: provider ? provider : undefined,
      created_at: record.created_at,
      updated_at: record.updated_at,
    };
  }

  async setDefaultModel(me: any, dto: SetDefaultModelDto) {
    const myAdminId = tenantId(me);
    const isSuperAdmin = me.role?.name === SystemRole.SUPER_ADMIN;

    const model = await this.modelRepo.findOne({
      where: { id: dto.modelId, isActive: true },
      relations: ["provider"],
    });
    if (!model) {
      throw new NotFoundException(
        this.translations.t("domains.ai.model_not_found"),
      );
    }

    const provider = model.provider;
    if (!provider || !provider.isActive) {
      throw new BadRequestException(
        this.translations.t("domains.ai.model_provider_not_active"),
      );
    }

    const isAdminScope = isSuperAdmin
      ? model.adminId === null
      : model.adminId === myAdminId || model.adminId === null;
    if (!isAdminScope) {
      throw new ForbiddenException(
        this.translations.t("domains.ai.model_not_accessible"),
      );
    }

    if (!isSuperAdmin && myAdminId) {
      const integration = await this.integrationRepo.findOne({
        where: { providerId: provider.id, adminId: myAdminId },
      });
      if (!integration || !integration.encryptedCredentials) {
        throw new BadRequestException(
          this.translations.t("domains.ai.credentials_not_configured"),
        );
      }
    }

    const targetAdminId = isSuperAdmin ? null : myAdminId;

    const existing = await this.defaultModelRepo.findOne({
      where: { adminId: targetAdminId },
    });

    if (existing) {
      existing.modelId = dto.modelId;
      await this.defaultModelRepo.save(existing);
      return { id: existing.id, modelId: dto.modelId };
    }

    const created = this.defaultModelRepo.create({
      adminId: targetAdminId,
      modelId: dto.modelId,
    });
    const saved = await this.defaultModelRepo.save(created);
    return { id: saved.id, modelId: dto.modelId };
  }

  async clearDefaultModel(me: any) {
    const myAdminId = tenantId(me);
    const isSuperAdmin = me.role?.name === SystemRole.SUPER_ADMIN;
    const targetAdminId = isSuperAdmin ? null : myAdminId;

    const existing = await this.defaultModelRepo.findOne({
      where: { adminId: targetAdminId },
    });

    if (!existing) return;

    await this.defaultModelRepo.remove(existing);
  }

  async resolveDefaultModel(
    me: any,
  ): Promise<{ modelId: string; providerEntityId: string } | null> {
    const myAdminId = tenantId(me);
    const isSuperAdmin = me.role?.name === SystemRole.SUPER_ADMIN;

    if (myAdminId) {
      const record = await this.defaultModelRepo.findOne({
        where: { adminId: myAdminId },
        relations: ["model", "model.provider"],
      });
      if (record?.model?.provider?.isActive) {
        return {
          modelId: record.model.id,
          providerEntityId: record.model.provider.id,
        };
      }
    }

    if (isSuperAdmin || !myAdminId) {
      const record = await this.defaultModelRepo.findOne({
        where: { adminId: null },
        relations: ["model", "model.provider"],
      });
      if (record?.model?.provider?.isActive) {
        return {
          modelId: record.model.id,
          providerEntityId: record.model.provider.id,
        };
      }
    }

    return null;
  }

  // ──────────────────────────── PROVIDERS ────────────────────────────

  async listProviders(me: any, query: ListProvidersQueryDto) {
    const { scope = "all", isActive, search, code } = query;

    const isSuperAdmin = me.role?.name === SystemRole.SUPER_ADMIN;

    const adminId = tenantId(me);

    const qb = this.providerRepo
      .createQueryBuilder("p")
      .leftJoinAndSelect("p.models", "model")
      .leftJoinAndSelect("p.integrations", "integration")
      .leftJoinAndSelect(
        "model.availabilities",
        "availability",
        "availability.adminId = :adminId",
        { adminId: adminId ?? null },
      );

    /*
     * Scope:
     *
     * system -> providers where adminId IS NULL
     *
     * custom -> providers owned by current admin
     *
     * all:
     *   normal admin -> system + own custom providers
     *   super admin  -> system providers
     */

    if (isActive !== undefined) {
      if (scope === AiEntityScope.SYSTEM) {
        qb.where("p.adminId IS NULL AND p.isActive = true");
      } else if (scope === AiEntityScope.CUSTOM) {
        if (!adminId) return { records: [] };
        qb.where("p.adminId = :adminId AND p.isActive = :isActive", {
          adminId,
          isActive,
        });
      } else {
        if (isSuperAdmin) {
          qb.where("p.adminId IS NULL AND p.isActive = :isActive", {
            isActive,
          });
        } else if (adminId) {
          qb.where(
            "(p.adminId IS NULL AND p.isActive = true) OR " +
            "(p.adminId = :adminId AND p.isActive = :isActive)",
            {
              adminId,
              isActive,
            },
          );
        } else {
          qb.where("p.adminId IS NULL AND p.isActive = true");
        }
      }
    } else {
      if (scope === AiEntityScope.SYSTEM) {
        qb.where("p.adminId IS NULL AND p.isActive = true");
      } else if (scope === AiEntityScope.CUSTOM) {
        if (!adminId) return { records: [] };
        qb.where("p.adminId = :adminId", { adminId });
      } else {
        if (isSuperAdmin) {
          qb.where("p.adminId IS NULL AND p.isActive = true");
        } else if (adminId) {
          qb.where(
            "(p.adminId IS NULL AND p.isActive = true) OR (p.adminId = :adminId)",
            { adminId },
          );
        } else {
          qb.where("p.adminId IS NULL AND p.isActive = true");
        }
      }
    }

    if (code) {
      qb.andWhere("LOWER(p.code) = LOWER(:code)", { code });
    }

    if (search) {
      qb.andWhere(
        `(
        LOWER(p.name) LIKE LOWER(:search)
        OR LOWER(p.code) LIKE LOWER(:search)
        OR LOWER(model.name) LIKE LOWER(:search)
        OR LOWER(model.modelCode) LIKE LOWER(:search)
      )`,
        {
          search: `%${search}%`,
        },
      );
    }

    qb.orderBy("p.name", "ASC");
    qb.addOrderBy("model.name", "ASC");

    const providers = await qb.getMany();

    const records = providers.map((provider) => ({
      ...provider,

      integration: provider.integrations?.[0]
        ? this.toIntegrationResponse(provider.integrations[0])
        : undefined,

      models: (provider.models ?? []).map((model) => ({
        id: model.id,
        displayName: model.name,
        modelCode: model.modelCode,
        isActive: model.isActive,

        // No availability row = available by default
        isAvailable: model.availabilities?.[0]?.isAvailable ?? true,
      })),
    }));

    return {
      records,
    };
  }

  async getProvider(me: any, id: string) {
    const provider = await this.findProviderWithAccess(me, id);

    const myAdminId = tenantId(me);

    const qb = this.modelRepo
      .createQueryBuilder("model")
      .leftJoinAndSelect(
        "model.availabilities",
        "availability",
        "availability.adminId = :adminId",
        { adminId: myAdminId ?? null },
      )
      .where("model.providerId = :providerId", {
        providerId: id,
      })
      .orderBy("model.name", "ASC");

    const models = await qb.getMany();

    const integration = (provider as any).integrations?.[0];

    return {
      ...this.toProviderResponse(provider, models),
      integration: integration
        ? this.toIntegrationResponse(integration)
        : undefined,
    };
  }

  async createProvider(me: any, dto: CreateProviderDto) {
    const myAdminId = tenantId(me);
    if (!myAdminId) {
      throw new ForbiddenException(
        this.translations.t("domains.ai.provider_not_custom"),
      );
    }

    const existing = await this.providerRepo.findOne({
      where: { name: dto.name, adminId: myAdminId },
    });
    if (existing) {
      throw new BadRequestException(
        this.translations.t("domains.ai.provider_already_exists"),
      );
    }

    const existingCode = await this.providerRepo.findOne({
      where: { code: dto.code, adminId: myAdminId },
    });
    if (existingCode) {
      throw new BadRequestException(
        this.translations.t("domains.ai.provider_code_exists"),
      );
    }

    const { baseUrl, credentials, ...providerData } = dto;
    const protocol = dto.protocol ?? AiProviderProtocol.OPENAI_COMPATIBLE;
    const authType =
      dto.authType ?? PROTOCOL_AUTH_MAP[protocol] ?? AiAuthType.API_KEY;

    const saved = await this.dataSource.transaction(async (mgr) => {
      const provider = mgr.create(AiProviderEntity, {
        ...providerData,
        logoUrl: null,
        adminId: myAdminId,
        tenantIntegrationAllowed: true,
        scope: AiEntityScope.CUSTOM,
        protocol,
        authType,
      });
      const p = await mgr.save(provider);

      if (credentials?.apiKey) {
        const testResult = await this.testProvider(
          p,
          { apiKey: credentials.apiKey },
          baseUrl,
        );

        if (!testResult.valid) {
          throw new BadRequestException(
            testResult.message ??
            this.translations.t("domains.ai.credentials_invalid_api_key"),
          );
        }
      }
      if (baseUrl || credentials) {
        const encrypted = credentials
          ? this.encryptionService.encrypt(JSON.stringify(credentials))
          : undefined;
        const integration = mgr.create(AiIntegrationEntity, {
          providerId: p.id,
          adminId: myAdminId,
          scope: AiIntegrationScope.TENANT,
          authType,
          baseUrl,
          encryptedCredentials: encrypted,
          isActive: true,
        });
        await mgr.save(integration);
      }

      return p;
    });



    return saved;
  }

  async updateProvider(me: any, id: string, dto: UpdateProviderDto) {
    const provider = await this.findCustomProviderWithAccess(me, id);

    if (dto.name && dto.name !== provider.name) {
      const existing = await this.providerRepo.findOne({
        where: { name: dto.name, adminId: provider.adminId },
      });
      if (existing) {
        throw new BadRequestException(
          this.translations.t("domains.ai.provider_already_exists"),
        );
      }
    }

    if (dto.code && dto.code !== provider.code) {
      const existingCode = await this.providerRepo.findOne({
        where: { code: dto.code, adminId: provider.adminId },
      });
      if (existingCode) {
        throw new BadRequestException(
          this.translations.t("domains.ai.provider_code_exists"),
        );
      }
    }

    const { baseUrl, credentials, ...providerData } = dto;
    const protocol = dto.protocol ?? provider.protocol;
    const authType =
      dto.authType ??
      (protocol ? PROTOCOL_AUTH_MAP[protocol] : undefined) ??
      provider.authType;

    return this.dataSource.transaction(async (mgr) => {
      Object.assign(provider, providerData);
      if (protocol) provider.protocol = protocol;
      if (authType) provider.authType = authType;
      await mgr.save(provider);

      const hasIntegrationConfig = baseUrl !== undefined || credentials;
      if (hasIntegrationConfig) {
        let integration = await mgr.findOne(AiIntegrationEntity, {
          where: { providerId: id, adminId: provider.adminId },
        });

        const encrypted = credentials
          ? this.encryptionService.encrypt(JSON.stringify(credentials))
          : undefined;

        if (integration) {
          if (baseUrl !== undefined) integration.baseUrl = baseUrl;
          if (encrypted) (integration as any).encryptedCredentials = encrypted;
          if (authType) integration.authType = authType;
          await mgr.save(integration);
        } else {
          integration = mgr.create(AiIntegrationEntity, {
            providerId: id,
            adminId: provider.adminId,
            scope: AiIntegrationScope.TENANT,
            authType: authType ?? AiAuthType.API_KEY,
            baseUrl,
            encryptedCredentials: encrypted,
            isActive: true,
          });
          await mgr.save(integration);
        }
      }

      return provider;
    });
  }

  async deleteProvider(me: any, id: string) {
    const provider = await this.findCustomProviderWithAccess(me, id);
    const models = await this.modelRepo.find({ where: { providerId: id } });
    if (models.length) {
      await this.modelRepo.remove(models);
    }
    await this.providerRepo.remove(provider);
  }

  async toggleProviderActive(
    me: any,
    providerId: string,
    dto: { isActive: boolean },
  ) {
    const provider = await this.findCustomProviderWithAccess(me, providerId);

    provider.isActive = dto.isActive;
    await this.providerRepo.save(provider);
    return { ok: true, isActive: dto.isActive };
  }

  // ──────────────────────────── MODELS ────────────────────────────

  async listModels(me: any, query: ListModelsQueryDto) {
    const {
      providerId,
      providerCode,
      modelType,
      tier,
      isActive,
      scope,
      search,
    } = query;
    const myAdminId = tenantId(me);

    const limit = Number(query.limit) || 50;
    const sortDir: "ASC" | "DESC" =
      String(query.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
    const cursor = query.cursor;

    const qb = this.modelRepo.createQueryBuilder("m");
    qb.leftJoin("m.provider", "provider");
    qb.leftJoin("provider.integrations", "providerIntegration");

    qb.addSelect([
      "m",
      "provider.id",
      "provider.name",
      "provider.code",
      "provider.logoUrl",
      "provider.adminId",
      "provider.isActive",
      "providerIntegration.id",
      "providerIntegration.adminId",
      "providerIntegration.baseUrl",
      "providerIntegration.encryptedCredentials",
    ]);

    if (myAdminId) {
      qb.where("(m.adminId = :adminId OR m.adminId IS NULL)", {
        adminId: myAdminId,
      });
    }
    if (providerId) qb.andWhere("m.providerId = :providerId", { providerId });
    if (providerCode) {
      qb.andWhere("provider.code = :providerCode", { providerCode });
    }
    if (modelType) qb.andWhere("m.modelType = :modelType", { modelType });
    if (tier) qb.andWhere("m.tier = :tier", { tier });
    if (isActive !== undefined) {
      qb.andWhere("m.isActive = :isActive", { isActive });
    } else {
      qb.andWhere(
        "((m.adminId IS NULL AND m.isActive = true AND provider.isActive = true) OR (m.adminId IS NOT NULL))",
      );
    }
    if (scope) {
      if (scope === "system") qb.andWhere("m.adminId IS NULL");
      else if (scope === "custom" && myAdminId) {
        qb.andWhere("m.adminId = :adminId", { adminId: myAdminId });
      }
    }

    if (search) {
      qb.andWhere(
        `(
					LOWER(m.name) LIKE LOWER(:search)
					OR LOWER(m.modelCode) LIKE LOWER(:search)
					OR LOWER(provider.name) LIKE LOWER(:search)
					OR LOWER(provider.code) LIKE LOWER(:search)
				)`,
        { search: `%${search}%` },
      );
    }

    if (cursor) {
      const operator = sortDir === "DESC" ? "<" : ">";
      qb.andWhere(`(m.created_at, m.id) ${operator} (:cursorValue, :cursorId)`, {
        cursorValue: cursor.value,
        cursorId: cursor.id,
      });
    }

    qb.orderBy("m.created_at", sortDir);
    qb.addOrderBy("m.id", sortDir);

    const rows = await qb.take(limit + 1).getMany();
    const hasMore = rows.length > limit;
    const records = hasMore ? rows.slice(0, limit) : rows;
    const last = records[records.length - 1];

    let availabilityMap: Map<string, boolean> | undefined;
    if (myAdminId && records.length > 0) {
      const modelIds = records.map((m) => m.id);
      const availRows = await this.availabilityRepo.find({
        where: modelIds.map((modelId) => ({ adminId: myAdminId, modelId })),
      });
      availabilityMap = new Map(availRows.map((a) => [a.modelId, a.isAvailable]));
    }

    const mapped = records.map((m) => this.toModelResponse(m, availabilityMap));

    return {
      records: mapped,
      hasMore,
      limit,
      nextCursor: hasMore ? { value: last.created_at, id: last.id } : undefined,
      sortBy: "created_at",
      sortDir,
    };
  }

  async getModel(me: any, id: string) {
    const model = await this.findModelWithAccess(me, id);
    return this.toModelResponse(model);
  }

  async createModel(me: any, dto: CreateModelDto) {
    const myAdminId = tenantId(me);
    if (!myAdminId) {
      throw new ForbiddenException(
        this.translations.t("domains.ai.provider_not_custom"),
      );
    }

    const provider = await this.findProviderWithAccess(me, dto.providerId);
    if (provider.adminId !== myAdminId) {
      throw new ForbiddenException(
        this.translations.t("domains.ai.provider_not_custom"),
      );
    }

    const existing = await this.modelRepo.findOne({
      where: { providerId: dto.providerId, modelCode: dto.modelCode },
    });
    if (existing) {
      throw new BadRequestException(
        this.translations.t("domains.ai.model_already_exists"),
      );
    }

    const integration = (provider as any).integrations?.[0];
    if (integration?.encryptedCredentials) {
      const decrypted = this.encryptionService.decrypt(
        integration.encryptedCredentials.ciphertext,
        integration.encryptedCredentials.iv,
        integration.encryptedCredentials.tag,
      );
      const credentials = JSON.parse(decrypted);
      const testResult = await this.testProviderCredentials(
        provider,
        credentials as AiProviderCredentials,
        integration.baseUrl,
        dto.modelCode,
      );
      if (!testResult.valid) {
        throw new BadRequestException(
          testResult.message ??
          this.translations.t("domains.ai.credentials_invalid_api_key"),
        );
      }
    }

    const model = this.modelRepo.create({
      ...dto,
      tier: AiModelTier.PRO,
      adminId: myAdminId,
      scope: AiEntityScope.CUSTOM,
    });
    const saved = await this.modelRepo.save(model);
    return saved;
  }

  async updateModel(me: any, id: string, dto: UpdateModelDto) {
    const model = await this.findModelWithAccess(me, id);
    this.ensureWritable({ adminId: model.adminId, scope: model.scope }, me);

    if (dto.modelCode && dto.modelCode !== model.modelCode) {
      const existing = await this.modelRepo.findOne({
        where: { providerId: model.providerId, modelCode: dto.modelCode },
      });
      if (existing) {
        throw new BadRequestException(
          this.translations.t("domains.ai.model_already_exists"),
        );
      }

      const provider = await this.findProviderWithAccess(me, model.providerId);
      const integration = (provider as any).integrations?.[0];
      if (integration?.encryptedCredentials) {
        const decrypted = this.encryptionService.decrypt(
          integration.encryptedCredentials.ciphertext,
          integration.encryptedCredentials.iv,
          integration.encryptedCredentials.tag,
        );
        const credentials = JSON.parse(decrypted);
        const testResult = await this.testProviderCredentials(
          provider,
          credentials as AiProviderCredentials,
          integration.baseUrl,
          dto.modelCode,
        );
        if (!testResult.valid) {
          throw new BadRequestException(
            testResult.message ??
            this.translations.t("domains.ai.credentials_invalid_api_key"),
          );
        }
      }
    }

    Object.assign(model, dto);
    const saved = await this.modelRepo.save(model);
    return saved;
  }

  async deleteModel(me: any, id: string) {
    const model = await this.findModelWithAccess(me, id);
    this.ensureWritable({ adminId: model.adminId, scope: model.scope }, me);
    await this.modelRepo.remove(model);
  }

  async toggleModelActive(
    me: any,
    modelId: string,
    dto: { isActive: boolean },
  ) {
    const model = await this.findModelWithAccess(me, modelId);
    this.ensureWritable({ adminId: model.adminId, scope: model.scope }, me);

    model.isActive = dto.isActive;
    await this.modelRepo.save(model);
    return { ok: true, isActive: dto.isActive };
  }

  // ──────────────────────────── INTEGRATIONS ────────────────────────────

  async listIntegrations(me: any, query?: ListIntegrationsQueryDto) {
    const isSuperAdmin = me.role?.name === SystemRole.SUPER_ADMIN;
    const myAdminId = tenantId(me);
    const { providerId, isActive, scope, search } = query ?? {};

    const limit = Number(query?.limit) || 50;
    const sortDir: "ASC" | "DESC" =
      String(query?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
    const cursor = query?.cursor;

    const qb = this.integrationRepo.createQueryBuilder("i");
    qb.leftJoinAndSelect("i.provider", "provider");

    if (!isSuperAdmin && myAdminId) {
      qb.where("i.adminId = :adminId", { adminId: myAdminId });
    } else if (scope === "system") {
      qb.where("i.adminId IS NULL");
    } else if (scope === "tenant") {
      if (myAdminId) qb.where("i.adminId = :adminId", { adminId: myAdminId });
      else {
        return {
          records: [],
          hasMore: false,
          limit,
          nextCursor: undefined,
          sortBy: "created_at",
          sortDir,
        };
      }
    }

    if (providerId) qb.andWhere("i.providerId = :providerId", { providerId });
    if (isActive !== undefined) {
      qb.andWhere("i.isActive = :isActive", { isActive });
    }

    if (search) {
      const s = `%${search}%`;
      qb.andWhere("LOWER(provider.name) LIKE LOWER(:s)", { s });
    }

    if (cursor) {
      const operator = sortDir === "DESC" ? "<" : ">";
      qb.andWhere(`(i.created_at, i.id) ${operator} (:cursorValue, :cursorId)`, {
        cursorValue: cursor.value,
        cursorId: cursor.id,
      });
    }

    qb.orderBy("i.created_at", sortDir);
    qb.addOrderBy("i.id", sortDir);

    const rows = await qb.take(limit + 1).getMany();
    const hasMore = rows.length > limit;
    const records = hasMore ? rows.slice(0, limit) : rows;
    const last = records[records.length - 1];

    const mapped = records.map((i) => {
      let maskedCredentials: Record<string, any> | undefined;
      if (i.encryptedCredentials) {
        try {
          const decrypted = this.encryptionService.decrypt(
            i.encryptedCredentials.ciphertext,
            i.encryptedCredentials.iv,
            i.encryptedCredentials.tag,
          );
          const creds = JSON.parse(decrypted);
          maskedCredentials = {};
          for (const [key, value] of Object.entries(creds)) {
            if (key === "apiKey" && typeof value === "string") {
              maskedCredentials[key] = maskSensitiveValue(value);
            } else {
              maskedCredentials[key] = value;
            }
          }
        } catch {
          maskedCredentials = undefined;
        }
      }

      return {
        ...i,
        providerId: i.providerId,
        providerName: i.provider?.name ?? "",
        authType: i.authType ?? i.provider?.authType,
        credentials: maskedCredentials,
        credentialsConfigured: !!i.encryptedCredentials,
        lastValidatedAt: i.lastValidatedAt,
        lastError: i.lastError,
        scope: i.scope,
        created_at: i.created_at,
        updated_ut: i.updated_ut,
      };
    });

    return {
      records: mapped,
      hasMore,
      limit,
      nextCursor: hasMore ? { value: last.created_at, id: last.id } : undefined,
      sortBy: "created_at",
      sortDir,
    };
  }

  async getIntegration(me: any, providerId: string) {
    const myAdminId = tenantId(me);
    const where: any = { providerId };
    if (myAdminId) where.adminId = myAdminId;

    const integration = await this.integrationRepo.findOne({
      where,
      relations: ["provider"],
    });
    if (!integration) {
      throw new NotFoundException(
        this.translations.t("domains.ai.integration_not_found"),
      );
    }

    let maskedCredentials: Record<string, any> | undefined;
    if (integration.encryptedCredentials) {
      try {
        const decrypted = this.encryptionService.decrypt(
          integration.encryptedCredentials.ciphertext,
          integration.encryptedCredentials.iv,
          integration.encryptedCredentials.tag,
        );
        const creds = JSON.parse(decrypted);
        maskedCredentials = {};
        for (const [key, value] of Object.entries(creds)) {
          if (key === "apiKey" && typeof value === "string") {
            maskedCredentials[key] = maskSensitiveValue(value);
          } else {
            maskedCredentials[key] = value;
          }
        }
      } catch {
        maskedCredentials = undefined;
      }
    }

    return {
      ...integration,
      credentials: maskedCredentials,
    };
  }

  async setCredentials(me: any, providerId: string, dto: SetCredentialsDto) {
    const myAdminId = tenantId(me);
    if (!myAdminId) {
      throw new ForbiddenException(
        this.translations.t("domains.ai.provider_not_custom"),
      );
    }

    const provider = await this.findProviderWithAccess(me, providerId);
    const authType = provider.authType ?? AiAuthType.API_KEY;

    if (dto.credentials?.apiKey) {
      const testResult = await this.testProvider(
        provider,
        { apiKey: dto.credentials.apiKey },
        dto.baseUrl,
      );
      if (!testResult.valid) {
        throw new BadRequestException(
          testResult.message ??
          this.translations.t("domains.ai.credentials_invalid_api_key"),
        );
      }
    }

    const result = await this.dataSource.transaction(async (mgr) => {
      let integration = await mgr.findOne(AiIntegrationEntity, {
        where: { providerId, adminId: myAdminId },
      });

      const encrypted = dto.credentials
        ? this.encryptionService.encrypt(JSON.stringify(dto.credentials))
        : undefined;

      if (integration) {
        integration.baseUrl = dto.baseUrl ?? integration.baseUrl;
        if (encrypted) (integration as any).encryptedCredentials = encrypted;
        integration.authType = authType;
      } else {
        integration = mgr.create(AiIntegrationEntity, {
          providerId,
          adminId: myAdminId,
          scope: AiIntegrationScope.TENANT,
          authType,
          encryptedCredentials: encrypted,
          baseUrl: dto.baseUrl,
          isActive: true,
        });
      }

      const saved = await mgr.save(integration);

      return {
        credentialsConfigured: true,
      };
    });

    if (dto.credentials?.apiKey) {
      try {
        await this.syncModels(me, providerId, {
          apiKey: dto.credentials.apiKey,
          baseUrl: dto.baseUrl,
        });
      } catch {
        // sync failure should not block credential setting
      }
    }

    return result;
  }

  async testCredentials(me: any, providerId: string, modelCode?: string) {
    const myAdminId = tenantId(me);
    const where: any = { providerId };
    if (myAdminId) where.adminId = myAdminId;

    const integration = await this.integrationRepo.findOne({
      where,
      select: [
        "id",
        "providerId",
        "adminId",
        "encryptedCredentials",
        "authType",
        "baseUrl",
        "lastValidatedAt",
        "lastError",
        "scope",
        "created_at",
        "updated_ut",
      ],
      relations: ["provider"],
    });

    if (!integration) {
      return {
        valid: false,
        message: this.translations.t("domains.ai.credentials_not_configured"),
        lastValidatedAt: null,
      };
    }

    if (!integration.encryptedCredentials) {
      return {
        valid: false,
        message: this.translations.t("domains.ai.credentials_not_configured"),
        lastValidatedAt: null,
      };
    }

    try {
      const decrypted = this.encryptionService.decrypt(
        integration.encryptedCredentials.ciphertext,
        integration.encryptedCredentials.iv,
        integration.encryptedCredentials.tag,
      );
      const credentials = JSON.parse(decrypted);
      const result = await this.testProviderCredentials(
        integration.provider,
        credentials as AiProviderCredentials,
        integration.baseUrl,
        modelCode,
      );

      await this.integrationRepo.update(integration.id, {
        lastValidatedAt: new Date(),
        lastError: result.valid ? null : result.message,
      });

      return {
        valid: result.valid,
        message: result.message,
        lastValidatedAt: new Date(),
      };
    } catch (err: any) {
      const errorMsg =
        err?.message ??
        this.translations.t("domains.ai.credentials_test_error");
      await this.integrationRepo.update(integration.id, {
        lastValidatedAt: new Date(),
        lastError: errorMsg,
      });
      return {
        valid: false,
        message: this.translations.t("domains.ai.credentials_test_failed"),
        lastValidatedAt: new Date(),
      };
    }
  }

  private resolveBaseProvider(
    provider: AiProviderEntity,
  ): AiProviderAbstract | undefined {
    const baseProviders = this.selector.getAllBaseProviders();

    if (provider.scope === AiEntityScope.CUSTOM && provider.protocol) {
      return baseProviders.find((p) => p.kind === provider.protocol);
    }

    return (
      baseProviders.find((p) => p.kind === provider.code) ??
      baseProviders.find((p) => p.kind === provider.protocol)
    );
  }

  private async testProviderCredentials(
    provider: AiProviderEntity,
    credentials: AiProviderCredentials,
    baseUrl?: string,
    modelCode?: string,
  ): Promise<{ valid: boolean; message?: string }> {
    const baseProvider = this.resolveBaseProvider(provider);
    if (!baseProvider) {
      return {
        valid: false,
        message: this.translations.t("domains.ai.provider_class_not_found", {
          args: { code: provider.code ?? provider.protocol },
        }),
      };
    }

    try {
      const testInstance = baseProvider.cloneWithRuntime({
        apiKey: credentials.apiKey,
        baseUrl: baseUrl ?? undefined,
        model: modelCode ?? undefined,
      });
      await testInstance.callModel({
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        toolChoice: "none",
        maxTokens: 1,
      });

      return { valid: true };
    } catch (err: any) {
      if (err instanceof AiProviderError && err.kind === "AUTH") {
        return {
          valid: false,
          message: this.translations.t(
            "domains.ai.credentials_invalid_api_key",
          ),
        };
      }
      return {
        valid: false,
        message:
          err?.message ??
          this.translations.t("domains.ai.credentials_test_error"),
      };
    }
  }

  private async testProvider(
    provider: AiProviderEntity,
    credentials: AiProviderCredentials,
    baseUrl?: string,
  ): Promise<{ valid: boolean; message?: string }> {
    const baseProvider = this.resolveBaseProvider(provider);
    if (!baseProvider) {
      return {
        valid: false,
        message: this.translations.t("domains.ai.provider_class_not_found", {
          args: { code: provider.code ?? provider.protocol },
        }),
      };
    }

    try {
      const testInstance = baseProvider.cloneWithRuntime({
        apiKey: credentials.apiKey,
        baseUrl: baseUrl ?? undefined,
      });
      await testInstance.getModels();
      return { valid: true };
    } catch (err: any) {
      const status = err?.providerStatus ?? err?.status;
      const isAuth =
        (err instanceof AiProviderError && err.kind === "AUTH") ||
        status === 401 ||
        status === 403;

      if (isAuth) {
        return {
          valid: false,
          message: this.translations.t(
            "domains.ai.credentials_invalid_api_key",
          ),
        };
      }
      return {
        valid: false,
        message:
          err?.message ??
          this.translations.t("domains.ai.credentials_test_error"),
      };
    }
  }

  async deleteIntegration(me: any, providerId: string) {
    const myAdminId = tenantId(me);
    const where: any = { providerId };
    if (myAdminId) where.adminId = myAdminId;

    const integration = await this.integrationRepo.findOne({ where });
    if (!integration) {
      throw new NotFoundException(
        this.translations.t("domains.ai.integration_not_found"),
      );
    }

    (integration as any).encryptedCredentials = null;
    await this.integrationRepo.save(integration);
  }

  async deleteCustomModel(me: any, id: string) {
    const myAdminId = tenantId(me);
    const model = await this.modelRepo.findOne({
      where: { id, adminId: myAdminId },
    });
    if (!model) {
      throw new NotFoundException(
        this.translations.t("domains.ai.model_not_found"),
      );
    }
    await this.modelRepo.remove(model);
  }

  async syncModels(
    me: any,
    providerId: string,
    credentials?: { apiKey?: string; baseUrl?: string },
  ) {
    const adminId = tenantId(me);
    const provider = await this.findProviderWithAccess(me, providerId);

    const baseProvider = this.resolveBaseProvider(provider);
    if (!baseProvider) {
      throw new BadRequestException(
        this.translations.t("domains.ai.provider_class_not_found", {
          args: { code: provider.code ?? provider.protocol },
        }),
      );
    }

    const runtimeConfig: Record<string, any> = {};

    if (credentials?.apiKey) {
      runtimeConfig.apiKey = credentials.apiKey;
    }

    if (credentials?.baseUrl) {
      runtimeConfig.baseUrl = credentials.baseUrl;
    }

    if (!runtimeConfig.apiKey) {
      const integration = (provider as any).integrations?.[0];
      if (integration?.encryptedCredentials) {
        try {
          const decrypted = this.encryptionService.decrypt(
            integration.encryptedCredentials.ciphertext,
            integration.encryptedCredentials.iv,
            integration.encryptedCredentials.tag,
          );
          const parsed = JSON.parse(decrypted);
          if (parsed.apiKey) runtimeConfig.apiKey = parsed.apiKey;
          if (!runtimeConfig.baseUrl && integration.baseUrl) {
            runtimeConfig.baseUrl = integration.baseUrl;
          }
        } catch {
          // proceed without credentials
        }
      } else if (integration?.baseUrl && !runtimeConfig.baseUrl) {
        runtimeConfig.baseUrl = integration.baseUrl;
      }
    }

    const instance = baseProvider.cloneWithRuntime(runtimeConfig);
    const remoteModels = await instance.getModels();

    const existingModels = await this.modelRepo.find({
      where: { providerId },
      select: ["modelCode", "id"],
    });
    const existingCodes = new Set(existingModels.map((m) => m.modelCode));

    const toCreate: AiModelEntity[] = [];
    const skipped: string[] = [];

    for (const remote of remoteModels) {
      if (existingCodes.has(remote.modelCode)) {
        skipped.push(remote.modelCode);
        continue;
      }

      toCreate.push(
        this.modelRepo.create({
          providerId,
          adminId: provider.adminId,
          scope: AiEntityScope.CUSTOM,
          modelCode: remote.modelCode,
          name: remote.name,
          description: remote.description,
          modelType: remote.modelType ?? AiModelType.TEXT,
          tier: remote.tier,
          contextWindow: remote.contextWindow,
          stream: remote.stream,
          jsonMode: remote.jsonMode,
          reasoning: remote.reasoning,
          toolsCalling: remote.toolsCalling,
          metadata: remote.metadata,
          isActive: true,
        }),
      );
    }

    const saved = await this.modelRepo.save(toCreate);

    const remoteCodes = new Set(remoteModels.map((m) => m.modelCode));

    if (adminId) {
      const affectedModels = existingModels;

      if (affectedModels.length > 0) {
        const existingAvail = await this.availabilityRepo.find({
          where: affectedModels.map((m) => ({
            adminId,
            modelId: m.id,
          })),
        });

        const existingAvailMap = new Map(
          existingAvail.map((a) => [a.modelId, a]),
        );

        const toSave = affectedModels
          .map((model) => {
            const existing = existingAvailMap.get(model.id);
            const isAvailable = remoteCodes.has(model.modelCode);

            if (existing) {
              // Only update if the value actually changed
              if (existing.isAvailable !== isAvailable) {
                existing.isAvailable = isAvailable;
                return existing;
              }

              return null;
            }

            return this.availabilityRepo.create({
              adminId,
              modelId: model.id,
              isAvailable,
            });
          })
          .filter(Boolean);

        if (toSave.length > 0) {
          await this.availabilityRepo.save(toSave);
        }
      }
    }

    return {
      providerId,
      providerName: provider.name,
      total: remoteModels.length,
      created: saved.length,
      skipped: skipped.length,
      models: saved.map((m) => ({
        id: m.id,
        modelCode: m.modelCode,
        name: m.name,
      })),
    };
  }

  // ──────────────────────────── AUDIT: REQUEST SUMMARIES ────────────────────────────

  async listRequestSummaries(me: any, query: ListRequestSummariesQueryDto) {
    const {
      page = 1,
      limit = 20,
      status,
      providerId,
      modelId,
      startDate,
      endDate,
      adminId,
    } = query;

    const qb = this.summaryRepo.createQueryBuilder("s");
    qb.leftJoinAndSelect("s.provider", "provider");
    qb.leftJoinAndSelect("s.model", "model");

    if (adminId) qb.andWhere("s.adminId = :adminId", { adminId });
    if (status) qb.andWhere("s.status = :status", { status });
    if (providerId) qb.andWhere("s.providerId = :providerId", { providerId });
    if (modelId) qb.andWhere("s.modelId = :modelId", { modelId });

    if (startDate || endDate) {
      DateFilterUtil.applyToQueryBuilder(qb, "s.createdAt", startDate, endDate);
    }

    const total = await qb.getCount();
    qb.orderBy("s.createdAt", "DESC");
    qb.skip((page - 1) * limit).take(limit);

    const entities = await qb.getMany();
    return {
      records: entities.map((e) => this.toSummaryResponse(e)),
      total,
      page,
      limit,
    };
  }

  async getRequestSummary(me: any, id: string) {
    const summary = await this.summaryRepo.findOne({
      where: { id },
      relations: ["provider", "model"],
    });
    if (!summary) {
      throw new NotFoundException(
        this.translations.t("domains.ai.audit_request_not_found"),
      );
    }
    return this.toSummaryResponse(summary);
  }

  async getRequestSummaryProgress(me: any, id: string) {
    const summary = await this.summaryRepo.findOne({
      where: { id },
      select: ["id", "progress"],
    });
    if (!summary) {
      throw new NotFoundException(
        this.translations.t("domains.ai.audit_request_not_found"),
      );
    }
    return summary.progress ?? [];
  }

  // ──────────────────────────── AUDIT: WRITE TOOL CALLS ────────────────────────────

  async listWriteToolCalls(me: any, query: ListWriteToolCallsQueryDto) {
    const { page = 1, limit = 20, status, toolName, adminId } = query;

    const qb = this.writeCallRepo.createQueryBuilder("w");
    qb.leftJoinAndSelect("w.provider", "provider");
    qb.leftJoinAndSelect("w.model", "model");

    if (adminId) qb.andWhere("w.adminId = :adminId", { adminId });
    if (status) qb.andWhere("w.status = :status", { status });
    if (toolName) qb.andWhere("w.toolName = :toolName", { toolName });

    const total = await qb.getCount();
    qb.orderBy("w.createdAt", "DESC");
    qb.skip((page - 1) * limit).take(limit);

    const entities = await qb.getMany();
    return {
      records: entities.map((e) => this.toWriteCallResponse(e)),
      total,
      page,
      limit,
    };
  }

  async getWriteToolCall(me: any, id: string) {
    const call = await this.writeCallRepo.findOne({
      where: { id },
      relations: ["provider", "model"],
    });
    if (!call) {
      throw new NotFoundException(
        this.translations.t("domains.ai.write_call_not_found"),
      );
    }
    return this.toWriteCallResponse(call);
  }

  async retryWriteToolCall(me: any, id: string) {
    const call = await this.writeCallRepo.findOne({ where: { id } });
    if (!call) {
      throw new NotFoundException(
        this.translations.t("domains.ai.write_call_not_found"),
      );
    }

    if (
      call.status !== AiWriteToolCallStatus.FAILED &&
      call.status !== AiWriteToolCallStatus.STALE
    ) {
      throw new BadRequestException(
        this.translations.t("domains.ai.write_call_not_retryable", {
          args: { status: call.status },
        }),
      );
    }

    call.status = AiWriteToolCallStatus.PENDING;
    call.error = null;
    call.completedAt = null;
    const saved = await this.writeCallRepo.save(call);
    return this.toWriteCallResponse(saved);
  }

  // ──────────────────────────── CONFIG ────────────────────────────

  getConfig() {
    return {
      enabled: this.config.enabled,
      defaultProvider: this.config.defaultProvider,
      maxRoundtrips: this.config.maxProviderRoundtrips,
      writeToolDedup: this.config.writeToolDedup,
      piiMasking: this.config.piiMaskingEnabled,
    };
  }

  updateConfig(dto: {
    enabled?: boolean;
    defaultProvider?: string;
    maxRoundtrips?: number;
    piiMaskingEnabled?: boolean;
  }) {
    if (dto.enabled !== undefined) this.config.enabled = dto.enabled;
    if (dto.defaultProvider !== undefined) {
      this.config.defaultProvider = dto.defaultProvider;
    }
    if (dto.maxRoundtrips !== undefined) {
      this.config.maxProviderRoundtrips = dto.maxRoundtrips;
    }
    if (dto.piiMaskingEnabled !== undefined) {
      this.config.piiMaskingEnabled = dto.piiMaskingEnabled;
    }

    return {
      enabled: this.config.enabled,
      defaultProvider: this.config.defaultProvider,
      maxRoundtrips: this.config.maxProviderRoundtrips,
      writeToolDedup: this.config.writeToolDedup,
      piiMasking: this.config.piiMaskingEnabled,
    };
  }

  // ──────────────────────────── HEALTH ────────────────────────────

  async healthCheck() {
    const providers = await this.providerRepo.find({
      relations: ["models"],
      order: { name: "ASC" },
    });

    return {
      providers: providers.map((p) => ({
        name: p.code ?? p.name,
        displayName: p.name,
        enabled: p.isActive,
        healthy: p.isActive,
        lastCheck: null,
      })),
    };
  }

  async testProviderHealth(providerCode: string) {
    const provider = await this.providerRepo.findOne({
      where: { code: providerCode },
    });
    if (!provider) {
      throw new NotFoundException(
        this.translations.t("domains.ai.provider_not_found"),
      );
    }

    const start = Date.now();
    try {
      const latencyMs = Date.now() - start;
      return { healthy: true, latencyMs, error: undefined };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      return {
        healthy: false,
        latencyMs,
        error:
          err?.message ??
          this.translations.t("domains.ai.health_check_failed", {
            args: { provider: providerCode },
          }),
      };
    }
  }

  // ──────────────────────────── EXPORTS ────────────────────────────

  async exportProviders(me: any, query: ExportProvidersQueryDto) {
    const data = await this.listProviders(me, { ...query, limit: 100000 });
    return data.records;
  }

  async exportModels(me: any, query: ExportModelsQueryDto) {
    const data = await this.listModels(me, { ...query, limit: 100000 });
    return data.records;
  }

  async exportIntegrations(me: any, query: ExportIntegrationsQueryDto) {
    const data = await this.listIntegrations(me, query);
    return data.records;
  }

  async exportRequestSummaries(me: any, query: ExportRequestSummariesQueryDto) {
    const data = await this.listRequestSummaries(me, {
      ...query,
      limit: 100000,
    });
    return data.records;
  }

  async exportWriteToolCalls(me: any, query: ExportWriteToolCallsQueryDto) {
    const data = await this.listWriteToolCalls(me, { ...query, limit: 100000 });
    return data.records;
  }

  // ──────────────────────────── ACCESSORS ────────────────────────────

  private async findProviderWithAccess(
    me: any,
    id: string,
  ): Promise<AiProviderEntity> {
    const myAdminId = tenantId(me);

    if (myAdminId) {
      const provider = await this.providerRepo.findOne({
        where: [
          { id, adminId: myAdminId },
          { id, adminId: null },
        ],
        relations: ["integrations"],
      });
      if (!provider) {
        throw new NotFoundException(
          this.translations.t("domains.ai.provider_not_found"),
        );
      }
      return provider;
    }

    const provider = await this.providerRepo.findOne({
      where: { id },
      relations: ["integrations"],
    });
    if (!provider) {
      throw new NotFoundException(
        this.translations.t("domains.ai.provider_not_found"),
      );
    }
    return provider;
  }

  private async findCustomProviderWithAccess(
    me: any,
    id: string,
  ): Promise<AiProviderEntity> {
    const myAdminId = tenantId(me);
    if (!myAdminId) {
      throw new ForbiddenException(
        this.translations.t("domains.ai.provider_not_custom"),
      );
    }

    const provider = await this.providerRepo.findOne({
      where: { id, adminId: myAdminId },
      relations: ["integrations"],
    });
    if (!provider) {
      throw new NotFoundException(
        this.translations.t("domains.ai.provider_not_found"),
      );
    }
    return provider;
  }

  private ensureWritable(
    resource: { adminId?: string | null; scope?: string },
    me: any,
  ): void {
    const myAdminId = tenantId(me);
    const isSuperAdmin = me.role?.name === SystemRole.SUPER_ADMIN;
    const isSystem =
      resource.scope === AiEntityScope.SYSTEM || resource.scope === "system";

    if (isSystem && !isSuperAdmin) {
      throw new ForbiddenException(
        this.translations.t("domains.ai.provider_is_system"),
      );
    }
    if (resource.adminId && resource.adminId !== myAdminId && !isSuperAdmin) {
      throw new ForbiddenException(
        this.translations.t("domains.ai.provider_not_custom"),
      );
    }
  }

  private async findModelWithAccess(
    me: any,
    id: string,
  ): Promise<AiModelEntity> {
    const myAdminId = tenantId(me);

    const qb = this.modelRepo
      .createQueryBuilder("model")
      .leftJoinAndSelect("model.provider", "provider")
      .leftJoinAndSelect("provider.integrations", "integration")
      .leftJoinAndSelect(
        "model.availabilities",
        "availability",
        "availability.adminId = :adminId",
        { adminId: myAdminId ?? null },
      )
      .where("model.id = :id", { id });

    if (myAdminId) {
      qb.andWhere(
        "(model.adminId = :adminId OR model.adminId IS NULL)",
        { adminId: myAdminId },
      );
    }

    const model = await qb.getOne();

    if (!model) {
      throw new NotFoundException(
        this.translations.t("domains.ai.model_not_found"),
      );
    }

    return model;
  }
  // ──────────────────────────── HELPERS ────────────────────────────

  private toProviderResponse(
    entity: AiProviderEntity,
    models?: AiModelEntity[],
    availabilityMap?: Map<string, boolean>,
  ): ProviderResponseDto {
    return {
      id: entity.id,
      code: entity.code,
      name: entity.name,
      scope: entity.scope,
      website: entity.website,
      logoUrl: entity.logoUrl,
      tenantIntegrationAllowed: entity.tenantIntegrationAllowed,
      isActive: entity.isActive,
      description: entity.description,
      descriptionAr: entity.descriptionAr,
      protocol: entity.protocol,
      adminId: entity.adminId,
      models: models
        ? models
          .filter((m) => m.isActive)
          .map((m) => ({
            id: m.id,
            modelCode: m.modelCode,
            isAvailable: availabilityMap?.get(m.id) ?? true,
          }))
        : undefined,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }

  private toModelResponse(entity: AiModelEntity, availabilityMap?: Map<string, boolean>): ModelResponseDto {
    const providerIntegration = entity.provider?.integrations?.[0];
    let maskedIntegration:
      | {
        id: string;
        baseUrl?: string;
        credentials?: Record<string, any>;
        adminId?: string;
      }
      | undefined;
    if (providerIntegration) {
      let maskedCredentials: Record<string, any> | undefined;
      if (providerIntegration.encryptedCredentials) {
        try {
          const decrypted = this.encryptionService.decrypt(
            providerIntegration.encryptedCredentials.ciphertext,
            providerIntegration.encryptedCredentials.iv,
            providerIntegration.encryptedCredentials.tag,
          );
          const creds = JSON.parse(decrypted);
          maskedCredentials = {};
          for (const [key, value] of Object.entries(creds)) {
            if (key === "apiKey" && typeof value === "string") {
              maskedCredentials[key] = maskSensitiveValue(value);
            } else {
              maskedCredentials[key] = value;
            }
          }
        } catch {
          maskedCredentials = undefined;
        }
      }
      maskedIntegration = {
        id: providerIntegration.id,
        baseUrl: providerIntegration.baseUrl,
        credentials: maskedCredentials,
        adminId: providerIntegration.adminId,
      };
    }

    return {
      id: entity.id,
      providerId: entity.providerId,
      adminId: entity.adminId,
      scope: entity.scope,
      modelCode: entity.modelCode,
      name: entity.name,
      description: entity.description,
      descriptionAr: entity.descriptionAr,
      modelType: entity.modelType,
      tier: entity.tier,
      isActive: entity.isActive,
      isAvailable: availabilityMap?.get(entity.id) ?? true,
      stream: entity.stream,
      jsonMode: entity.jsonMode,
      reasoning: entity.reasoning,
      toolsCalling: entity.toolsCalling,
      modalities: entity.modalities,
      contextWindow: entity.contextWindow,
      provider: entity.provider
        ? {
          id: entity.provider.id,
          code: entity.provider.code,
          name: entity.provider.name,
          scope: entity.provider.scope,
          website: entity.provider.website,
          logoUrl: entity.provider.logoUrl,
          tenantIntegrationAllowed: entity.provider.tenantIntegrationAllowed,
          isActive: entity.provider.isActive,
          description: entity.provider.description,
          descriptionAr: entity.provider.descriptionAr,
          protocol: entity.provider.protocol,
          adminId: entity.provider.adminId,
          created_at: entity.provider.created_at,
          updated_at: entity.provider.updated_at,
          integration: maskedIntegration,
        }
        : undefined,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }

  private toIntegrationResponse(
    entity: AiIntegrationEntity,
    models?: ModelResponseDto[],
  ): IntegrationResponseDto {
    let maskedCredentials: Record<string, any> | undefined;
    if (entity.encryptedCredentials) {
      try {
        const decrypted = this.encryptionService.decrypt(
          entity.encryptedCredentials.ciphertext,
          entity.encryptedCredentials.iv,
          entity.encryptedCredentials.tag,
        );
        const creds = JSON.parse(decrypted);
        maskedCredentials = {};
        for (const [key, value] of Object.entries(creds)) {
          if (typeof value === "string") {
            maskedCredentials[key] = maskSensitiveValue(value);
          }
        }
      } catch {
        maskedCredentials = undefined;
      }
    }

    return {
      ...entity,
      adminId: entity.adminId,
      providerId: entity.providerId,
      scope: entity.scope,
      authType: entity.authType,
      baseUrl: entity.baseUrl,
      credentials: maskedCredentials,
      lastValidatedAt: entity.lastValidatedAt,
      lastError: entity.lastError,
      provider: entity.provider
        ? {
          id: entity.provider.id,
          code: entity.provider.code,
          name: entity.provider.name,
          scope: entity.provider.scope,
          website: entity.provider.website,
          logoUrl: entity.provider.logoUrl,
          tenantIntegrationAllowed: entity.provider.tenantIntegrationAllowed,
          isActive: entity.provider.isActive,
          description: entity.provider.description,
          protocol: entity.provider.protocol,
          adminId: entity.provider.adminId,
          created_at: entity.provider.created_at,
          updated_at: entity.provider.updated_at,
        }
        : undefined,
      models,
      created_at: entity.created_at,
      updated_ut: entity.updated_ut,
    };
  }

  private toSummaryResponse(
    entity: AiRequestSummaryEntity,
  ): RequestSummaryResponseDto {
    return {
      id: entity.id,
      adminId: entity.adminId,
      sessionId: entity.sessionId,
      conversationId: entity.conversationId,
      requestId: entity.requestId,
      providerId: entity.providerId,
      modelId: entity.modelId,
      status: entity.status,
      usagePromptTokens: entity.usagePromptTokens,
      usageCompletionTokens: entity.usageCompletionTokens,
      usageTotalTokens: entity.usageTotalTokens,
      rounds: entity.rounds,
      durationMs: entity.durationMs,
      errorCode: entity.errorCode,
      error: entity.error,
      summary: entity.summary,
      progress: entity.progress,
      providersUsed: entity.providersUsed,
      provider: entity.provider
        ? {
          id: entity.provider.id,
          code: entity.provider.code,
          name: entity.provider.name,
          scope: entity.provider.scope,
          isActive: entity.provider.isActive,
          tenantIntegrationAllowed: entity.provider.tenantIntegrationAllowed,
          logoUrl: entity.provider.logoUrl,
          created_at: entity.provider.created_at,
          updated_at: entity.provider.updated_at,
        }
        : undefined,
      model: entity.model
        ? {
          id: entity.model.id,
          providerId: entity.model.providerId,
          modelCode: entity.model.modelCode,
          name: entity.model.name,
          modelType: entity.model.modelType,
          tier: entity.model.tier,
          isActive: entity.model.isActive,
          scope: entity.model.scope,
          created_at: entity.model.created_at,
          updated_at: entity.model.updated_at,
        }
        : undefined,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }

  private toWriteCallResponse(
    entity: AiWriteToolCallEntity,
  ): WriteToolCallResponseDto {
    return {
      id: entity.id,
      adminId: entity.adminId,
      sessionId: entity.sessionId,
      requestId: entity.requestId,
      providerId: entity.providerId,
      modelId: entity.modelId,
      toolName: entity.toolName,
      dedupKey: entity.dedupKey,
      toolCallId: entity.toolCallId,
      argsHash: entity.argsHash,
      args: entity.args,
      status: entity.status,
      result: entity.result,
      error: entity.error,
      completedAt: entity.completedAt,
      provider: entity.provider
        ? {
          id: entity.provider.id,
          code: entity.provider.code,
          name: entity.provider.name,
          scope: entity.provider.scope,
          tenantIntegrationAllowed: entity.provider.tenantIntegrationAllowed,
          isActive: entity.provider.isActive,
          logoUrl: entity.provider.logoUrl,
          created_at: entity.provider.created_at,
          updated_at: entity.provider.updated_at,
        }
        : undefined,
      model: entity.model
        ? {
          id: entity.model.id,
          providerId: entity.model.providerId,
          modelCode: entity.model.modelCode,
          name: entity.model.name,
          modelType: entity.model.modelType,
          tier: entity.model.tier,
          isActive: entity.model.isActive,
          scope: entity.model.scope,
          created_at: entity.model.created_at,
          updated_at: entity.model.updated_at,
        }
        : undefined,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
