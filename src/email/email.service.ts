import { EmailAssetsService } from "./email-assets.service";
import { emailAssetIds, visibleEmailAssets } from "./email-document";
import { TranslationService } from "common/translation.service";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { createHash } from "crypto";
import { EmailAccountEntity, EmailMessageEntity } from "entities/email.entity";
import { User } from "entities/user.entity";
import { EmailAccountsService } from "./email-accounts.service";
import { EmailContentService } from "./email-content.service";
import { EmailPolicyService } from "./email-policy.service";
import {
  EMAIL_PROVIDERS,
  EmailContext,
  EmailDeferredError,
  EmailProvider,
  EmailProviderError,
  EmailRequest,
  emailEnabled,
  requireEmail,
} from "./email.types";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @InjectRepository(EmailMessageEntity)
    private readonly messages: Repository<EmailMessageEntity>,
    private readonly dataSource: DataSource,
    private readonly accounts: EmailAccountsService,
    private readonly content: EmailContentService,
    private readonly policy: EmailPolicyService,
    @Inject(EMAIL_PROVIDERS) private readonly providers: EmailProvider[],
    private readonly translations: TranslationService,
    @Optional() private readonly assets?: EmailAssetsService,
  ) {}
  /** Durable submission. Campaigns dispatch through their existing queue; other callers use enqueue(). */
  async submit(ctx: EmailContext, input: EmailRequest) {
    emailEnabled(this.translations);
    await this.accounts.get(ctx, input.accountId, false);
    this.content.validate(input.content);
    await this.content.render(
      input.content,
      input.variables,
      undefined,
      ctx.adminId,
    );
    if (
      !input.idempotencyKey ||
      input.idempotencyKey.length > 200 ||
      !["marketing", "transactional", "test"].includes(input.purpose)
    )
      throw new BadRequestException(
        this.translations.t("domains.email.invalid_request"),
      );
    const request = { ...input, to: requireEmail(input.to, this.translations) };
    const requestHash = createHash("sha256")
      .update(stableJson(request))
      .digest("hex");
    const persist = async (
      messages: Repository<EmailMessageEntity>,
      transaction?: import("typeorm").EntityManager,
    ) => {
      await messages
        .createQueryBuilder()
        .insert()
        .values({
          adminId: ctx.adminId,
          actorId: ctx.actorId,
          accountId: input.accountId,
          recipient: request.to,
          request,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        })
        .orIgnore()
        .execute();
      const message = await messages.findOneByOrFail({
        adminId: ctx.adminId,
        idempotencyKey: input.idempotencyKey,
      });
      if (
        message.requestHash !== requestHash ||
        message.actorId !== ctx.actorId
      )
        throw new ConflictException(
          this.translations.t("domains.email.idempotency_conflict"),
        );
      if (input.content.document?.schemaVersion === 2)
        await this.assets?.retain(
          ctx.adminId,
          emailAssetIds(input.content.document),
          "queued",
          transaction,
        );
      return message;
    };
    return input.content.document?.schemaVersion === 2
      ? this.dataSource.transaction((manager) =>
          persist(manager.getRepository(EmailMessageEntity), manager),
        )
      : persist(this.messages);
  }

  async send(ctx: EmailContext, request: EmailRequest) {
    const message = await this.submit(ctx, request);
    this.log("email.send.submitted", message, request);
    return this.dispatch(message.id);
  }
  async sendImmediate(ctx: EmailContext, request: EmailRequest) {
    const message = await this.submit(ctx, request);
    this.log("email.send.immediate", message, request);
    return this.dispatch(message.id, { immediate: true });
  }
  async enqueue(ctx: EmailContext, request: EmailRequest) {
    if (request.source.type === "campaign")
      throw new BadRequestException(
        this.translations.t("domains.email.campaign_uses_campaign_queue"),
      );
    const message = await this.submit(ctx, request);
    this.log("email.send.queued", message, request);
    return message;
  }
  async get(ctx: EmailContext, id: string) {
    return this.messages.findOneByOrFail({
      id,
      adminId: ctx.adminId,
      actorId: ctx.actorId,
    });
  }
  async disconnect(ctx: EmailContext, id: string) {
    const account = await this.accounts.get(ctx, id, false);
    const provider = this.providers.find((p) => p.key === account.provider);
    await this.dataSource
      .getRepository(EmailAccountEntity)
      .update(id, { status: "disconnected" });
    const revocation = await provider?.revoke(id);
    return { disconnected: true, revocation };
  }
  async retryRevocations() {
    const pending = await this.dataSource
      .getRepository(EmailAccountEntity)
      .find({ where: { status: "revocation_pending" }, take: 10 });
    for (const account of pending)
      await this.providers
        .find((p) => p.key === account.provider)
        ?.revoke(account.id);
  }
  async dispatch(id: string, options: { immediate?: boolean } = {}) {
    emailEnabled(this.translations);
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    let locked = false,
      recipientLocked = false,
      accountId: string,
      recipientLockKey: string,
      dispatchAttempt = 0;
    try {
      let message = await this.messages
        .createQueryBuilder("m")
        .addSelect("m.request")
        .where("m.id = :id", { id })
        .getOneOrFail();
      accountId = message.accountId;
      if (
        ["accepted", "failed", "suppressed", "unknown", "cancelled"].includes(
          message.status,
        )
      )
        return message;
      const rows = await runner.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [`email-account:${accountId}`],
      );
      locked = rows[0].locked;
      if (!locked) {
        dispatchAttempt = (message.dispatchAttempts || 0) + 1;
        await this.messages.update(id, { dispatchAttempts: dispatchAttempt });
        throw new EmailDeferredError(
          "email.account_busy",
          retryDelay("account_busy", dispatchAttempt),
        );
      }
      message = await this.messages
        .createQueryBuilder("m")
        .addSelect("m.request")
        .where("m.id = :id", { id })
        .getOneOrFail();
      this.logger.log(
        JSON.stringify({
          event: "email.dispatch.started",
          messageId: message.id,
          accountId: message.accountId,
          status: message.status,
          attempts: message.attempts,
          dispatchAttempt: message.dispatchAttempts || 0,
          sourceType: message.request.source?.type || "unknown",
          purpose: message.request.purpose,
        }),
      );
      if (
        ["accepted", "failed", "suppressed", "unknown", "cancelled"].includes(
          message.status,
        )
      )
        return message;
      // Under the account lock no request is in flight. A prior sending state has an ambiguous remote outcome.
      if (message.status === "sending") {
        await this.messages.update(id, {
          status: "unknown",
          reason: "worker_interrupted",
        });
        return this.messages.findOneByOrFail({ id });
      }
      if ((message.dispatchAttempts || 0) >= 5) {
        await this.messages.update(id, {
          status: "failed",
          reason: "attempts_exhausted",
          nextAttemptAt: null,
        });
        return this.messages.findOneByOrFail({ id });
      }
      dispatchAttempt = (message.dispatchAttempts || 0) + 1;
      await this.messages.update(id, { dispatchAttempts: dispatchAttempt });
      const ctx = { adminId: message.adminId, actorId: message.actorId };
      const actor = await this.dataSource
        .getRepository(User)
        .findOne({ where: { id: ctx.actorId }, relations: { role: true } });
      let actorAuthorized = false;
      try {
        actorAuthorized =
          !!actor?.isActive &&
          this.accounts.context(actor).adminId === ctx.adminId;
      } catch {
        /* User no longer belongs to this tenant. */
      }
      if (!actorAuthorized) {
        await this.messages.update(id, {
          status: "cancelled",
          reason: "actor_unavailable",
        });
        return this.messages.findOneByOrFail({ id });
      }
      const account = await this.accounts.get(ctx, accountId, false);
      if (
        account.provider === "gmail" &&
        process.env.EMAIL_GMAIL_ENABLED !== "true"
      )
        throw new EmailDeferredError(
          "email.gmail_disabled",
          retryDelay("reconnect", dispatchAttempt),
        );
      if (
        account.provider === "smtp" &&
        process.env.EMAIL_SMTP_ENABLED !== "true"
      )
        throw new EmailDeferredError(
          "email.smtp_disabled",
          retryDelay("reconnect", dispatchAttempt),
        );
      if (account.status !== "connected")
        throw new EmailDeferredError(
          account.status === "suspended"
            ? "email.account_suspended"
            : "email.reconnect_required",
          retryDelay("reconnect", dispatchAttempt),
        );
      if (
        (message.nextAttemptAt?.getTime() || 0) > Date.now() ||
        (account.cooldownUntil?.getTime() || 0) > Date.now()
      )
        throw new EmailDeferredError(
          "email.cooldown",
          Math.max(
            5000,
            Math.max(
              message.nextAttemptAt?.getTime() || 0,
              account.cooldownUntil?.getTime() || 0,
            ) - Date.now(),
          ),
        );
      if (message.attempts >= 5) {
        await this.messages.update(id, {
          status: "failed",
          reason: "attempts_exhausted",
        });
        return this.messages.findOneByOrFail({ id });
      }
      const request = message.request;
      if (request.purpose === "marketing") {
        recipientLockKey = `email-recipient:${ctx.adminId}:${message.recipient}`;
        const lock = await runner.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
          [recipientLockKey],
        );
        recipientLocked = lock[0].locked;
        if (!recipientLocked)
          throw new EmailDeferredError("email.recipient_busy", 5000);
      }
      const reason = await this.policy.eligibility(
        ctx.adminId,
        message.recipient,
        request.purpose,
      );
      if (reason) {
        await this.messages.update(id, { status: "suppressed", reason });
        return this.messages.findOneByOrFail({ id });
      }
      // if (request.purpose === "marketing") {
      //   const intervalHours = positiveInteger(
      //     "EMAIL_MARKETING_MIN_INTERVAL_HOURS",
      //     24,
      //   );
      //   const recent = await this.messages.query(
      //     `SELECT MAX(COALESCE("acceptedAt", "updatedAt")) AS last FROM email_messages WHERE "adminId" = $1 AND recipient = $2 AND id != $3 AND status IN ('accepted','unknown','sending') AND request->>'purpose' = 'marketing' AND COALESCE("acceptedAt", "updatedAt") > NOW() - make_interval(hours => $4)`,
      //     [ctx.adminId, message.recipient, id, intervalHours],
      //   );
      //   if (recent[0].last)
      //     throw new EmailDeferredError(
      //       "email.recipient_frequency_cap",
      //       Math.max(
      //         5000,
      //         new Date(recent[0].last).getTime() +
      //           intervalHours * 3_600_000 -
      //           Date.now(),
      //       ),
      //     );
      // }
      const unsubscribeUrl =
        request.purpose === "marketing"
          ? this.policy.unsubscribeUrl(ctx.adminId, message.recipient)
          : undefined;
      let prepared: Awaited<ReturnType<EmailContentService["render"]>>;
      try {
        prepared = await this.content.render(
          request.content,
          request.variables,
          unsubscribeUrl,
          ctx.adminId,
        );
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;
        await this.messages.update(id, {
          status: "failed",
          reason: "content_validation_failed",
        });
        return this.messages.findOneByOrFail({ id });
      }
      const provider = this.providers.find((p) => p.key === account.provider);
      if (!provider)
        throw new BadRequestException(
          this.translations.t("domains.email.provider_not_supported"),
        );
      await this.assets?.retain(
        ctx.adminId,
        visibleEmailAssets(request.content.document),
        "permanent",
      );
      const attempt = message.attempts + 1;
      await this.messages.update(id, {
        status: "sending",
        attempts: attempt,
      });
      this.logger.log(
        JSON.stringify({
          event: "email.provider.send.started",
          messageId: id,
          accountId,
          provider: account.provider,
          attempt,
        }),
      );
      let outcome: { providerMessageId: string };
      try {
        outcome = await provider.send(account, {
          ...prepared,
          to: message.recipient,
          headers: unsubscribeUrl
            ? {
                "List-Unsubscribe": `<${unsubscribeUrl}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              }
            : {},
        });
      } catch (error) {
        const category =
          error instanceof EmailProviderError ? error.category : "unknown";
        const reason =
          error instanceof EmailProviderError
            ? error.code
            : "provider_outcome_unknown";
        if (
          category === "quota" ||
          category === "reconnect" ||
          category === "blocked" ||
          category === "transient"
        ) {
          const delayMs = retryDelay(category, dispatchAttempt);
          const until = new Date(Date.now() + delayMs);
          await this.dataSource
            .getRepository(EmailAccountEntity)
            .update(
              accountId,
              category === "reconnect"
                ? { status: "reconnect_required" }
                : category === "blocked"
                  ? { status: "suspended" }
                  : category === "quota"
                    ? { cooldownUntil: until }
                    : {},
            );
          await this.messages.update(id, {
            status: "queued",
            reason,
            nextAttemptAt: until,
          });
          this.logger.warn(
            JSON.stringify({
              event: "email.provider.send.deferred",
              messageId: id,
              accountId,
              provider: account.provider,
              category,
              reason,
              nextAttemptAt: until.toISOString(),
            }),
          );
          throw new EmailDeferredError(reason, delayMs);
        }
        await this.messages.update(id, {
          status: category === "fatal" ? "failed" : "unknown",
          reason,
        });
        this.logger.error(
          JSON.stringify({
            event: "email.provider.send.failed",
            messageId: id,
            accountId,
            provider: account.provider,
            category,
            reason,
          }),
        );
        return this.messages.findOneByOrFail({ id });
      }
      // If this write fails, the durable sending state recovers as unknown; never resend automatically.
      await this.messages.update(id, {
        status: "accepted",
        providerMessageId: outcome.providerMessageId,
        acceptedAt: new Date(),
        reason: null,
      });
      this.logger.log(
        JSON.stringify({
          event: "email.provider.send.accepted",
          messageId: id,
          accountId,
          provider: account.provider,
        }),
      );
      return this.messages.findOneByOrFail({ id });
    } catch (error) {
      if (error instanceof EmailDeferredError) {
        this.logger.warn(
          JSON.stringify({
            event: "email.dispatch.deferred",
            messageId: id,
            accountId,
            reason: error.reason,
            delayMs: error.delayMs,
          }),
        );
        if (options.immediate || dispatchAttempt >= 5) {
          await this.messages.update(id, {
            status: "failed",
            reason:
              dispatchAttempt >= 5
                ? `attempts_exhausted:${error.reason}`
                : error.reason,
            nextAttemptAt: null,
          });
          return this.messages.findOneByOrFail({ id });
        }
      } else {
        this.logger.error(
          JSON.stringify({
            event: "email.dispatch.failed",
            messageId: id,
            accountId,
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
      throw error;
    } finally {
      try {
        if (recipientLocked)
          await runner.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            [recipientLockKey],
          );
        if (locked)
          await runner.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            [`email-account:${accountId}`],
          );
      } finally {
        await runner.release();
      }
    }
  }

  private log(
    event: string,
    message: EmailMessageEntity,
    request: EmailRequest,
  ) {
    this.logger.log(
      JSON.stringify({
        event,
        messageId: message.id,
        accountId: message.accountId,
        sourceType: request.source.type,
        purpose: request.purpose,
      }),
    );
  }
}
function stableJson(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stableJson(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function positiveInteger(key: string, fallback: number) {
  const n = Number(process.env[key] || fallback);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function retryDelay(reason: string, attempt: number) {
  if (reason === "account_busy" || reason === "recipient_busy")
    return 5000 + Math.floor(Math.random() * 10_001);
  const base = reason === "quota" ? 3_600_000 : reason === "transient" ? 60_000 : 300_000;
  const raw = base * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(raw, reason === "quota" ? 6 * 3_600_000 : 80 * 60_000);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(capped * jitter);
}
