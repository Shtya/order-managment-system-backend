import { randomUUID, createHash } from "crypto";
import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { EmailAccountEntity } from "entities/email.entity";
import { SmtpConnectionDto, SmtpTestConnectionDto, UpdateSmtpConnectionDto } from "dto/email.dto";
import { EncryptionService } from "common/encryption.service";
import { TranslationService } from "common/translation.service";
import { EmailAccountsService } from "../email-accounts.service";
import { EmailContext, EmailProvider, EmailProviderError, PreparedEmail, emailEnabled } from "../email.types";
import { SmtpSecurityService } from "./smtp-security.service";

const nodemailer = require("nodemailer");

@Injectable()
export class SmtpService implements EmailProvider {
  readonly key = "smtp";
  constructor(
    @InjectRepository(EmailAccountEntity) private readonly accounts: Repository<EmailAccountEntity>,
    private readonly access: EmailAccountsService,
    private readonly encryption: EncryptionService,
    private readonly security: SmtpSecurityService,
    private readonly translations: TranslationService,
  ) {}

  private assertEnabled() {
    emailEnabled(this.translations);
    if (process.env.EMAIL_SMTP_ENABLED !== "true")
      throw new BadRequestException(this.translations.t("domains.email.smtp_disabled"));
  }

  async test(ctx: EmailContext, dto: SmtpTestConnectionDto) {
    this.assertEnabled();
    let password = dto.password;
    if (!password && dto.accountId) {
      const existing = await this.access.get(ctx, dto.accountId, false);
      if (existing.provider !== this.key)
        throw new BadRequestException(this.translations.t("domains.email.smtp_account_required"));
      const stored = await this.accounts.createQueryBuilder("account")
        .addSelect("account.credentials")
        .where("account.id = :id", { id: dto.accountId })
        .getOneOrFail();
      if (stored.credentials)
        password = JSON.parse(this.encryption.decrypt(
          stored.credentials.ciphertext,
          stored.credentials.iv,
          stored.credentials.tag,
        )).password;
    }
    if (!password)
      throw new BadRequestException(this.translations.t("domains.email.smtp_password_required"));
    await this.verify({ ...dto, password });
    return { verified: true };
  }

  async create(ctx: EmailContext, dto: SmtpConnectionDto) {
    this.assertEnabled();
    const normalized = await this.verify(dto);
    try {
      const account = await this.accounts.save(this.accounts.create({
        adminId: ctx.adminId,
        ownerId: ctx.actorId,
        provider: this.key,
        providerSubject: subject(ctx, { ...dto, ...normalized }),
        connectionName: dto.connectionName.trim(),
        authType: "password",
        email: dto.fromEmail.trim().toLowerCase(),
        senderName: dto.fromName.trim(),
        smtpHost: normalized.host,
        smtpPort: dto.port,
        smtpSecurity: dto.security,
        smtpUsername: dto.username.trim(),
        status: "connected",
        scopes: [],
        credentials: this.encryption.encrypt(JSON.stringify({ password: dto.password })),
      }));
      return this.access.safe(account);
    } catch (error: any) {
      if (error?.code === "23505")
        throw new ConflictException(this.translations.t("domains.email.smtp_already_connected"));
      throw error;
    }
  }

