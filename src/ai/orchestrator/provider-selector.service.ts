import { BadRequestException, Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, SelectQueryBuilder } from "typeorm";
import { AI_CONFIG_TOKEN, AI_PROVIDER_DEFAULTS } from "../ai.constants";
import {
  AiConfig,
  AiProviderRuntimeConfig,
} from "../interfaces/provider-config.interface";
import {
  AiProviderAbstract,
  boolEnv,
  intEnv,
  floatEnv,
  strEnv,
} from "../providers/ai-provider.abstract";
import { AiProviderError } from "../errors/provider.errors";
import {
  AiDefaultModelEntity,
  AiEntityScope,
  AiIntegrationEntity,
  AiIntegrationScope,
  AiModelEntity,
  AiProviderEntity,
} from "../../../entities/ai.entity";
import { EncryptionService } from "../../../common/encryption.service";
import { TranslationService } from "../../../common/translation.service";
import { Llm7Provider } from "../providers/llm7.provider";
import { OpenAiProvider } from "../providers/openai.provider";
import { AnthropicProvider } from "../providers/anthropic.provider";

import { DeepSeekProvider } from "../providers/deepseek.provider";
import { GoogleProvider } from "../providers/google.provider";
import { PollinationsProvider } from "../providers/pollinations.provider";
import { OpenAiCompatibleProviderImpl } from "../providers/openai-compatible.provider";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AiProviderSelectorService implements OnModuleInit {
  private readonly logger = new Logger(AiProviderSelectorService.name);
  private providersByKind = new Map<string, AiProviderAbstract>();
  private allKinds: string[] = [];

  constructor(
    @Inject(AI_CONFIG_TOKEN) private readonly config: AiConfig,

    private readonly llm7: Llm7Provider,
    private readonly openai: OpenAiProvider,
    private readonly anthropic: AnthropicProvider,
    private readonly deepseek: DeepSeekProvider,
    private readonly google: GoogleProvider,
    private readonly pollinations: PollinationsProvider,
    private readonly openAiCompatible: OpenAiCompatibleProviderImpl,

    @InjectRepository(AiProviderEntity)
    private readonly providerRepo: Repository<AiProviderEntity>,
    @InjectRepository(AiIntegrationEntity)
    private readonly integrationRepo: Repository<AiIntegrationEntity>,
    @InjectRepository(AiDefaultModelEntity)
    private readonly defaultModelRepo: Repository<AiDefaultModelEntity>,
    @InjectRepository(AiModelEntity)
    private readonly modelRepo: Repository<AiModelEntity>,
    private readonly encryptionService: EncryptionService,
    private readonly translations: TranslationService,
  ) {}

  onModuleInit() {
    const all: AiProviderAbstract[] = [
      this.llm7,
      this.openai,
      this.anthropic,
      this.deepseek,
      this.google,
      this.pollinations,
      this.openAiCompatible,
    ];
    for (const p of all) {
      this.providersByKind.set(p.kind, p);
    }
    this.allKinds = all.filter((p) => p.isEnabled()).map((p) => p.kind);
  }

  async select(
    requestedName?: string,
    tenantId?: string | null,
  ): Promise<AiProviderAbstract> {
    if (requestedName) {
      if (UUID_REGEX.test(requestedName)) {
        const entity = await this.providerQuery(tenantId)
          .where("p.id = :id", { id: requestedName })
          .andWhere("p.isActive = true")
          .getOne();
        if (entity) {
          if (tenantId && entity.adminId && entity.adminId !== tenantId) {
            throw new BadRequestException(
              this.translations.t("domains.ai.provider_not_accessible_for_tenant", { args: { name: requestedName } }),
            );
          }
          if (!this.hasIntegrationConfig(entity, tenantId)) {
            throw new BadRequestException(this.translations.t("domains.ai.provider_not_configured", { args: { name: requestedName } }));
          }
          const injectable = this.pickInjectableForEntity(entity);
          const runtime = await this.resolveRuntimeConfig(
            entity,
            injectable?.kind ?? "custom",
            tenantId,
          );
          const base = injectable ?? this.llm7;
          return base.cloneWithRuntime(runtime);
        }

        throw new BadRequestException(this.translations.t("domains.ai.provider_not_found_or_inactive", { args: { name: requestedName } }));
      } else {
        // Name (code like 'openai') → match injectable by kind, and find entity by code
        const injectable = this.providersByKind.get(requestedName);
        if (injectable) {
          if (!injectable.isEnabled() && this.enabledProviders().length > 1) {
            throw new BadRequestException(this.translations.t("domains.ai.provider_disabled", { args: { name: requestedName } }));
          }
    
          
            const entity = await this.providerQuery(tenantId)
              .where("p.code = :code", { code: requestedName })
              .andWhere(
                tenantId
                  ? "(p.adminId = :tenantAdminId OR p.adminId IS NULL)"
                  : "p.adminId IS NULL",
                { tenantAdminId: tenantId },
              )
              .getOne();
            if (!entity || !entity.isActive) {
              throw new BadRequestException(
                this.translations.t("domains.ai.provider_not_found_or_inactive", { args: { name: requestedName } }),
              );
            }
          
          if (entity && !this.hasIntegrationConfig(entity, tenantId)) {
            throw new BadRequestException(this.translations.t("domains.ai.provider_not_configured", { args: { name: requestedName } }));
          }
          const runtime = await this.resolveRuntimeConfig(
            entity,
            requestedName,
            tenantId,
          );
          return injectable.cloneWithRuntime(runtime);
        }

        // Custom provider by code (not in system providersByKind) → resolve via protocol
        const entity = await this.providerQuery(tenantId)
          .where("p.code = :code", { code: requestedName })
          .andWhere("p.isActive = true")
          .andWhere(
            tenantId
              ? "(p.adminId = :tenantAdminId OR p.adminId IS NULL)"
              : "p.adminId IS NULL",
            { tenantAdminId: tenantId },
          )
          .getOne();
        if (entity) {
          if (tenantId && entity.adminId && entity.adminId !== tenantId) {
            throw new BadRequestException(
              this.translations.t("domains.ai.provider_not_accessible_for_tenant", { args: { name: requestedName } }),
            );
          }
          if (!this.hasIntegrationConfig(entity, tenantId)) {
            throw new BadRequestException(this.translations.t("domains.ai.provider_not_configured", { args: { name: requestedName } }));
          }
          const resolved = this.pickInjectableForEntity(entity);
          const runtime = await this.resolveRuntimeConfig(
            entity,
            resolved?.kind ?? requestedName,
            tenantId,
          );
          const base = resolved ?? this.llm7;
          return base.cloneWithRuntime(runtime);
        }

        throw new BadRequestException(this.translations.t("domains.ai.provider_not_found_or_inactive", { args: { name: requestedName } }));
      }
    }

    // Fallback: default provider from config (e.g. 'llm7')
    const defaultKind = this.config.defaultProvider;
    const fallback =
      this.providersByKind.get(defaultKind) ?? this.enabledProviders()[0];

    if (!fallback) {
      throw new BadRequestException(this.translations.t("domains.ai.no_provider_available"));
    }

    const entity = await this.providerQuery(tenantId)
      .where("p.code = :code", { code: fallback.kind })
      .andWhere("p.isActive = true")
      .andWhere("p.adminId IS NULL")
      .getOne();
    if (entity && !this.hasIntegrationConfig(entity, tenantId)) {
      throw new BadRequestException(this.translations.t("domains.ai.provider_not_configured", { args: { name: fallback.kind } }));
    }
    const runtime = await this.resolveRuntimeConfig(
      entity,
      fallback.kind,
      tenantId,
    );
    return fallback.cloneWithRuntime(runtime);
  }

  async selectCustom(
    entityId: string,
    tenantId?: string | null,
  ): Promise<AiProviderAbstract> {
    const entity = await this.providerQuery(tenantId)
      .where("p.id = :id", { id: entityId })
      .andWhere("p.isActive = true")
      .andWhere(
        tenantId
          ? "(p.adminId = :tenantAdminId OR p.adminId IS NULL)"
          : "p.adminId IS NULL",
        { tenantAdminId: tenantId },
      )
      .getOne();

    if (!entity) {
      throw new AiProviderError(
        `Provider '${entityId}' not found or inactive`,
        {
          kind: "INVALID_RESPONSE",
          provider: entityId,
        },
      );
    }

    if (tenantId && entity.adminId && entity.adminId !== tenantId) {
      throw new AiProviderError(
        `Provider '${entityId}' not accessible for this tenant`,
        {
          kind: "INVALID_RESPONSE",
          provider: entityId,
        },
      );
    }

    const hasConfig = this.hasIntegrationConfig(entity, tenantId);
    if (!hasConfig) {
      throw new AiProviderError(`Provider '${entityId}' is not configured`, {
        kind: "INVALID_RESPONSE",
        provider: entityId,
      });
    }

    const injectable = this.pickInjectableForEntity(entity);
    const runtime = await this.resolveRuntimeConfig(
      entity,
      injectable?.kind ?? "custom",
      tenantId,
    );
    const base = injectable ?? this.llm7;
    return base.cloneWithRuntime(runtime);
  }

  async resolveDefaultModel(
    tenantId?: string | null,
  ): Promise<{ modelCode: string; providerEntityId: string } | null> {
    if (tenantId) {
      const record = await this.defaultModelRepo.findOne({
        where: { adminId: tenantId },
        relations: {
          model: {
            provider: true
          }
        },
      });
      if (record?.model?.isActive && record?.model?.provider?.isActive) {
        return {
          modelCode: record.model.modelCode,
          providerEntityId: record.model.provider.id,
        };
      }
    }

    const systemDefault = await this.defaultModelRepo.findOne({
      where: { adminId: null },
      relations: {
        model: {
          provider: true
        }
      },
    });
    if (systemDefault?.model?.isActive && systemDefault?.model?.provider?.isActive) {
      return {
        modelCode: systemDefault.model.modelCode,
        providerEntityId: systemDefault.model.provider.id,
      };
    }

    return null;
  }

  async resolveProviderByModelId(
    modelCode: string,
    tenantId?: string | null,
  ): Promise<string | null> {
    const modelQb = this.modelRepo.createQueryBuilder("model");
    modelQb.leftJoinAndSelect("model.provider", "p");
    this.joinScopedIntegrations(modelQb, tenantId, "p.integrations", "integration");
    const model = await modelQb.where("model.modelCode = :modelCode", { modelCode }).getOne();

    if (
      model?.isActive &&
      model?.provider?.isActive &&
      this.hasIntegrationConfig(model.provider, tenantId)
    ) {
      return model.provider.id;
    }

    return null;
  }

  async failoverCandidates(
    excludeName?: string,
    tenantId?: string | null,
  ): Promise<AiProviderAbstract[]> {
    const systemQb = this.providerQuery(tenantId)
      .where("p.isActive = true")
      .andWhere("p.adminId IS NULL");
    if (this.allKinds.length) {
      systemQb.andWhere("p.code IN (:...kinds)", { kinds: this.allKinds });
    }
    const systemEntities = await systemQb.getMany();

    let customEntities: AiProviderEntity[] = [];
    if (tenantId) {
      customEntities = await this.providerQuery(tenantId)
        .where("p.isActive = true")
        .andWhere("p.adminId = :tenantAdminId", { tenantAdminId: tenantId })
        .getMany();
    }

    const entityByKind = new Map<string, AiProviderEntity>();
    for (const e of systemEntities) {
      entityByKind.set(e.code, e);
    }

    const tasks: Array<Promise<AiProviderAbstract | null>> = [];

    for (const kind of this.allKinds) {
      if (kind === excludeName) continue;
      const base = this.providersByKind.get(kind);
      if (!base?.isEnabled()) continue;
      const entity = entityByKind.get(kind);
      if (entity && !this.hasIntegrationConfig(entity, tenantId)) continue;
      tasks.push(
        this.buildFromEntity(entity, kind, tenantId, base)
          .then((p) => {
            if (
              p &&
              p.getConfig().entityId &&
              p.getConfig().entityId === excludeName
            ) {
              return null;
            }
            return p;
          })
          .catch((err) => {
            this.logger.warn(
              `[failoverCandidates] skip system provider '${kind}': ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          }),
      );
    }

    for (const entity of customEntities) {
      if (
        excludeName &&
        (entity.id === excludeName || entity.code === excludeName)
      ) {
        continue;
      }
      if (!this.hasIntegrationConfig(entity, tenantId)) continue;
      tasks.push(
        this.buildFromEntity(entity, entity.code, tenantId).catch((err) => {
          this.logger.warn(
            `[failoverCandidates] skip custom provider '${entity.code}' (${entity.id}): ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        }),
      );
    }

    const resolved = await Promise.all(tasks);
    const out = resolved.filter((p): p is AiProviderAbstract => p !== null);
    return out.sort(
      (a, b) =>
        (a.getConfig().priority ?? 100) - (b.getConfig().priority ?? 100),
    );
  }

  private async buildFromEntity(
    entity: AiProviderEntity | null,
    fallbackKind: string,
    tenantId?: string | null,
    baseHint?: AiProviderAbstract,
  ): Promise<AiProviderAbstract | null> {
    let injectable = baseHint;
    if (entity) {
      if (tenantId && entity.adminId && entity.adminId !== tenantId) {
        return null;
      }
      if (!this.hasIntegrationConfig(entity, tenantId)) {
        return null;
      }
      injectable = injectable ?? this.pickInjectableForEntity(entity);
    }
    const base = injectable ?? this.llm7;
    if (!base.isEnabled() && this.enabledProviders().length > 1) {
      return null;
    }
    const runtime = await this.resolveRuntimeConfig(
      entity,
      fallbackKind,
      tenantId,
    );
    return base.cloneWithRuntime(runtime);
  }

  listAvailableKinds(): string[] {
    return [...this.allKinds];
  }

  getAllBaseProviders(): AiProviderAbstract[] {
    return [...this.providersByKind.values()];
  }

  // --- private helpers ---

  private enabledProviders(): AiProviderAbstract[] {
    return Array.from(this.providersByKind.values()).filter((p) =>
      p.isEnabled(),
    );
  }

  private pickInjectableForEntity(
    entity: AiProviderEntity | null,
  ): AiProviderAbstract | undefined {
    if (!entity) return undefined;
    // CUSTOM providers with a protocol: map by protocol (same as resolveBaseProvider)
    if (entity.scope === AiEntityScope.CUSTOM && entity.protocol) {
      return this.providersByKind.get(entity.protocol);
    }
    // System providers: map by code, then by protocol
    if (entity.code && this.providersByKind.has(entity.code)) {
      return this.providersByKind.get(entity.code);
    }
    if (entity.protocol) {
      return this.providersByKind.get(entity.protocol);
    }
    return undefined;
  }

  private hasIntegrationConfig(
    entity: AiProviderEntity,
    tenantId?: string | null,
  ): boolean {
    const candidates = entity.integrations ?? [];
    let integration: AiIntegrationEntity | undefined;
    if (tenantId) {
      integration =
        candidates.find(
          (i) =>
            i.scope === AiIntegrationScope.TENANT && i.adminId === tenantId,
        ) ??
        candidates.find(
          (i) => i.scope === AiIntegrationScope.SYSTEM && !i.adminId,
        );
    } else {
      integration = candidates.find(
        (i) => i.scope === AiIntegrationScope.SYSTEM && !i.adminId,
      );
    }
    return !!integration?.encryptedCredentials;
  }

  private async resolveRuntimeConfig(
    entity: AiProviderEntity | null,
    fallbackKind: string,
    tenantId?: string | null,
  ): Promise<AiProviderRuntimeConfig> {
    let integration: AiIntegrationEntity | undefined;
    if (entity) {
      const candidates = entity.integrations ?? [];
      if (tenantId) {
        integration =
          candidates.find(
            (i) =>
              i.scope === AiIntegrationScope.TENANT && i.adminId === tenantId,
          ) ??
          candidates.find(
            (i) => i.scope === AiIntegrationScope.SYSTEM && !i.adminId,
          );
      } else {
        integration = candidates.find(
          (i) => i.scope === AiIntegrationScope.SYSTEM && !i.adminId,
        );
      }
    }

    const runtime: AiProviderRuntimeConfig = {};

    if (entity) runtime.entityId = entity.id;

    // Extract env defaults for this kind (fallback if no integration row)
    const prefix = `AI_${fallbackKind.toUpperCase().replace(/-/g, "_")}`;
    const envApiKey = strEnv(process.env[`${prefix}_API_KEY`], "");
    const envBaseUrl = strEnv(process.env[`${prefix}_BASE_URL`], "");
    const envModel = strEnv(process.env[`${prefix}_MODEL`], "");
    const envMaxTokens = intEnv(
      process.env[`${prefix}_MAX_TOKENS`],
      AI_PROVIDER_DEFAULTS.MAX_TOKENS,
    );
    const envTemperature = floatEnv(
      process.env[`${prefix}_TEMPERATURE`],
      AI_PROVIDER_DEFAULTS.TEMPERATURE,
    );
    const envRetries = intEnv(
      process.env[`${prefix}_RETRIES`],
      AI_PROVIDER_DEFAULTS.RETRIES,
    );

    runtime.maxTokens = envMaxTokens;
    runtime.temperature = envTemperature;
    runtime.retries = envRetries;
    runtime.model = envModel;
    runtime.baseUrl = envBaseUrl;
    runtime.apiKey = envApiKey;

    if (integration?.baseUrl) runtime.baseUrl = integration.baseUrl;

    if (integration?.encryptedCredentials) {
      try {
        const { ciphertext, iv, tag } = integration.encryptedCredentials as any;
        const raw = this.encryptionService.decrypt(ciphertext, iv, tag);
        let d: any;
        if (typeof raw === "object" && raw !== null) {
          d = raw;
        } else if (typeof raw === "string") {
          try {
            d = JSON.parse(raw);
          } catch {
            d = null;
          }
        }

        if (d && typeof d === "object") {
          runtime.apiKey =
            d.apiKey ?? d.apikey ?? d.api_Key ?? d.token ?? runtime.apiKey;
          if (typeof d.baseUrl === "string") runtime.baseUrl = d.baseUrl;
          if (typeof d.model === "string") runtime.model = d.model;
          if (typeof d.maxTokens === "number") runtime.maxTokens = d.maxTokens;
          if (typeof d.temperature === "number") {
            runtime.temperature = d.temperature;
          }
          if (typeof d.retries === "number") runtime.retries = d.retries;
        } else if (typeof raw === "string") {
          runtime.apiKey = raw;
        }
      } catch {
        // keep env fallback
      }
    }

    return runtime;
  }

  private providerQuery(tenantId?: string | null) {
    const qb = this.providerRepo.createQueryBuilder("p");
    qb.leftJoinAndSelect("p.models", "models");
    this.joinScopedIntegrations(qb, tenantId);
    return qb;
  }

  private joinScopedIntegrations(
    qb: SelectQueryBuilder<any>,
    tenantId?: string | null,
    relation = "p.integrations",
    alias = "integration",
  ) {
    qb.leftJoinAndSelect(
      relation,
      alias,
      tenantId
        ? `(${alias}.adminId = :integrationAdminId OR ${alias}.adminId IS NULL)`
        : `${alias}.adminId IS NULL`,
      { integrationAdminId: tenantId ?? null },
    );
  }
}
