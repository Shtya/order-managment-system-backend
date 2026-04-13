import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, In, Repository } from "typeorm";
import { OrphanFileEntity } from "entities/files.entity";

@Injectable()
export class OrphanFilesService {
  constructor(
    @InjectRepository(OrphanFileEntity)
    private readonly orphanRepo: Repository<OrphanFileEntity>,
  ) { }



  async resolveOrphanUrlsOrThrow(
    mgr: EntityManager,
    adminId: string,
    ids: number[],
  ) {
    const cleanIds = (ids ?? [])
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0);

    if (!cleanIds.length) return [];

    const repo = mgr.getRepository(OrphanFileEntity);
    const rows = await repo.find({
      where: { adminId, id: In(cleanIds) } as any,
      select: ["id", "url"],
    });

    if (rows.length !== cleanIds.length) {
      throw new BadRequestException("Some orphan files were not found");
    }

    return rows.map((r) => ({ id: r.id, url: r.url }));
  }

  async deleteOrphansByIds(mgr: EntityManager, adminId: string, ids: number[]) {
    const cleanIds = (ids ?? [])
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0);
    if (!cleanIds.length) return;

    await mgr.getRepository(OrphanFileEntity).delete({ adminId, id: In(cleanIds) } as any);
  }
  async create(adminId: string, url: string) {
    const row = this.orphanRepo.create({ adminId, url });
    return this.orphanRepo.save(row);
  }

  async deleteOne(adminId: string, id: number, mgr?: EntityManager) {
    if (!id || id <= 0) return;


    const repo = mgr ? mgr.getRepository(OrphanFileEntity) : this.orphanRepo;
    const file = await repo.findOne({ where: { adminId, id } as any });
    if (!file) {
      throw new BadRequestException("Orphan file not found");
    }
    return await repo.delete({
      adminId,
      id
    } as any);
  }
}