  async update(ctx: EmailContext, id: string, dto: UpdateSmtpConnectionDto) {
    this.assertEnabled();
    const existing = await this.access.get(ctx, id, false);
    if (existing.provider !== this.key)
      throw new BadRequestException(this.translations.t("domains.email.smtp_account_required"));
    const stored = await this.accounts.createQueryBuilder("account")
      .addSelect("account.credentials")
      .where("account.id = :id", { id })
      .getOneOrFail();
    const oldSecret = stored.credentials
      ? JSON.parse(this.encryption.decrypt(stored.credentials.ciphertext, stored.credentials.iv, stored.credentials.tag))
      : {};
    const password = dto.password || oldSecret.password;
    if (!password)
      throw new BadRequestException(this.translations.t("domains.email.smtp_password_required"));
    const normalized = await this.verify({ ...dto, password });
    await this.accounts.update(id, {
      providerSubject: subject(ctx, { ...dto, ...normalized }),
      connectionName: dto.connectionName.trim(),
      email: dto.fromEmail.trim().toLowerCase(),
      senderName: dto.fromName.trim(),
      smtpHost: normalized.host,
      smtpPort: dto.port,
      smtpSecurity: dto.security,
      smtpUsername: dto.username.trim(),
      credentials: this.encryption.encrypt(JSON.stringify({ password })),
      status: "connected",
      cooldownUntil: null,
      credentialVersion: stored.credentialVersion + 1,
    });
    return this.access.getSafe(ctx, id);
  }

  async send(account: EmailAccountEntity, message: PreparedEmail) {
    this.assertEnabled();
    const stored = await this.accounts.createQueryBuilder("account")
      .addSelect("account.credentials")
      .where("account.id = :id", { id: account.id })
      .getOneOrFail();
    if (!stored.credentials) throw new EmailProviderError("reconnect", "smtp_credentials_missing");
    const { password } = JSON.parse(this.encryption.decrypt(stored.credentials.ciphertext, stored.credentials.iv, stored.credentials.tag));
    let transport: any;
    try {
      transport = await this.transport(stored, password);
      const result = await transport.sendMail({
        from: { name: stored.senderName, address: stored.email },
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers,
      });
      return { providerMessageId: result.messageId || `smtp:${randomUUID()}` };
    } catch (error: any) {
      throw smtpError(error);
    } finally {
      transport?.close?.();
    }
  }

  async revoke(accountId: string) {
    await this.accounts.update(accountId, { credentials: null, status: "disconnected" });
    return { credentialsDeleted: true };
  }

  private async verify(dto: UpdateSmtpConnectionDto & { password: string }) {
    const normalized = await this.security.resolve(dto.host, dto.port, dto.security);
    const transport = this.makeTransport(normalized.host, normalized.address, dto.port, dto.security, dto.username.trim(), dto.password);
    try {
      await transport.verify();
      return normalized;
    } catch {
      throw new BadRequestException(this.translations.t("domains.email.smtp_verification_failed"));
    } finally {
      transport.close?.();
    }
  }

  private async transport(account: EmailAccountEntity, password: string) {
    const normalized = await this.security.resolve(account.smtpHost!, account.smtpPort!, account.smtpSecurity!);
    return this.makeTransport(normalized.host, normalized.address, account.smtpPort!, account.smtpSecurity!, account.smtpUsername!, password);
  }

  private makeTransport(hostname: string, address: string, port: number, security: string, username: string, password: string) {
    return nodemailer.createTransport({
      host: address,
      port,
      secure: security === "tls",
      requireTLS: security === "starttls",
      auth: { user: username, pass: password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      tls: { servername: hostname, rejectUnauthorized: true, minVersion: "TLSv1.2" },
    });
  }
}

function subject(ctx: EmailContext, dto: any) {
  return createHash("sha256").update([ctx.adminId, ctx.actorId, dto.host, dto.port, dto.username.trim().toLowerCase(), dto.fromEmail.trim().toLowerCase()].join("\0")).digest("hex");
}

function smtpError(error: any) {
  const code = Number(error?.responseCode || 0);
  if ([530, 534, 535].includes(code)) return new EmailProviderError("reconnect", "smtp_authentication_failed");
  if ([421, 450, 451].includes(code)) return new EmailProviderError("transient", "smtp_temporarily_unavailable");
  if (code === 452) return new EmailProviderError("quota", "smtp_quota_exceeded");
  if (code >= 500 && code < 600) return new EmailProviderError("fatal", "smtp_message_rejected");
  return new EmailProviderError("unknown", "smtp_outcome_unknown");
}
