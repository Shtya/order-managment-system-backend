import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { CategoryEntity } from "entities/categories.entity";
import { CreateCategoryDto, UpdateCategoryDto } from "dto/category.dto";
import { CRUD } from "../../common/crud.service";
import { copyPhysicalFile, deletePhysicalFiles } from "common/healpers";

export function tenantId(me: any): string | null {
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

	async get(me: any, id: string) {
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

	async update(me: any, id: string, dto: UpdateCategoryDto) {
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

		// Delete old image if a new one is provided or if it's being removed
		if ((dto.image !== undefined && (cat as any).image && dto.image !== (cat as any).image) || dto.removeImage) {
			await deletePhysicalFiles([(cat as any).image]);
		}

		Object.assign(cat as any, dto);
		return this.catRepo.save(cat as any);
	}

	async remove(me: any, id: string) {
		const cat = await this.get(me, id);
		if ((cat as any).image) {
			await deletePhysicalFiles([(cat as any).image]);
		}
		return CRUD.delete(this.catRepo, "categories", id);
	}

	async duplicate(me: any, id: string, dto: { name: string; slug: string }) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const source = await this.get(me, id);
		if (!source) throw new BadRequestException("Source category not found");

		const existsName = await this.catRepo.findOne({ where: { adminId, name: dto.name } as any });
		if (existsName) throw new BadRequestException("Category name already exists");

		const existsSlug = await this.catRepo.findOne({ where: { adminId, slug: dto.slug } as any });
		if (existsSlug) throw new BadRequestException("Category slug already exists");

		let newImagePath = null;
		if ((source as any).image) {
			newImagePath = await copyPhysicalFile((source as any).image, "copy-cat");
		}

		const newCat = this.catRepo.create({
			adminId,
			name: dto.name,
			slug: dto.slug,
			image: newImagePath,
		} as any);

		return this.catRepo.save(newCat);
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
