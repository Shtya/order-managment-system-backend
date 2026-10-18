import { BadRequestException, Injectable } from "@nestjs/common";
import { CampaignAudienceType } from "entities/campaigns.entity";
import { TranslationService } from "common/translation.service";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";
import { normalizeEmail } from 'src/email/email.types';
import {
  AudienceInput,
  AudiencePage,
  AudienceSource,
  CampaignAudience,
  ManualRecipientInput,
  ManualSnapshotEntry,
} from "./campaign-audience.abstract";

const MANUAL_RECIPIENTS_LIMIT = 5000;
const PAGE_DEFAULT = 1000;

@Injectable()
export class ManualCampaignAudience extends CampaignAudience {
  readonly type = CampaignAudienceType.MANUAL;

  constructor(private readonly translations: TranslationService) {
    super();
  }

  async validate(adminId: string, input: AudienceInput): Promise<void> {
    void adminId;
    if (input.audienceSegmentId || input.audienceFilter) {
      throw new BadRequestException(
        this.translations.t(
          "domains.campaigns.audience_fields_not_allowed_for_manual",
        ),
      );
    }
    if (input.manualRecipients !== undefined && input.manualRecipients !== null) {
      this.validateRecipients(input.manualRecipients, input.channel);
    }
  }

  // Normalizes + dedups a raw payload into the snapshot stored on the
  // campaign row. Throws on the same rules as validate().
  buildSnapshot(raw: ManualRecipientInput[], channel = 'whatsapp'): ManualSnapshotEntry[] {
    this.validateRecipients(raw, channel);
    const seen = new Set<string>();
    const snapshot: ManualSnapshotEntry[] = [];
    for (const item of raw) {
      const phoneNumber = normalizeEgyptianPhoneNumber(
        String(item?.phoneNumber ?? ""),
      );
      const email = normalizeEmail(item.email);
      const destination = channel === 'email' ? email : phoneNumber;
      if (!destination || seen.has(destination)) continue;
      seen.add(destination);
      snapshot.push({ phoneNumber: phoneNumber || null, ...(channel === 'email' ? { email } : {}), name: item?.name?.trim() || null });
    }
    return snapshot;
  }

  async count(adminId: string, source: AudienceSource): Promise<number> {
    void adminId;
    if (source.kind !== "manual") return 0;
    return source.entries.length;
  }

  async listPage(
    adminId: string,
    source: AudienceSource,
    cursor?: any,
    limit?: number,
  ): Promise<AudiencePage> {
    void adminId;
    if (source.kind !== "manual") {
      return { records: [], hasMore: false };
    }
    const pageSize = Math.min(2000, Math.max(1, limit ?? PAGE_DEFAULT));
    const offset =
      typeof cursor?.offset === "number" && cursor.offset >= 0
        ? cursor.offset
        : 0;
    const slice = source.entries.slice(offset, offset + pageSize);
    return {
      records: slice.map((entry) => ({
        phoneNumber: entry.phoneNumber,
        email: entry.email,
        name: entry.name ?? null,
        clientId: null,
        customerId: null,
      })),
      hasMore: offset + pageSize < source.entries.length,
      nextCursor: { offset: offset + pageSize },
    };
  }

  private validateRecipients(manual: ManualRecipientInput[], channel = 'whatsapp') {
    if (!Array.isArray(manual) || manual.length === 0) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.manual_recipients_required"),
      );
    }
    if (manual.length > MANUAL_RECIPIENTS_LIMIT) {
      throw new BadRequestException(
        this.translations.t(
          "domains.campaigns.manual_recipients_limit_exceeded",
          { args: { limit: MANUAL_RECIPIENTS_LIMIT } },
        ),
      );
    }
    for (const item of manual) {
      if (channel === 'email') {
        if (!normalizeEmail(item?.email)) throw new BadRequestException('email.invalid_address');
        continue;
      }
      const normalized = normalizeEgyptianPhoneNumber(
        String(item?.phoneNumber ?? ""),
      );
      if (!normalized) {
        throw new BadRequestException(
          this.translations.t(
            "domains.campaigns.manual_recipients_invalid_phone",
          ),
        );
      }
    }
  }
}
