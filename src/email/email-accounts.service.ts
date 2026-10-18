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
  assertEnabled() {
    emailEnabled(this.translations);
  }
}
