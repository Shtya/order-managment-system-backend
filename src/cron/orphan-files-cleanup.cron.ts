import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { OrphanFileEntity } from "entities/files.entity";
import { LessThan, Repository } from "typeorm";
import { unlink } from "fs/promises";
import { join } from "path";

@Injectable()
export class OrphanFilesCleanupCronService {
  private readonly logger = new Logger(OrphanFilesCleanupCronService.name);

  constructor(
    @InjectRepository(OrphanFileEntity)
    private readonly orphanRepo: Repository<OrphanFileEntity>,
  ) { }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupOldOrphans() {
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours

    const rows = await this.orphanRepo.find({
      where: { created_at: LessThan(cutoff) } as any,
      select: ["id", "url"],
      take: 2000,
    });

    if (!rows.length) return;

    for (const r of rows) {
      try {
        // url like /uploads/products/xxx.jpg
        const filePath = join(process.cwd(), r.url);
        await unlink(filePath);
      } catch (e: any) {
        // best-effort; continue
      }
    }

    const ids = rows.map((r) => r.id);
    const res = await this.orphanRepo.delete(ids as any);

    if ((res as any)?.affected) {
      this.logger.log(`Deleted ${res.affected} orphan files older than 2 hours.`);
    }
  }
}

