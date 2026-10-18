import type { TranslationService } from "common/translation.service";
import { BadRequestException } from "@nestjs/common";
import { isEmail } from "class-validator";

export type EmailContext = { adminId: string; actorId: string };
export type EmailDocument = {
  schemaVersion: 1 | 2;
  blocks: Record<string, any>[];
  direction?: "ltr" | "rtl";
  width?: number;
  defaults?: Record<string, any>;
};
export type EmailContent = {
  subject: string;
  preheader?: string;
  document: EmailDocument;
  businessIdentity: string;
};
export type EmailVariables = Record<string, string>;
export type EmailRequest = {
  accountId: string;
  to: string;
  content: EmailContent;
  variables?: EmailVariables;
  purpose: "marketing" | "transactional" | "test";
  idempotencyKey: string;
  source: { type: string; id?: string; recipientId?: string };
};
export type PreparedEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
};
export interface EmailProvider {
  readonly key: string;
  send(
    account: { id: string; email: string; senderName: string },
    message: PreparedEmail,
  ): Promise<{ providerMessageId: string }>;
  revoke(accountId: string): Promise<unknown>;
}
export const EMAIL_PROVIDERS = Symbol("EMAIL_PROVIDERS");
export class EmailDeferredError extends Error {
  constructor(
    public readonly reason: string,
    public readonly delayMs = 60_000,
  ) {
    super(reason);
  }
}
export class EmailProviderError extends Error {
  constructor(
    public readonly category:
      | "reconnect"
      | "quota"
      | "blocked"
      | "transient"
      | "fatal"
      | "unknown",
    public readonly code: string,
  ) {
    super(code);
  }
}
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[\x21-\x7e]+$/.test(email) && isEmail(email)
    ? email
    : null;
}
export function requireEmail(
  value: unknown,
  translations: TranslationService,
): string {
  const email = normalizeEmail(value);
  if (!email)
    throw new BadRequestException(
      translations.t("domains.email.invalid_address"),
    );
  return email;
}
export function emailEnabled(translations: TranslationService) {
  if (process.env.EMAIL_FEATURE_ENABLED !== "true")
    throw new BadRequestException(
      translations.t("domains.email.feature_disabled"),
    );
}
