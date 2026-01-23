import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { StoreEntity } from "entities/stores.entity";
 import { CreateStoreDto, UpdateStoreDto } from "dto/stores.dto";
import { CRUD } from "../../common/crud.service";

@Injectable()
export class StoresService {
  constructor(@InjectRepository(StoreEntity) private storesRepo: Repository<StoreEntity>) {}

  private tenantId(me: any) {
    // حسب نظامك: أغلب الوقت req.user.adminId موجود
    return me?.adminId;
  }

  async list(me: any, q?: any) {
    const adminId = this.tenantId(me);
    const search = q?.search;
    const page = q?.page ?? 1;
    const limit = q?.limit ?? 10;
    const sortBy = q?.sortBy ?? "created_at";
    const sortOrder = (q?.sortOrder ?? "DESC") as "ASC" | "DESC";

    return CRUD.findAll(
      this.storesRepo,
      "stores",
      search,
      page,
      limit,
      sortBy,
      sortOrder,
      [],
      ["name", "code"],
      { adminId }
    );
  }

  async get(me: any, id: number) {
    const adminId = this.tenantId(me);
    const entity = await CRUD.findOne(this.storesRepo, "stores", id);
    if ((entity as any).adminId !== adminId) throw new ForbiddenException("Not allowed");
    return entity;
  }

  async create(me: any, dto: CreateStoreDto) {
    const adminId = this.tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    // uniqueness by adminId already indexed, but we give friendly errors
    const existsCode = await this.storesRepo.findOne({ where: { adminId, code: dto.code } as any });
    if (existsCode) throw new BadRequestException("Store code already exists");

    const existsName = await this.storesRepo.findOne({ where: { adminId, name: dto.name } as any });
    if (existsName) throw new BadRequestException("Store name already exists");

    const store = this.storesRepo.create({
      adminId,
      name: dto.name,
      code: dto.code,
      isActive: dto.isActive ?? true,
    });

    return this.storesRepo.save(store);
  }

  async update(me: any, id: number, dto: UpdateStoreDto) {
    const adminId = this.tenantId(me);
    const store = await this.get(me, id);

    if (dto.code && dto.code !== (store as any).code) {
      const existsCode = await this.storesRepo.findOne({ where: { adminId, code: dto.code } as any });
      if (existsCode) throw new BadRequestException("Store code already exists");
    }
    if (dto.name && dto.name !== (store as any).name) {
      const existsName = await this.storesRepo.findOne({ where: { adminId, name: dto.name } as any });
      if (existsName) throw new BadRequestException("Store name already exists");
    }

    Object.assign(store as any, dto);
    return this.storesRepo.save(store as any);
  }

  async remove(me: any, id: number) {
    // ensure tenant
    await this.get(me, id);
    return CRUD.delete(this.storesRepo, "stores", id);
  }
}
