import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import {
  SmsIntegrationEntity,
  SmsProviderEntity,
  SmsSenderEntity,
  SmsSendLogEntity,
  SmsSendStatus,
} from "entities/sms.entity";
import { SmsegProvider } from "./providers/smseg.provider";
import { SmsProvider } from "./providers/sms-provider.interface";
import { SmsProviderType } from "entities/sms.entity";
import {
  CreateIntegrationDto,
  CreateSenderDto,
  SendSmsDto,
  UpdateIntegrationDto,
  UpdateSenderDto,
} from "dto/sms.dto";
import { tenantId } from "src/category/category.service";
import { DateFilterUtil } from "common/date-filter.util";
import * as ExcelJS from "exceljs";
import { TranslationService } from "common/translation.service";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";

@Injectable()
export class SmsService {
  private providers: Record<string, SmsProvider>;

  constructor(
    private dataSource: DataSource,
    @InjectRepository(SmsProviderEntity)
    private providersRepo: Repository<SmsProviderEntity>,
    @InjectRepository(SmsIntegrationEntity)
    private integrationsRepo: Repository<SmsIntegrationEntity>,
    @InjectRepository(SmsSenderEntity)
    private sendersRepo: Repository<SmsSenderEntity>,
    @InjectRepository(SmsSendLogEntity)
    private logsRepo: Repository<SmsSendLogEntity>,
    private readonly translations: TranslationService,
    private readonly smsegProvider: SmsegProvider,
  ) {
    this.providers = {
      [SmsProviderType.SMSEG]: this.smsegProvider,
    };
  }

  private getProvider(code: SmsProviderType): SmsProvider {
    const p = this.providers[code];
    if (!p) {
      throw new BadRequestException(
        this.translations.t("domains.sms_provider_not_supported"),
      );
    }
    return p;
  }

  private maskCredentials(credentials: any) {
    if (!credentials) return null;

    const masked = { ...credentials };
    const sensitiveKeys = ["password"];

    sensitiveKeys.forEach((key) => {
      const value = masked[key];
      if (value && typeof value === "string") {
        masked[key] =
          value.length > 8
            ? `${value.substring(0, 4)}****************${value.slice(-4)}`
            : "****************";
      }
    });

    return masked;
  }

  private withMaskedCredentials<T extends { credentials?: any }>(
    obj: T | null,
  ) {
    if (!obj) return obj;
    return {
      ...(obj as any),
      credentials: this.maskCredentials((obj as any).credentials),
    } as any;
  }

  private withMaskedIntegration<T extends { integration?: any }>(
    obj: T | null,
  ) {
    if (!obj) return obj;
    return {
      ...(obj as any),
      integration: this.withMaskedCredentials((obj as any).integration),
    } as any;
  }

  // ─── Providers ───────────────────────────────────────────────

  async listProviders() {
    return this.providersRepo.find({ order: { name: "ASC" } });
  }

  // ─── Integrations ────────────────────────────────────────────

  async listIntegrations(me: any) {
    const adminId = tenantId(me);
    const integrations = await this.integrationsRepo.find({
      where: { adminId } as any,
      relations: ["provider"],
      order: { created_at: "DESC" },
    });
    return integrations.map((i) => this.withMaskedCredentials(i as any) as any);
  }

  async listActiveIntegrations(me: any) {
    const adminId = tenantId(me);
    const integrations = await this.integrationsRepo.find({
      where: { adminId, isActive: true } as any,
      relations: ["provider"],
      order: { created_at: "DESC" },
    });
    return integrations.map((i) => this.withMaskedCredentials(i as any) as any);
  }

  async getIntegration(me: any, provider: string) {
    const adminId = tenantId(me);
    const integration = await this.integrationsRepo.findOne({
      where: { providerCode: provider, adminId } as any,
      relations: ["provider"],
    });
    if (!integration) {
      throw new NotFoundException(
        this.translations.t("domains.sms_integration_not_found"),
      );
    }
    return this.withMaskedCredentials(integration as any) as any;
  }

