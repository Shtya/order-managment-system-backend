import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, In, Repository } from "typeorm";
import { OrphanFileEntity } from "entities/files.entity";
import { deletePhysicalFiles } from "common/healpers";
import { TranslationService } from "common/translation.service";

@Injectable()
export class OrphanFilesService {
  constructor(
    @InjectRepository(OrphanFileEntity)
    private readonly orphanRepo: Repository<OrphanFileEntity>,
    private readonly translations: TranslationService
  ) { }


  async resolveOrphanUrlsOrThrow(
    mgr: EntityManager,
    adminId: string,
    ids: string[],
  ) {

    const repo = mgr.getRepository(OrphanFileEntity);
    const rows = await repo.find({
      where: { adminId, id: In(ids) } as any,
      select: ["id", "url"],
    });

    if (rows.length !== ids.length) {
      throw new BadRequestException(this.translations.t("domains.orphan_files.some_not_found"));
    }

    return rows.map((r) => ({ id: r.id, url: r.url }));
  }

  async deleteOrphansByIds(mgr: EntityManager, adminId: string, ids: string[]) {
    const cleanIds = (ids ?? [])
      .filter((x) => typeof x === 'string' && x.length > 0);
    if (!cleanIds.length) return;

    const repo = mgr.getRepository(OrphanFileEntity);
    const files = await repo.find({
      where: { adminId, id: In(cleanIds) } as any,
      select: ["url"],
    });

    await repo.delete({ adminId, id: In(cleanIds) } as any);
  }
  
  async create(adminId: string, url: string) {
    const row = this.orphanRepo.create({ adminId, url });
    return this.orphanRepo.save(row);
  }

  async deleteOne(adminId: string, id: string, mgr?: EntityManager) {
    if (!id) return;


    const repo = mgr ? mgr.getRepository(OrphanFileEntity) : this.orphanRepo;
    const file = await repo.findOne({ where: { adminId, id } as any });
    if (!file) {
      throw new BadRequestException(this.translations.t("domains.orphan_files.not_found"));
    }
    const result = await repo.delete({
      adminId,
      id
    } as any);
    return result;
  }
}

