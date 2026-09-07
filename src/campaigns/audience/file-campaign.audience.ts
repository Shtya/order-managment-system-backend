import { BadRequestException, Injectable } from "@nestjs/common";
import { stat } from "fs/promises";
import { CampaignAudienceType } from "entities/campaigns.entity";
import { TranslationService } from "common/translation.service";
import {
  CAMPAIGN_AUDIENCE_FILE_MAX_BYTES,
  CAMPAIGN_AUDIENCE_FILE_MAX_MB,
  CAMPAIGN_AUDIENCE_FILE_MAX_ROWS,
  deleteLocalUploadsFile,
  parseAudienceFile,
  resolveUploadsDiskPath,
} from "../campaign-audience-file.util";
import {
  AudienceInput,
  AudiencePage,
  AudienceSource,
  CampaignAudience,
} from "./campaign-audience.abstract";
import type { AudienceFileParseResult } from "../campaign-audience-file.util";

const PAGE_DEFAULT = 1000;
// Parsed files are cached by disk path + mtime/size so validate + count
// + repeated listPage calls share a single parse. Bounded + invalidated
// by file metadata, so replaced uploads never serve stale rows.
const PARSE_CACHE_LIMIT = 20;

type CachedFileParse = {
  mtimeMs: number;
  size: number;
  parsed: AudienceFileParseResult;
};

@Injectable()
export class FileCampaignAudience extends CampaignAudience {
  readonly type = CampaignAudienceType.FILE;

  private readonly parseCache = new Map<string, CachedFileParse>();
  private readonly parseInflight = new Map<string, Promise<CachedFileParse>>();

  constructor(private readonly translations: TranslationService) {
    super();
  }

  async validate(adminId: string, input: AudienceInput): Promise<void> {
    void adminId;
    if (input.audienceSegmentId || input.audienceFilter) {
      throw new BadRequestException(
        this.translations.t(
          "domains.campaigns.audience_segment_filter_not_allowed_for_file",
        ),
      );
    }
    const { parsed } = await this.resolveParsed(
      input.stagedFilePath,
      input.fileUrl,
    );
    if (parsed.validCount === 0) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.audience_file_empty"),
      );
    }
    if (parsed.invalidCount > 0) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.audience_file_has_invalid_rows", {
          args: { count: parsed.invalidCount },
        }),
      );
    }
  }

  async count(adminId: string, source: AudienceSource): Promise<number> {
    void adminId;
    if (source.kind !== "file") return 0;
    const { parsed } = await this.resolveParsed(
      source.filePath,
      source.fileUrl,
    );
    if (parsed.validCount === 0) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.audience_file_empty"),
      );
    }
    if (parsed.invalidCount > 0) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.audience_file_has_invalid_rows", {
          args: { count: parsed.invalidCount },
        }),
      );
    }
    return parsed.validCount;
  }

  async listPage(
    adminId: string,
    source: AudienceSource,
    cursor?: any,
    limit?: number,
  ): Promise<AudiencePage> {
    void adminId;
    if (source.kind !== "file") {
      return { records: [], hasMore: false };
    }
    // TODO(materialize): stream rows instead of slicing a cached parse
    // when the send pipeline consumes this in a loop.
    const { parsed } = await this.resolveParsed(
      source.filePath,
      source.fileUrl,
    );
    const pageSize = Math.min(2000, Math.max(1, limit ?? PAGE_DEFAULT));
    const offset =
      typeof cursor?.offset === "number" && cursor.offset >= 0
        ? cursor.offset
        : 0;
    const slice = parsed.rows.slice(offset, offset + pageSize);
    return {
      records: slice.map((row) => ({
        phoneNumber: row.phoneNumber,
        name: row.name ?? null,
        clientId: null,
        customerId: null,
      })),
      hasMore: offset + pageSize < parsed.rows.length,
      nextCursor: { offset: offset + pageSize },
    };
  }

  private async resolveParsed(
    stagedFilePath?: string | null,
    fileUrl?: string | null,
  ): Promise<{ diskPath: string; parsed: AudienceFileParseResult }> {
    const diskPath =
      stagedFilePath || (fileUrl ? resolveUploadsDiskPath(fileUrl) : null);
    if (!diskPath) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.audience_file_not_found"),
      );
    }
    let fileStat: { size: number; mtimeMs: number };
    try {
      fileStat = await stat(diskPath);
    } catch {
      this.parseCache.delete(diskPath);
      throw new BadRequestException(
        this.translations.t("domains.campaigns.audience_file_not_found"),
      );
    }
    if (fileStat.size > CAMPAIGN_AUDIENCE_FILE_MAX_BYTES) {
      throw new BadRequestException(
        this.translations.t("domains.campaigns.audience_file_too_large", {
          args: { maxMb: CAMPAIGN_AUDIENCE_FILE_MAX_MB },
        }),
      );
    }
    const cached = this.parseCache.get(diskPath);
    if (
      cached &&
      cached.mtimeMs === fileStat.mtimeMs &&
      cached.size === fileStat.size
    ) {
      return { diskPath, parsed: cached.parsed };
    }
    // Concurrent callers for the same file share one parse.
    let inflight = this.parseInflight.get(diskPath);
    if (!inflight) {
      const expectedMtimeMs = fileStat.mtimeMs;
      const expectedSize = fileStat.size;
      inflight = parseAudienceFile(diskPath).then(async (parsed) => {
        // Discard the result if the file changed mid-parse.
        const fresh = await stat(diskPath).catch(() => null);
        if (
          !fresh ||
          fresh.mtimeMs !== expectedMtimeMs ||
          fresh.size !== expectedSize
        ) {
          throw new BadRequestException("file_changed");
        }
        const entry: CachedFileParse = {
          mtimeMs: expectedMtimeMs,
          size: expectedSize,
          parsed,
        };
        this.parseCache.set(diskPath, entry);
        if (this.parseCache.size > PARSE_CACHE_LIMIT) {
          const oldest = this.parseCache.keys().next();
          if (!oldest.done) this.parseCache.delete(oldest.value);
        }
        return entry;
      });
      this.parseInflight.set(diskPath, inflight);
      const forget = () => {
        if (this.parseInflight.get(diskPath) === inflight) {
          this.parseInflight.delete(diskPath);
        }
      };
      void inflight.then(forget, forget);
    }
    try {
      const entry = await inflight;
      return { diskPath, parsed: entry.parsed };
    } catch (error) {
      throw this.mapParseError(error);
    }
  }

  async deleteFile(url?: string | null): Promise<void> {
    await deleteLocalUploadsFile(url);
    
  }

  private mapParseError(error: unknown): BadRequestException {
    const code = error instanceof Error ? error.message : "";
    if (code === "missing_phone_column") {
      return new BadRequestException(
        this.translations.t(
          "domains.campaigns.audience_file_missing_phone_column",
        ),
      );
    }
    if (code === "too_many_rows") {
      return new BadRequestException(
        this.translations.t("domains.campaigns.audience_file_too_many_rows", {
          args: { limit: CAMPAIGN_AUDIENCE_FILE_MAX_ROWS },
        }),
      );
    }
    return new BadRequestException(
      this.translations.t("domains.campaigns.audience_file_invalid"),
    );
  }
}