  async integrate(me: any, dto: CreateIntegrationDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const provider = await this.providersRepo.findOne({
      where: { code: dto.providerCode } as any,
    });
    if (!provider) {
      throw new BadRequestException(
        this.translations.t("domains.sms_provider_not_found"),
      );
    }

    const p = this.getProvider(dto.providerCode);
    // const credResult = await p.verifyCredentials({
    //   username: dto.username,
    //   password: dto.password,
    // });

    let integration = await this.integrationsRepo.findOne({
      where: { adminId, providerId: provider.id } as any,
    });

    if (integration) {
      integration.credentials = {
        username: dto.username,
        password: dto.password,
      };
      integration.isActive = true;

      integration = await this.integrationsRepo.save(integration);
    } else {
      integration = this.integrationsRepo.create({
        adminId,
        providerCode: dto.providerCode,
        providerId: provider.id,
        credentials: {
          username: dto.username,
          password: dto.password,
        },
        isActive: true,
      });

      integration = await this.integrationsRepo.save(integration);
    }

    return this.withMaskedCredentials(integration as any) as any;
  }

  async updateIntegration(
    me: any,
    provider: string,
    dto: UpdateIntegrationDto,
  ) {
    const adminId = tenantId(me);
    const integration = await this.integrationsRepo.findOne({
      where: { providerCode: provider, adminId } as any,
      relations: ["provider"],
    });
    if (!integration) {
      throw new NotFoundException(
        this.translations.t("domains.sms_integration_not_found"),
      );
    }

    const credentials = integration.credentials || {
      username: "",
      password: "",
    };
    if (dto.username !== undefined) credentials.username = dto.username;
    if (dto.password !== undefined) credentials.password = dto.password;
    (integration as any).credentials = credentials;

    const saved = await this.integrationsRepo.save(integration as any);
    return this.withMaskedCredentials(saved as any) as any;
  }

  async toggleIntegrationActive(me: any, provider: string) {
    const adminId = tenantId(me);
    const integration = await this.integrationsRepo.findOne({
      where: { providerCode: provider, adminId } as any,
    });
    if (!integration) {
      throw new NotFoundException(
        this.translations.t("domains.sms_integration_not_found"),
      );
    }

    (integration as any).isActive = !(integration as any).isActive;
    const saved = await this.integrationsRepo.save(integration as any);
    return this.withMaskedCredentials(saved as any) as any;
  }

  async getDefaultSenderForIntegration(me: any, integrationId: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const integration = await this.integrationsRepo.findOne({
      where: { id: integrationId, adminId } as any,
    });
    if (!integration) {
      throw new NotFoundException(
        this.translations.t("domains.sms_integration_not_found"),
      );
    }

    const sender = await this.sendersRepo.findOne({
      where: { adminId, integrationId, isActive: true, isDefault: true } as any,
      relations: ["integration"],
    });
    return this.withMaskedIntegration(sender as any) as any;
  }

  // ─── Senders Stats ───────────────────────────────────────────

  async senderStats(me: any) {
    const adminId = tenantId(me);
    const result = await this.sendersRepo
      .createQueryBuilder("s")
      .select("COUNT(*)", "total")
      .addSelect(`SUM(CASE WHEN s.isActive = true THEN 1 ELSE 0 END)`, "active")
      .where("s.adminId = :adminId", { adminId })
      .getRawOne();

    return {
      total: Number(result.total),
      active: Number(result.active),
    };
  }

  // ─── Senders ─────────────────────────────────────────────────

  async listSenders(me: any, q?: any) {
    const adminId = tenantId(me);
    const page = q?.page ?? 1;
    const limit = q?.limit ?? 10;

    const qb = this.sendersRepo
      .createQueryBuilder("s")
      .leftJoinAndSelect("s.integration", "integration")
      .where("s.adminId = :adminId", { adminId })
      .orderBy("s.isDefault", "DESC")
      .addOrderBy("s.created_at", "DESC");

    if (q?.search?.trim()) {
      const search = `%${String(q.search).trim().toLowerCase()}%`;
      qb.andWhere(
        "(LOWER(s.name) LIKE :search OR LOWER(s.identifier) LIKE :search)",
        { search },
      );
    }

    if (q?.integrationId) {
      qb.andWhere("s.integrationId = :integrationId", {
        integrationId: q.integrationId,
      });
    }

    if (q?.isActive !== undefined) {
      qb.andWhere("s.isActive = :isActive", {
        isActive: q.isActive === "true",
      });
    }

    const [records, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records: records.map((r) => this.withMaskedIntegration(r as any) as any),
    };
  }

