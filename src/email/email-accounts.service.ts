import { TranslationService } from "common/translation.service";
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { EmailAccountEntity } from "entities/email.entity";
import { EmailContext, emailEnabled } from "./email.types";

@Injectable()
export class EmailAccountsService {
  constructor(
    @InjectRepository(EmailAccountEntity)
    private readonly accounts: Repository<EmailAccountEntity>,
    private readonly translations: TranslationService,
  ) {}
  context(user: any): EmailContext {
    const adminId =
      user?.role?.name === "super_admin"
        ? null
        : user?.role?.name === "admin"
          ? user.id
          : user?.adminId;
    if (!adminId || !user?.id)
      throw new ForbiddenException(
        this.translations.t("domains.email.tenant_required"),
      );
    return { adminId, actorId: user.id };
  }
  async get(context: EmailContext, id: string, requireConnected = true) {
    if (!context?.adminId || !context.actorId || !id)
      throw new ForbiddenException(
        this.translations.t("domains.email.account_context_required"),
      );
    const account = await this.accounts.findOne({
      where: { id, adminId: context.adminId, ownerId: context.actorId },
    });
    if (!account)
      throw new NotFoundException(
        this.translations.t("domains.email.account_not_found"),
      );
    if (requireConnected && account.status !== "connected")
      throw new ForbiddenException(
        this.translations.t("domains.email.reconnect_required"),
      );
    return account;
  }
  list(context: EmailContext) {
    return this.accounts.find({
      where: { adminId: context.adminId, ownerId: context.actorId },
      order: { createdAt: "DESC" },
    });
  }
  safe(account: EmailAccountEntity) {
    const smtp = account.provider === "smtp";
    return {
      id: account.id,
      provider: account.provider,
      authType: account.authType,
      connectionName: account.connectionName || account.email,
      email: account.email,
      senderName: account.senderName,
      status: account.status,
      cooldownUntil: account.cooldownUntil,
      ...(smtp
        ? {
            smtp: {
              host: account.smtpHost,
              port: account.smtpPort,
              security: account.smtpSecurity,
              username: account.smtpUsername,
              hasCredential: account.status !== "disconnected",
            },
          }
        : {}),
      capabilities: smtp
        ? { edit: true, reconnect: false, disconnect: true }
        : { edit: false, reconnect: true, disconnect: true },
    };
  }
  async listSafe(context: EmailContext) {
    return (await this.list(context)).map((account) => this.safe(account));
  }
  async getSafe(context: EmailContext, id: string) {
    return this.safe(await this.get(context, id, false));
  }
  assertEnabled() {
    emailEnabled(this.translations);
  }
}
