import { TranslationService } from "common/translation.service";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { OAuth2Client } from "google-auth-library";
import axios from "axios";
import { randomBytes, createHash } from "crypto";
import MailComposer from "nodemailer/lib/mail-composer";
import {
  EmailAccountEntity,
  EmailOAuthStateEntity,
} from "entities/email.entity";
import { User } from "entities/user.entity";
import { EncryptionService } from "common/encryption.service";
import { EmailAccountsService } from "../email-accounts.service";
import {
  EmailContext,
  EmailProvider,
  EmailProviderError,
  PreparedEmail,
  emailEnabled,
  requireEmail,
} from "../email.types";

const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

@Injectable()
export class GmailService implements EmailProvider {
  readonly key = "gmail";
  private readonly logger = new Logger(GmailService.name);
  constructor(
    @InjectRepository(EmailAccountEntity)
    private readonly accounts: Repository<EmailAccountEntity>,
    @InjectRepository(EmailOAuthStateEntity)
    private readonly states: Repository<EmailOAuthStateEntity>,
    private readonly access: EmailAccountsService,
    private readonly encryption: EncryptionService,
    private readonly dataSource: DataSource,
    private readonly translations: TranslationService,
  ) {}
  private client() {
    const {
      GOOGLE_CLIENT_ID: id,
      GOOGLE_CLIENT_SECRET: secret,
      BACKEND_URL: backendUrl,
    } = process.env;
    if (!id || !secret || !backendUrl)
      throw new BadRequestException(
        this.translations.t("domains.email.google_not_configured"),
      );
    return new OAuth2Client(
      id,
      secret,
      `${backendUrl.replace(/\/+$/, "")}/email/accounts/gmail/callback`,
    );
  }
  async connect(
    ctx: EmailContext,
    returnTo = "/campaigns/new/email",
    accountId?: string,
    browserRedirect = false,
  ) {
    emailEnabled(this.translations);
    if (process.env.EMAIL_GMAIL_ENABLED !== "true")
      throw new BadRequestException(
        this.translations.t("domains.email.gmail_disabled"),
      );
    if (
      !/^\/(?:[a-z]{2}\/)?(?:campaigns|integrations)(?:\/[^?#\\]*)?$/.test(
        returnTo,
      )
    )
      throw new BadRequestException(
        this.translations.t("domains.email.invalid_return_path"),
      );
    if (accountId) await this.access.get(ctx, accountId, false);
    const state = randomBytes(32).toString("hex"),
      binding = randomBytes(32).toString("hex"),
      verifier = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("hex");
    await this.states.save(
      this.states.create({
        adminId: ctx.adminId,
        ownerId: ctx.actorId,
        accountId: accountId || null,
        stateHash: hash(state),
        bindingHash: (browserRedirect ? "pending:" : "") + hash(binding),
        nonce,
        verifier,
        returnTo,
        expiresAt: new Date(Date.now() + 600_000),
      }),
    );
    const authorizationUrl = this.authorizationUrl(state, verifier, nonce);
    const callbackUrl = `${process.env.BACKEND_URL.replace(/\/+$/, "")}/email/accounts/gmail/callback`;
    const browserAuthorizationUrl = browserRedirect
      ? `${process.env.BACKEND_URL.replace(/\/+$/, "")}/email/accounts/gmail/authorize?state=${state}&ticket=${binding}`
      : undefined;
    return {
      authorizationUrl,
      callbackUrl,
      browserAuthorizationUrl,
      expiresInSeconds: 600,
      binding,
      state,
    };
  }
  private authorizationUrl(state: string, verifier: string, nonce: string) {
    return this.client().generateAuthUrl({
      access_type: "offline",
      prompt: "consent select_account",
      scope: ["openid", "email", SEND_SCOPE],
      state,
      code_challenge: hashBase64(verifier),
      code_challenge_method: "S256" as any,
      nonce,
    } as any);
  }
  /** One-time top-level browser handoff sets the cookie on BACKEND_URL's host. */
  async beginBrowserAuthorization(state: string, ticket: string) {
    emailEnabled(this.translations);
    if (
      !/^[a-f0-9]{64}$/.test(state || "") ||
      !/^[a-f0-9]{64}$/.test(ticket || "")
    )
      throw new BadRequestException(
        this.translations.t("domains.email.invalid_oauth_state"),
      );
    const binding = randomBytes(32).toString("hex");
    const claimed = await this.states
      .createQueryBuilder()
      .update()
      .set({ bindingHash: hash(binding) })
      .where(
        '"stateHash" = :hash AND "bindingHash" = :ticket AND "expiresAt" > NOW()',
        { hash: hash(state), ticket: "pending:" + hash(ticket) },
      )
      .returning("*")
      .execute();
    const saved = claimed.raw[0] as EmailOAuthStateEntity;
    if (!saved)
      throw new BadRequestException(
        this.translations.t("domains.email.invalid_oauth_state"),
      );
    return {
      authorizationUrl: this.authorizationUrl(
        state,
        saved.verifier,
        saved.nonce,
      ),
      binding,
    };
  }
  async callback(
    state: string,
    binding: string,
    code?: string,
    denied?: string,
  ) {
    emailEnabled(this.translations);
    if (!/^[a-f0-9]{64}$/.test(state || "") || !binding)
      throw new BadRequestException(
        this.translations.t("domains.email.invalid_oauth_state"),
      );
    const claimed = await this.states
      .createQueryBuilder()
      .delete()
      .where(
        '"stateHash" = :hash AND "bindingHash" = :binding AND "expiresAt" > NOW()',
        { hash: hash(state), binding: hash(binding) },
      )
      .returning("*")
      .execute();
    const saved = claimed.raw[0] as EmailOAuthStateEntity;
    if (!saved)
      throw new BadRequestException(
        this.translations.t("domains.email.invalid_oauth_state"),
      );
    const destination = new URL(saved.returnTo, this.frontendOrigin());
    if (denied || !code) {
      destination.searchParams.set("emailConnection", "cancelled");
      return destination.href;
    }
    const user = await this.dataSource
      .getRepository(User)
      .findOne({ where: { id: saved.ownerId }, relations: { role: true } });
    const ctx = this.access.context(user);
    if (!user?.isActive || ctx.adminId !== saved.adminId)
      throw new BadRequestException(
        this.translations.t("domains.email.initiator_unavailable"),
      );
    const client = this.client();
    let tokens: any;
    try {
      ({ tokens } = await client.getToken({
        code,
        codeVerifier: saved.verifier,
      }));
    } catch {
      throw new BadRequestException(
        this.translations.t("domains.email.oauth_exchange_failed"),
      );
    }
    if (!tokens.id_token || !tokens.scope?.split(" ").includes(SEND_SCOPE))
      throw new BadRequestException(
        this.translations.t("domains.email.send_permission_required"),
      );
    let identity: any;
    try {
      identity = (
        await client.verifyIdToken({
          idToken: tokens.id_token,
          audience: process.env.GOOGLE_CLIENT_ID,
        })
      ).getPayload();
    } catch {
      throw new BadRequestException(
        this.translations.t("domains.email.invalid_google_identity"),
      );
    }
    if (
      identity?.nonce !== saved.nonce ||
      !identity.email_verified ||
      !identity.sub
    )
      throw new BadRequestException(
        this.translations.t("domains.email.invalid_google_identity"),
      );
    const account = await this.dataSource.transaction(async (manager) => {
      const accounts = manager.getRepository(EmailAccountEntity);
      let previous = await accounts
        .createQueryBuilder("a")
        .addSelect("a.credentials")
        .setLock("pessimistic_write")
        .where("a.provider = :provider AND a.providerSubject = :sub", {
          provider: "gmail",
          sub: identity.sub,
        })
        .getOne();
      if (
        previous &&
        (previous.adminId !== ctx.adminId || previous.ownerId !== ctx.actorId)
      ) {
        // Mailbox ownership is permanent. Disconnecting or losing credentials
        // never permits another tenant/user to claim the same Google identity.
        throw new ConflictException(
          this.translations.t("domains.email.account_already_connected"),
        );
      }
      const old = previous?.credentials
        ? JSON.parse(
            this.encryption.decrypt(
              previous.credentials.ciphertext,
              previous.credentials.iv,
              previous.credentials.tag,
            ),
          )
        : {};
      const refreshToken = tokens.refresh_token || old.refreshToken;
      if (!refreshToken)
        throw new BadRequestException(
          this.translations.t("domains.email.offline_permission_required"),
        );
      const account = await accounts.save(
        accounts.create({
          ...previous,
          adminId: ctx.adminId,
          ownerId: ctx.actorId,
          provider: "gmail",
          providerSubject: identity.sub,
          email: requireEmail(identity.email, this.translations),
          senderName: identity.name || identity.email,
          scopes: tokens.scope.split(" "),
          status: "connected",
          credentials: this.encryption.encrypt(
            JSON.stringify({ refreshToken }),
          ),
          credentialVersion: (previous?.credentialVersion || 0) + 1,
        }),
      );
      // A successful reconnect makes messages deferred solely for that reason
      // eligible for the next worker tick instead of waiting for the old delay.
      if (typeof manager.query === "function")
        await manager.query(
          `UPDATE email_messages SET "nextAttemptAt" = NOW(), reason = NULL, "updatedAt" = NOW() WHERE "accountId" = $1 AND status = 'queued' AND reason IN ('email.reconnect_required', 'email.account_suspended', 'gmail_reconnect_required', 'gmail_refresh_failed', 'gmail_unauthorized', 'gmail_account_blocked')`,
          [account.id],
        );
      return account;
    });
    destination.searchParams.set("emailConnection", "connected");
    destination.searchParams.set("accountId", account.id);
    return destination.href;
  }
  frontendOrigin() {
    const configured = process.env.FRONTEND_URL;
    if (!configured)
      throw new BadRequestException(
        this.translations.t("domains.email.frontend_not_configured"),
      );
    const url = new URL(configured);
    if (
      url.origin !== configured.replace(/\/$/, "") ||
      (url.protocol !== "https:" && url.hostname !== "localhost")
    )
      throw new BadRequestException(
        this.translations.t("domains.email.invalid_frontend_origin"),
      );
    return url.origin;
  }
  async send(account: EmailAccountEntity, message: PreparedEmail) {
    if (process.env.EMAIL_GMAIL_ENABLED !== "true")
      throw new EmailProviderError("fatal", "gmail_disabled");
    const stored = await this.accounts
      .createQueryBuilder("a")
      .addSelect("a.credentials")
      .where("a.id = :id", { id: account.id })
      .getOne();
    if (!stored?.credentials || stored.status !== "connected")
      throw new EmailProviderError("reconnect", "gmail_reconnect_required");
    const credentials = JSON.parse(
      this.encryption.decrypt(
        stored.credentials.ciphertext,
        stored.credentials.iv,
        stored.credentials.tag,
      ),
    );
    const client = this.client();
    client.setCredentials({ refresh_token: credentials.refreshToken });
    let accessToken: string;
    try {
      accessToken = (await client.getAccessToken()).token;
    } catch {
      throw new EmailProviderError("reconnect", "gmail_refresh_failed");
    }
    const raw = await new MailComposer({
      from: { name: account.senderName, address: account.email },
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
      disableFileAccess: true,
      disableUrlAccess: true,
    })
      .compile()
      .build();
    try {
      const response = await axios.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        { raw: raw.toString("base64url") },
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 30_000,
          maxRedirects: 0,
        },
      );
      if (!response.data?.id)
        throw new EmailProviderError("unknown", "gmail_missing_message_id");
      return { providerMessageId: String(response.data.id) };
    } catch (error) {
      if (error instanceof EmailProviderError) throw error;
      const status = error.response?.status;
      const reason = error.response?.data?.error?.errors?.[0]?.reason;
      const apiStatus = error.response?.data?.error?.status;
      const apiMessage = String(error.response?.data?.error?.message || "")
        .replace(/[\r\n]+/g, " ")
        .slice(0, 300);
      this.logger.warn(
        JSON.stringify({
          event: "gmail.send.rejected",
          accountId: account.id,
          httpStatus: status || null,
          reason: reason || null,
          apiStatus: apiStatus || null,
          message: apiMessage || null,
        }),
      );
      if (status === 401)
        throw new EmailProviderError("reconnect", "gmail_unauthorized");
      if (
        status === 429 ||
        [
          "rateLimitExceeded",
          "userRateLimitExceeded",
          "dailyLimitExceeded",
        ].includes(reason)
      )
        throw new EmailProviderError("quota", "gmail_quota_exceeded");
      if (status === 403)
        throw new EmailProviderError("blocked", "gmail_account_blocked");
      if (status && status >= 500)
        throw new EmailProviderError("transient", "gmail_server_error");
      if (status && status >= 400 && status < 500)
        throw new EmailProviderError("fatal", "gmail_rejected");
      throw new EmailProviderError("unknown", "gmail_send_outcome_unknown");
    }
  }
  async revoke(accountId: string) {
    const account = await this.accounts
      .createQueryBuilder("a")
      .addSelect("a.credentials")
      .where("a.id = :id", { id: accountId })
      .getOne();
    await this.accounts.update(accountId, { status: "disconnected" });
    if (account?.credentials) {
      const { ciphertext, iv, tag } = account.credentials;
      const { refreshToken } = JSON.parse(
        this.encryption.decrypt(ciphertext, iv, tag),
      );
      try {
        await this.client().revokeToken(refreshToken);
      } catch {
        const revokeAttempts = (account.revokeAttempts || 0) + 1;
        await this.accounts.update(accountId, {
          revokeAttempts,
          status:
            revokeAttempts >= 5 ? "revocation_failed" : "revocation_pending",
          ...(revokeAttempts >= 5 ? { credentials: null } : {}),
        });
        return { revoked: false };
      }
    }
    await this.accounts.update(accountId, { credentials: null });
    return { revoked: true };
  }
}
function hashBase64(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}