  async exportSenders(me: any, q: any) {
    const adminId = tenantId(me);
    const { records } = await this.listSenders(me, {
      ...q,
      limit: 1000,
      page: 1,
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      this.translations.t("domains.sms.senders"),
    );

    worksheet.columns = [
      { header: this.translations.t("common.name"), key: "name", width: 25 },
      {
        header: this.translations.t("domains.sms.identifier"),
        key: "identifier",
        width: 25,
      },
      {
        header: this.translations.t("domains.sms.isDefault"),
        key: "isDefault",
        width: 15,
      },
      {
        header: this.translations.t("common.status"),
        key: "status",
        width: 15,
      },
      {
        header: this.translations.t("common.description"),
        key: "description",
        width: 35,
      },
    ];

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };

    records.forEach((s) => {
      worksheet.addRow({
        name: s.name,
        identifier: s.identifier,
        isDefault: s.isDefault
          ? this.translations.t("common.yes")
          : this.translations.t("common.no"),
        status: s.isActive
          ? this.translations.t("common.active")
          : this.translations.t("common.inactive"),
        description:
          s.description || this.translations.t("common.not_available_symbol"),
      });
    });

    return workbook.xlsx.writeBuffer();
  }

  async createSender(me: any, dto: CreateSenderDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    if (dto.integrationId) {
      const integration = await this.integrationsRepo.findOne({
        where: { id: dto.integrationId, adminId } as any,
      });
      if (!integration) {
        throw new BadRequestException(
          this.translations.t("domains.sms_integration_not_found"),
        );
      }
    }

    const existing = await this.sendersRepo.findOne({
      where: [
        {
          adminId,
          integrationId: dto.integrationId ?? null,
          name: dto.name,
        } as any,
        {
          adminId,
          integrationId: dto.integrationId ?? null,
          identifier: dto.identifier,
        } as any,
      ],
    });

    if (existing) {
      if (existing.name === dto.name) {
        throw new BadRequestException(
          this.translations.t("domains.sms_sender_name_exists"),
        );
      }

      if (existing.identifier === dto.identifier) {
        throw new BadRequestException(
          this.translations.t("domains.sms_sender_identifier_exists"),
        );
      }
    }

    if (dto.isDefault) {
      await this.sendersRepo.update({ adminId } as any, { isDefault: false });
    }

    const sender = this.sendersRepo.create({
      adminId,
      integrationId: dto.integrationId ?? null,
      name: dto.name,
      identifier: dto.identifier,
      isDefault: dto.isDefault ?? false,
      description: dto.description ?? null,
    } as any);

    return this.sendersRepo.save(sender);
  }

  async updateSender(me: any, id: string, dto: UpdateSenderDto) {
    const adminId = tenantId(me);

    const sender = await this.sendersRepo.findOne({
      where: { id, adminId } as any,
    });
    if (!sender) {
      throw new NotFoundException(
        this.translations.t("domains.sms_sender_not_found"),
      );
    }

    if (dto.name !== undefined || dto.identifier !== undefined) {
      const existing = await this.sendersRepo.findOne({
        where: [
          {
            adminId,
            integrationId: sender.integrationId,
            name: dto.name ?? sender.name,
          } as any,
          {
            adminId,
            integrationId: sender.integrationId,
            identifier: dto.identifier ?? sender.identifier,
          } as any,
        ],
      });

      if (existing && existing.id !== sender.id) {
        if (existing.name === (dto.name ?? sender.name)) {
          throw new BadRequestException(
            this.translations.t("domains.sms_sender_name_exists"),
          );
        }

        if (existing.identifier === (dto.identifier ?? sender.identifier)) {
          throw new BadRequestException(
            this.translations.t("domains.sms_sender_identifier_exists"),
          );
        }
      }
    }

    if (dto.name !== undefined) sender.name = dto.name;
    if (dto.identifier !== undefined) sender.identifier = dto.identifier;
    if (dto.description !== undefined) sender.description = dto.description;

    if (dto.isDefault === true) {
      await this.sendersRepo.update({ adminId } as any, { isDefault: false });
      sender.isDefault = true;
    } else if (dto.isDefault === false) {
      sender.isDefault = false;
    }

    return this.sendersRepo.save(sender);
  }

  async deleteSender(me: any, id: string) {
    const adminId = tenantId(me);
    const sender = await this.sendersRepo.findOne({
      where: { id, adminId } as any,
    });
    if (!sender) {
      throw new NotFoundException(
        this.translations.t("domains.sms_sender_not_found"),
      );
    }

    await this.sendersRepo.delete({ id } as any);
    return { message: this.translations.t("domains.sms.sender_deleted") };
  }

