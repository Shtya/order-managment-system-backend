import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AgentEntity } from "entities/agent.entity";
import { ClientSettingsEntity } from "entities/clientSettings.entity";
import {
  ConversationAiMode,
  WhatsappAccountEntity,
  WhatsappAiAgentSource,
  WhatsappAiResponses,
} from "entities/whatsapp.entity";
import { I18nContext, I18nService } from "nestjs-i18n";
import { ClientSettingsService } from "src/client-settings/client-settings.service";

export type WhatsappAiResolved = {
  enabled: boolean;
  agentId: string | null;
  agentName: string | null;
  source: "conversation" | "account" | "tenant";
  inherited: {
    enabled: boolean;
    agentName: string | null;
    source: "account" | "tenant";
  };
};

type ResolveContext = {
  tenantEnabled: boolean;
  tenantAgentId: string | null;
  tenantAgentName: string | null;
  account: WhatsappAccountEntity | null;
};

@Injectable()
export class WhatsappAiService {
  constructor(
    @InjectRepository(AgentEntity)
    private readonly agentRepo: Repository<AgentEntity>,
    private readonly clientSettingsService: ClientSettingsService,
    @InjectRepository(WhatsappAccountEntity)
    private readonly accountRepo: Repository<WhatsappAccountEntity>,
    private readonly i18n: I18nService,
  ) {}

  private t(key: string) {
    return this.i18n.t(key, { lang: I18nContext.current()?.lang });
  }

  async assertAgent(adminId: string, agentId: string) {
    const agent = await this.agentRepo.findOne({
      where: { id: agentId, adminId, isActive: true },
    });
    if (!agent) {
      throw new BadRequestException(
        this.t("domains.agents.not_found"),
      );
    }
    return agent;
  }

  async applyTenantSettings(adminId: string, settings: ClientSettingsEntity) {
    if (!settings.whatsappAiEnabled) {
      settings.whatsappAiAgentId = null;
      return;
    }
    
    const agentId = settings.whatsappAiAgentId || null;
    if (!agentId) {
      throw new BadRequestException(
        this.t("domains.agents.agent_required"),
      );
    }
    await this.assertAgent(adminId, agentId);
    settings.whatsappAiAgentId = agentId;
  }

  async loadContext(
    adminId: string,
    accountId?: string | null,
  ): Promise<ResolveContext> {
    const settings = await this.clientSettingsService.getCachedSettings(adminId);
    const tenantEnabled = !!settings?.whatsappAiEnabled;
    const tenantAgent =
      tenantEnabled && settings?.whatsappAiAgent?.adminId === adminId
        ? settings.whatsappAiAgent
        : null;

    let account: WhatsappAccountEntity | null = null;
    if (accountId) {
      account = await this.accountRepo.findOne({
        where: { id: accountId, adminId },
        relations: { aiAgent: true },
      });
    }

    return {
      tenantEnabled,
      tenantAgentId: tenantAgent?.id ?? null,
      tenantAgentName: tenantAgent?.name ?? null,
      account,
    };
  }

  resolve(
    context: ResolveContext,
    aiMode: ConversationAiMode | null | undefined,
  ): WhatsappAiResolved {
    const inherited = this.resolveInherited(context);
    if (aiMode === ConversationAiMode.DISABLED) {
      return {
        enabled: false,
        agentId: null,
        agentName: null,
        source: "conversation",
        inherited: {
          enabled: inherited.enabled,
          agentName: inherited.agentName,
          source: inherited.source === "account" ? "account" : "tenant",
        },
      };
    }
    return {
      ...inherited,
      inherited: {
        enabled: inherited.enabled,
        agentName: inherited.agentName,
        source: inherited.source === "account" ? "account" : "tenant",
      },
    };
  }

  private resolveInherited(context: ResolveContext): Omit<WhatsappAiResolved, "inherited"> {
    const account = context.account;
    const usesDefault =
      !account ||
      !account.aiResponses ||
      account.aiResponses === WhatsappAiResponses.DEFAULT;

    if (usesDefault) {
      return {
        enabled: context.tenantEnabled,
        agentId: context.tenantEnabled ? context.tenantAgentId : null,
        agentName: context.tenantEnabled ? context.tenantAgentName : null,
        source: "tenant",
      };
    }

    if (account.aiResponses === WhatsappAiResponses.DISABLED) {
      return {
        enabled: false,
        agentId: null,
        agentName: null,
        source: "account",
      };
    }

    if (account.aiAgentSource === WhatsappAiAgentSource.SPECIFIC && account.aiAgentId) {
      const owned =
        account.aiAgent && account.aiAgent.adminId === account.adminId
          ? account.aiAgent
          : null;
      return {
        enabled: true,
        agentId: owned?.id ?? account.aiAgentId,
        agentName: owned?.name ?? null,
        source: "account",
      };
    }

    return {
      enabled: true,
      agentId: context.tenantAgentId,
      agentName: context.tenantAgentName,
      source: "account",
    };
  }
}
