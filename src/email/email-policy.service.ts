import { TranslationService } from "common/translation.service";
import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { createHash, createHmac } from "crypto";
import { EmailSubscriptionEntity } from "entities/email.entity";
import { EmailContext, requireEmail } from "./email.types";

@Injectable()
export class EmailPolicyService {
  constructor(
    @InjectRepository(EmailSubscriptionEntity)
    private readonly subscriptions: Repository<EmailSubscriptionEntity>,
    private readonly translations: TranslationService,
  ) {}
  private token(adminId: string, email: string) {
    const key = process.env.EMAIL_UNSUBSCRIBE_SECRET;
    if (!key || key.length < 32)
      throw new BadRequestException(
        this.translations.t("domains.email.unsubscribe_secret_not_configured"),
      );
    return createHmac("sha256", key)
      .update(`${adminId}:${email}`)
      .digest("hex");
  }
  async recordConsent(ctx: EmailContext, rawEmail: string, evidence: string) {
    const email = requireEmail(rawEmail, this.translations);
    if (!evidence?.trim())
      throw new BadRequestException(
        this.translations.t("domains.email.consent_evidence_required"),
      );
    const existing = await this.subscriptions.findOneBy({
      adminId: ctx.adminId,
      email,
    });
    if (existing?.suppressed)
      throw new BadRequestException(
        this.translations.t(
          "domains.email.resubscription_requires_separate_opt_in",
        ),
      );
    await this.subscriptions.upsert(
      {
        adminId: ctx.adminId,
        email,
        evidence,
        consented: true,
        consentedAt: new Date(),
        recordedBy: ctx.actorId,
        unsubscribeHash: this.hash(this.token(ctx.adminId, email)),
      },
      ["adminId", "email"],
    );
    return { email, consented: true };
  }
  async eligibility(adminId: string, email: string, purpose: string) {
    const record = await this.subscriptions.findOneBy({ adminId, email });
    if (
      record?.suppressed &&
      (purpose === "marketing" || record.reason !== "unsubscribed")
    )
      return record.reason || "unsubscribed";
    if (purpose === "marketing" && !record?.consented && process.env.NEED_MARKETING_CONSENT === "true")
      return "no_email_consent";
    return null;
  }
  async unsubscribe(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new BadRequestException(
        this.translations.t("domains.email.invalid_unsubscribe_token"),
      );
    await this.subscriptions.update(
      { unsubscribeHash: this.hash(token) },
      { suppressed: true, consented: false, reason: "unsubscribed" },
    );
    return {
      message: this.translations.t("domains.email.preferences_updated"),
    };
  }
  unsubscribeUrl(adminId: string, email: string) {
    const base = process.env.BACKEND_URL;
    // if (!base?.startsWith("https://"))
    //   throw new BadRequestException(
    //     this.translations.t("domains.email.public_https_url_required"),
    //   );
    return `${base.replace(/\/+$/, "")}/email/unsubscribe/${this.token(adminId, email)}`;
  }
  private hash(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }
}
