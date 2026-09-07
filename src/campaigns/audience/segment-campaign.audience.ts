import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { CampaignAudienceType } from "entities/campaigns.entity";
import {
  ClientSegmentEntity,
  ClientSegmentStatus,
  ClientSegmentType,
} from "entities/clients-segments.entity";
import { TranslationService } from "common/translation.service";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";
import { AudienceService } from "src/audience/audience.service";
import { resolveClientSendPhone } from "src/audience/resolve-client-send-phone";
import { ClientSegmentsService } from "src/client-segments/client-segments.service";
import {
  AudienceInput,
  AudiencePage,
  AudienceSource,
  CampaignAudience,
  NormalizedAudienceRecipient,
} from "./campaign-audience.abstract";

const PAGE_DEFAULT = 1000;

@Injectable()
export class SegmentCampaignAudience extends CampaignAudience {
  readonly type = CampaignAudienceType.SEGMENT;

  constructor(
    @InjectRepository(ClientSegmentEntity)
    private readonly segmentRepo: Repository<ClientSegmentEntity>,
    private readonly audienceService: AudienceService,
    private readonly clientSegmentsService: ClientSegmentsService,
    private readonly translations: TranslationService,
  ) {
    super();
  }

  async validate(adminId: string, input: AudienceInput): Promise<void> {
    if (!input.audienceSegmentId) {
      throw new BadRequestException(
        this.translations.t(
          "domains.campaigns.audience_segment_id_required",
        ),
      );
    }
    if (input.audienceFilter) {
      throw new BadRequestException(
        this.translations.t(
          "domains.campaigns.audience_filter_not_allowed_for_segment",
        ),
      );
    }
    // if (input.fileUrl || input.stagedFilePath) {
    //   throw new BadRequestException(
    //     this.translations.t(
    //       "domains.campaigns.audience_file_url_not_allowed_for_segment",
    //     ),
    //   );
    // }
    await this.loadActiveSegment(adminId, input.audienceSegmentId);
  }

  async count(adminId: string, source: AudienceSource): Promise<number> {
    if (source.kind !== "segment") return 0;
    const segment = await this.loadActiveSegment(adminId, source.segmentId);
    if (segment.type === ClientSegmentType.FROZEN) {
      return Number(segment.frozenRecipientsCount || 0);
    }
    return this.audienceService.countRecipients(
      adminId,
      segment.audienceFilter as any,
    );
  }

  async listPage(
    adminId: string,
    source: AudienceSource,
    cursor?: any,
    limit?: number,
  ): Promise<AudiencePage> {
    if (source.kind !== "segment") {
      return { records: [], hasMore: false };
    }
    const segment = await this.loadActiveSegment(adminId, source.segmentId);
    if (segment.type === ClientSegmentType.FROZEN) {
      return this.listFrozenPage(
        adminId,
        source.segmentId,
        cursor,
        limit,
      );
    }
    const page = await this.audienceService.listRecipientsPage(
      adminId,
      segment.audienceFilter as any,
      { cursor, limit: Math.min(2000, Math.max(1, limit ?? PAGE_DEFAULT)) },
    );
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

  private async loadActiveSegment(adminId: string, segmentId: string) {
    const segment = await this.segmentRepo.findOne({
      where: { id: segmentId, adminId, status: ClientSegmentStatus.ACTIVE },
    });
    if (!segment) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.audience_segment_not_found"),
      );
    }
    return segment;
  }

  private async listFrozenPage(
    adminId: string,
    segmentId: string,
    cursor?: any,
    limit?: number,
  ): Promise<AudiencePage> {
    // Reuses the segment snapshot reader (single source of truth for
    // frozen joins); campaigns only add normalization + no-phone skips.
    const page = await this.clientSegmentsService.listFrozenRecipientsPage(
      adminId,
      segmentId,
      { cursor, limit: Math.min(2000, Math.max(1, limit ?? PAGE_DEFAULT)) },
    );

    const records: NormalizedAudienceRecipient[] = [];
    for (const row of page.records) {
      const resolved = resolveClientSendPhone((row as any).client);
      const phoneNumber = normalizeEgyptianPhoneNumber(
        String(resolved.phoneNumber ?? ""),
      );
      if (!phoneNumber) continue;
      records.push({
        phoneNumber,
        name: (row as any).client?.name ?? null,
        clientId: row.clientId ?? null,
        customerId: resolved.customerId ?? row.customerId ?? null,
      });
    }
    return {
      records,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  }
}