  async setSenderDefault(me: any, id: string) {
    const adminId = tenantId(me);

    return this.dataSource.transaction(async (manager) => {
      const sender = await manager.findOne(SmsSenderEntity, {
        where: { id, adminId } as any,
      });

      if (!sender) {
        throw new NotFoundException(
          this.translations.t("domains.sms_sender_not_found"),
        );
      }

      if (sender.isDefault) {
        return sender;
      }

      await manager.update(
        SmsSenderEntity,
        { adminId, isDefault: true },
        { isDefault: false },
      );

      sender.isDefault = true;

      return manager.save(sender);
    });
  }

  async toggleSenderActive(me: any, id: string) {
    const adminId = tenantId(me);
    const sender = await this.sendersRepo.findOne({
      where: { id, adminId } as any,
    });
    if (!sender) {
      throw new NotFoundException(
        this.translations.t("domains.sms_sender_not_found"),
      );
    }

    (sender as any).isActive = !(sender as any).isActive;
    return this.sendersRepo.save(sender as any);
  }

  // ─── Send SMS ────────────────────────────────────────────────

  async sendSms(me: any, providerCode: string, dto: SendSmsDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const integration = await this.integrationsRepo.findOne({
      where: { providerCode: providerCode, adminId, isActive: true } as any,
      relations: ["provider"],
    });
    if (!integration) {
      throw new BadRequestException(
        this.translations.t("domains.sms_integration_not_found_or_inactive"),
      );
    }

    let sender: SmsSenderEntity | null = null;
    if (dto.senderId) {
      sender = await this.sendersRepo.findOne({
        where: { id: dto.senderId, adminId, isActive: true } as any,
      });
      if (!sender) {
        throw new BadRequestException(
          this.translations.t("domains.sms_sender_not_found_or_inactive"),
        );
      }
    } else {
      sender = await this.sendersRepo.findOne({
        where: {
          adminId,
          integrationId: integration.id,
          isActive: true,
          isDefault: true,
        } as any,
        order: { isDefault: "DESC" },
      });
    }

    const credentials = integration.credentials || {
      username: "",
      password: "",
    };
    const senderIdentifier = sender?.identifier || "";
    const provider = this.getProvider(
      integration.providerCode as SmsProviderType,
    );

    const phoneNumber = normalizeEgyptianPhoneNumber(dto.toNumber);
    const result = await provider.sendSms(
      { username: credentials.username, password: credentials.password },
      { toNumber: phoneNumber, message: dto.message, sender: senderIdentifier },
    );

    const log = this.logsRepo.create({
      adminId,
      integrationId: integration.id,
      providerCode: integration.providerCode,
      providerId: integration.providerId,
      toNumber: phoneNumber,
      senderId: sender?.id || null,
      sender: sender,
      message: dto.message,
      status: result.success ? SmsSendStatus.SENT : SmsSendStatus.FAILED,
      providerMessageId: result.providerMessageId || null,
      providerResponse: result.providerResponse || null,
      error: result.error || null,
      sent_at: result.success ? new Date() : null,
    } as any);

    return this.logsRepo.save(log);
  }

  // ─── Logs Stats ──────────────────────────────────────────────

  async logStats(me: any) {
    const adminId = tenantId(me);
    const result = await this.logsRepo
      .createQueryBuilder("l")
      .select("COUNT(*)", "total")
      .addSelect(
        `SUM(CASE WHEN l.status = 'failed' THEN 1 ELSE 0 END)`,
        "failed",
      )
      .addSelect(
        `SUM(CASE WHEN l.status IN ('sent') THEN 1 ELSE 0 END)`,
        "success",
      )
      .where("l.adminId = :adminId", { adminId })
      .getRawOne();

    const total = Number(result.total);
    const failed = Number(result.failed);
    const success = Number(result.success);
    const successRate = total > 0 ? Math.round((success / total) * 100) : 0;

    return { total, failed, success, successRate };
  }

  // ─── Logs ────────────────────────────────────────────────────

