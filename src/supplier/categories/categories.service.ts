import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { CreateSupplierCategoryDto, UpdateSupplierCategoryDto } from "dto/supplier.dto";
import { SupplierCategoryEntity } from "../../../entities/supplier.entity";
import { CRUD } from "../../../common/crud.service";
import { tenantId } from "../../category/category.service";

@Injectable()
export class SupplierCategoriesService {
  constructor(
    @InjectRepository(SupplierCategoryEntity) private categoryRepo: Repository<SupplierCategoryEntity>,
  ) { }

  async list(me: any, q?: any) {
    return CRUD.findAll(
      this.categoryRepo,
      "supplier_categories",
      q?.search,
      q?.page ?? 1,
      q?.limit ?? 10,
      q?.sortBy ?? "created_at",
      (q?.sortOrder ?? "DESC") as any,
      [],
      ["name", "description"],
      {
        __tenant: {
          role: me?.role?.name,
          userId: me?.id,
          adminId: me?.adminId,
        },
      } as any
    );
  }

  async get(me: any, id: number) {
    const adminId = tenantId(me);
    const entity = await CRUD.findOne(this.categoryRepo, "supplier_categories", id, []);
    return entity;
  }

  async create(me: any, dto: CreateSupplierCategoryDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    // Check if name already exists for this admin
    const existing = await this.categoryRepo.findOne({
      where: { adminId, name: dto.name }
    });

    if (existing) {
      throw new BadRequestException("Category name already exists");
    }

    const category = this.categoryRepo.create({
      adminId,
      name: dto.name,
      description: dto.description,
    });

    return this.categoryRepo.save(category);
  }

  async update(me: any, id: number, dto: UpdateSupplierCategoryDto) {
    const category = await this.get(me, id);
    const adminId = tenantId(me);

    // If name is being changed, check if the new name is taken by ANOTHER record
    if (dto.name !== undefined && dto.name !== category.name) {
      const existing = await this.categoryRepo.findOne({
        where: { adminId, name: dto.name }
      });

      if (existing) {
        throw new BadRequestException("Category name already exists");
      }
      category.name = dto.name;
    }

    if (dto.description !== undefined) {
      category.description = dto.description;
    }

    return this.categoryRepo.save(category);
  }

  async remove(me: any, id: number) {
    await this.get(me, id);
    return CRUD.delete(this.categoryRepo, "supplier_categories", id);
  }
}