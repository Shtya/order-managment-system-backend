import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Not, Repository } from "typeorm";
import { CategoryEntity } from "entities/categories.entity";
import { CreateCategoryDto, UpdateCategoryDto } from "dto/category.dto";
import { CRUD } from "../../common/crud.service";

export function tenantId(me: any): any | null {
	if (!me) return null;

	const roleName = me.role?.name;
	if (roleName === 'super_admin') return null;
	if (roleName === 'admin') return me.id;

	return me.adminId;
}

@Injectable()
export class CategoriesService {
	constructor(@InjectRepository(CategoryEntity) private catRepo: Repository<CategoryEntity>) { }

	async list(me: any, q?: any) {

		const filters: Record<string, any> = {};

		if (q?.categoryId && q?.categoryId != "none") filters.categoryId = q.categoryId;


		return CRUD.findAll(
			this.catRepo,
			"categories",
			q?.search,
			q?.page ?? 1,
			q?.limit ?? 10,
			q?.sortBy ?? "created_at",
			(q?.sortOrder ?? "DESC") as any,
			[],
			["name", "slug"],
			{
				__tenant: {
					role: me?.role?.name,
					userId: me?.id,
					adminId: me?.adminId,
				},
				filters
			} as any
		);
	}

	async get(me: any, id: number) {
		const entity = await CRUD.findOne(this.catRepo, "categories", id);
		return entity;
	}

	async create(me: any, dto: CreateCategoryDto) {
		const adminId = tenantId(me);

		if (!adminId) throw new BadRequestException("Missing adminId");

		const existsName = await this.catRepo.findOne({ where: { adminId, name: dto.name } as any });
		if (existsName) throw new BadRequestException("Category name already exists");

		const existsSlug = await this.catRepo.findOne({ where: { adminId, slug: dto.slug } as any });
		if (existsSlug) throw new BadRequestException("Category slug already exists");

		// slug uniqueness handled by index + entity hook if empty
		const cat = this.catRepo.create({ adminId, ...dto } as any);
		return this.catRepo.save(cat);
	}

	async update(me: any, id: number, dto: UpdateCategoryDto) {
		const adminId = tenantId(me);
		const cat = await this.get(me, id);

		if (dto.name && dto.name !== (cat as any).name) {
			const existsName = await this.catRepo.findOne({ where: { adminId, name: dto.name } as any });
			if (existsName) throw new BadRequestException("Category name already exists");
		}

		if (dto.slug && dto.slug !== (cat as any).slug) {
			const existsName = await this.catRepo.findOne({ where: { adminId, slug: dto.slug } as any });
			if (existsName) throw new BadRequestException("Category slug already exists");
		}

		Object.assign(cat as any, dto);
		return this.catRepo.save(cat as any);
	}

	async remove(me: any, id: number) {
		await this.get(me, id);
		return CRUD.delete(this.catRepo, "categories", id);
	}


	async checkSlug(me: any, slug, categoryId) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");
		if (categoryId) {
			const cat = await this.get(me, categoryId);
			if (slug === cat.slug) return {
				isUnique: true
			}
		}

		const exists = await this.catRepo.findOne({
			where: {
				adminId,
				slug: slug.trim().toLowerCase(),
			},
			select: ["id"] // نختار الـ id فقط لتحسين الأداء
		});

		return { isUnique: !exists };
	}
}
