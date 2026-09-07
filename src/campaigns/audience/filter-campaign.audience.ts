import { BadRequestException, Injectable } from "@nestjs/common";
import { CampaignAudienceType } from "entities/campaigns.entity";
import { TranslationService } from "common/translation.service";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";
import { AudienceService } from "src/audience/audience.service";
import {
  AudienceInput,
  AudiencePage,
  AudienceSource,
  CampaignAudience,
  NormalizedAudienceRecipient,
} from "./campaign-audience.abstract";

const PAGE_DEFAULT = 1000;

@Injectable()
export class FilterCampaignAudience extends CampaignAudience {
  readonly type = CampaignAudienceType.CUSTOMERS;

  constructor(
    private readonly audienceService: AudienceService,
    private readonly translations: TranslationService,
  ) {
    super();
  }

  async validate(adminId: string, input: AudienceInput): Promise<void> {
    void adminId;
    if (!input.audienceFilter) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.audience_filter_required"),
      );
    }
    if (input.audienceSegmentId) {
      throw new BadRequestException(
        this.translations.t(
          "domains.campaigns.audience_segment_id_not_allowed_for_customers",
        ),
      );
    }
    // if (input.fileUrl || input.stagedFilePath) {
    //   throw new BadRequestException(
    //     this.translations.t(
    //       "domains.campaigns.audience_file_url_not_allowed_for_customers",
    //     ),
    //   );
    // }
  }

  async count(adminId: string, source: AudienceSource): Promise<number> {
    if (source.kind !== "filter") return 0;
    return this.audienceService.countRecipients(adminId, source.filter);
  }

  async listPage(
    adminId: string,
    source: AudienceSource,
    cursor?: any,
    limit?: number,
  ): Promise<AudiencePage> {
    if (source.kind !== "filter") {
      return { records: [], hasMore: false };
    }
    const page = await this.audienceService.listRecipientsPage(
      adminId,
      source.filter,
      { cursor, limit: Math.min(2000, Math.max(1, limit ?? PAGE_DEFAULT)) },
    );
    // Clients without a primary contact carry no phone: un-sendable and
    // un-keyable, so they are dropped here (count() stays the raw SQL
    // count — estimates are labeled before-skips).
    const records: NormalizedAudienceRecipient[] = [];
    for (const row of page.records) {
      const phoneNumber = normalizeEgyptianPhoneNumber(
        String(row.phoneNumber ?? ""),
      );
      if (!phoneNumber) continue;
      records.push({
        phoneNumber,
        name: row.name ?? null,
        clientId: row.clientId ?? null,
        customerId: row.customerId ?? null,
      });
    }
    return {
      records,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  }
}
