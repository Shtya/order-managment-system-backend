import { BadRequestException, forwardRef, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, In, Repository } from "typeorm";
import { OrphanFileEntity } from "entities/files.entity";
import { TranslationService } from "common/translation.service";

@Injectable()
export class OrphanFilesService {
  constructor(
    @InjectRepository(OrphanFileEntity)
    private readonly orphanRepo: Repository<OrphanFileEntity>,
    @Inject(forwardRef(() => TranslationService))
    private readonly translations: TranslationService,
  ) {}

  async resolveOrphanUrlsOrThrow(
    mgr: EntityManager,
    adminId: string,
    ids: string[],
  ) {
    const repo = mgr.getRepository(OrphanFileEntity);
    const rows = await repo.find({
      where: { adminId, id: In(ids) } as any,
      select: {
        id: true,
        url: true
      },
    });

    if (rows.length !== ids.length) {
      throw new BadRequestException(
        this.translations.t("domains.orphan_files.some_not_found"),
      );
    }

    return rows.map((r) => ({ id: r.id, url: r.url }));
  }

  async deleteOrphansByIds(mgr: EntityManager, adminId: string, ids: string[]) {
    const cleanIds = (ids ?? []).filter(
      (x) => typeof x === "string" && x.length > 0,
    );
    if (!cleanIds.length) return;

    const repo = mgr.getRepository(OrphanFileEntity);
    const files = await repo.find({
      where: { adminId, id: In(cleanIds) } as any,
      select: {
        url: true
      },
    });

    await repo.delete({ adminId, id: In(cleanIds) } as any);
  }

  async create(adminId: string, url: string, expiresAt?: Date) {
    const row = this.orphanRepo.create({ adminId, url, expiresAt });
    return this.orphanRepo.save(row);
  }

  async renew(adminId: string, ids: string[], expiresAt: Date) {
    if (ids?.length) await this.orphanRepo.update({ adminId, id: In(ids) } as any, { expiresAt });
  }

  /** Promote files into durable ownership without deleting their physical bytes. */
  async promote(adminId: string, ids: string[], manager?: EntityManager) {
    if (!ids?.length) return;
    const repo = manager ? manager.getRepository(OrphanFileEntity) : this.orphanRepo;
    await repo.delete({ adminId, id: In(ids) } as any);
  }

  async deleteOne(adminId: string, id: string, mgr?: EntityManager) {
    if (!id) return;

    const repo = mgr ? mgr.getRepository(OrphanFileEntity) : this.orphanRepo;
    const file = await repo.findOne({ where: { adminId, id } as any });
    if (!file) {
      throw new BadRequestException(
        this.translations.t("domains.orphan_files.not_found"),
      );
    }
    const result = await repo.delete({
      adminId,
      id,
    } as any);
    return result;
  }
}