  async listLogs(me: any, q?: any) {
    const adminId = tenantId(me);
    const page = q?.page ?? 1;
    const limit = q?.limit ?? 10;

    const qb = this.logsRepo
      .createQueryBuilder("l")
      .leftJoinAndSelect("l.provider", "provider")
      .leftJoinAndSelect("l.sender", "sender")
      .where("l.adminId = :adminId", { adminId })
      .orderBy("l.created_at", "DESC");

    DateFilterUtil.applyToQueryBuilder(
      qb,
      "l.created_at",
      q?.startDate,
      q?.endDate,
    );

    if (q?.status) {
      qb.andWhere("l.status = :status", { status: q.status });
    }

    if (q?.providerCode) {
      qb.andWhere("l.providerCode = :providerCode", {
        providerCode: q.providerCode,
      });
    }

    if (q?.search?.trim()) {
      const search = `%${String(q.search).trim().toLowerCase()}%`;
      qb.andWhere(
        "(LOWER(l.toNumber) LIKE :search OR LOWER(l.message) LIKE :search)",
        { search },
      );
    }

    const [records, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  async getLog(me: any, id: string) {
    const adminId = tenantId(me);
    const log = await this.logsRepo.findOne({
      where: { id, adminId } as any,
      relations: ["provider", "sender", "integration"],
    });
    if (!log) {
      throw new NotFoundException(
        this.translations.t("domains.sms_log_not_found"),
      );
    }
    return this.withMaskedIntegration(log as any) as any;
  }

  async resendLog(me: any, id: string) {
    const adminId = tenantId(me);
    const log = await this.logsRepo.findOne({
      where: { id, adminId } as any,
      relations: ["provider"],
    });
    if (!log) {
      throw new NotFoundException(
        this.translations.t("domains.sms_log_not_found"),
      );
    }

    if (log.status === SmsSendStatus.SENT) {
      throw new BadRequestException(
        this.translations.t("domains.sms_log_already_sent"),
      );
    }

    const integration = await this.integrationsRepo.findOne({
      where: { id: log.integrationId, adminId } as any,
    });
    if (!integration) {
      throw new BadRequestException(
        this.translations.t("domains.sms_integration_not_found"),
      );
    }

    const credentials = integration.credentials || {
      username: "",
      password: "",
    };
    const provider = this.getProvider(log.providerCode as SmsProviderType);

    let senderIdentifier = "";
    if (log.senderId) {
      const sender = await this.sendersRepo.findOne({
        where: { id: log.senderId } as any,
      });
      if (sender) senderIdentifier = sender.identifier;
    }

    if (!senderIdentifier) {
      throw new BadRequestException(
        this.translations.t("domains.sms_sender_identifier_not_found"),
      );
    }

    const result = await provider.sendSms(
      { username: credentials.username, password: credentials.password },
      {
        toNumber: log.toNumber,
        message: log.message,
        sender: senderIdentifier,
      },
    );

    log.status = result.success ? SmsSendStatus.SENT : SmsSendStatus.FAILED;
    log.providerMessageId = result.providerMessageId || log.providerMessageId;
    log.providerResponse = result.providerResponse || log.providerResponse;
    log.error = result.error || null;
    if (result.success) log.sent_at = new Date();

    return this.logsRepo.save(log);
  }

  async exportLogs(me: any, q: any) {
    const { records } = await this.listLogs(me, {
      ...q,
      limit: 1000,
      page: 1,
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      this.translations.t("domains.sms.logs"),
    );

    worksheet.columns = [
      {
        header: this.translations.t("domains.sms.toNumber"),
        key: "toNumber",
        width: 20,
      },
      {
        header: this.translations.t("domains.sms.message"),
        key: "message",
        width: 40,
      },
      {
        header: this.translations.t("domains.sms.sender"),
        key: "sender",
        width: 20,
      },
      {
        header: this.translations.t("domains.sms.status"),
        key: "status",
        width: 15,
      },
      {
        header: this.translations.t("domains.sms.providerMessageId"),
        key: "providerMessageId",
        width: 25,
      },
      { header: this.translations.t("common.error"), key: "error", width: 30 },
      {
        header: this.translations.t("common.sent_at"),
        key: "sent_at",
        width: 25,
      },
    ];

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };

    records.forEach((l) => {
      worksheet.addRow({
        toNumber: l.toNumber,
        message: l.message,
        sender:
          l.sender?.name || this.translations.t("common.not_available_symbol"),
        status: l.status,
        providerMessageId:
          l.providerMessageId ||
          this.translations.t("common.not_available_symbol"),
        error: l.error || "",
        sent_at: l.sent_at ? l.sent_at.toISOString() : "",
      });
    });

    return workbook.xlsx.writeBuffer();
  }
}
