import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { OrphanFileEntity } from "entities/files.entity";
import { Repository } from "typeorm";
import { unlink } from "fs/promises";
import { join } from "path";

@Injectable()
export class OrphanFilesCleanupCronService {
  private readonly logger = new Logger(OrphanFilesCleanupCronService.name);

  constructor(
    @InjectRepository(OrphanFileEntity)
    private readonly orphanRepo: Repository<OrphanFileEntity>,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupOldOrphans() {
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours

    const rows = await this.orphanRepo
      .createQueryBuilder("file")
      .select(["file.id", "file.url"])
      .where('file."expiresAt" IS NOT NULL AND file."expiresAt" < NOW()')
      .orWhere('file."expiresAt" IS NULL AND file.created_at < :cutoff', { cutoff })
      .take(2000)
      .getMany();

    if (!rows.length) return;

    for (const r of rows) {
      try {
        const pathname = r.url.startsWith("http") ? new URL(r.url).pathname : r.url;
        const relative = pathname.replace(/^\/+/, "");
        if (!relative.startsWith("uploads/")) continue;
        const filePath = join(process.cwd(), relative);
        await unlink(filePath);
      } catch (e: any) {
        // best-effort; continue
      }
    }

    const ids = rows.map((r) => r.id);
    const res = await this.orphanRepo.delete(ids as any);

    if ((res as any)?.affected) {
      this.logger.log(
        `Deleted ${res.affected} expired orphan files.`,
      );
    }
  }
}
