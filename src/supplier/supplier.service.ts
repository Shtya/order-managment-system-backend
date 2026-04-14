import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In, Brackets } from "typeorm";
import { SupplierEntity } from "entities/supplier.entity";
import { SupplierCategoryEntity } from "entities/supplier.entity";
import { CreateSupplierDto, UpdateSupplierDto, UpdateSupplierFinancialsDto } from "dto/supplier.dto";
import { CRUD } from "../../common/crud.service";
import { tenantId } from "../category/category.service";

@Injectable()
export class SuppliersService {
	constructor(
		@InjectRepository(SupplierEntity) private supplierRepo: Repository<SupplierEntity>,
		@InjectRepository(SupplierCategoryEntity) private categoryRepo: Repository<SupplierCategoryEntity>,
	) { }

	async list(me: any, q?: any) {
		const pageNumber = Number(q?.page) || 1;
		const limitNumber = Number(q?.limit) || 10;
		const skip = (pageNumber - 1) * limitNumber;
		const adminId = tenantId(me)
		const query = this.supplierRepo.createQueryBuilder("suppliers")
			.leftJoinAndSelect("suppliers.categories", "category")
			// 1. Mandatory Tenant Isolation
			.where("suppliers.adminId = :adminId", { adminId: adminId });

		// 2. Specific Filters (Exact or Partial)
		if (q?.categoryId && q?.categoryId !== "none") {
			query.andWhere("category.id = :categoryId", { categoryId: q.categoryId });
		}

		if (q?.name) {
			query.andWhere("suppliers.name LIKE :name", { name: `%${q.name}%` });
		}

		if (q?.phone) {
			query.andWhere("suppliers.phone LIKE :phone", { phone: `%${q.phone}%` })
				.andWhere("suppliers.secondPhone LIKE :phone", { phone: `%${q.phone}%` })
		}

		// 3. General Search (Across multiple fields)
		if (q?.search) {
			query.andWhere(
				new Brackets((qb) => {
					qb.where("suppliers.name ILIKE :search", { search: `%${q.search}%` })
						.orWhere("suppliers.phone ILIKE :search", { search: `%${q.search}%` })
						.orWhere("suppliers.secondPhone ILIKE :search", { search: `%${q.search}%` })
						.orWhere("suppliers.email ILIKE :search", { search: `%${q.search}%` })
						.orWhere("suppliers.address ILIKE :search", { search: `%${q.search}%` });
				})
			);
		}

		// 4. Sorting & Pagination
		const sortBy = q?.sortBy || "created_at";
		const sortOrder = q?.sortOrder?.toUpperCase() === "ASC" ? "ASC" : "DESC";

		// Ensure sortBy has the alias prefix to avoid ambiguity
		const finalSortBy = sortBy.includes(".") ? sortBy : `suppliers.${sortBy}`;

		const [data, total] = await query
			.orderBy(finalSortBy, sortOrder)
			.skip(skip)
			.take(limitNumber)
			.getManyAndCount();

		// 5. Final Trimmed Response
		return {
			total_records: total,
			current_page: pageNumber,
			per_page: limitNumber,
			records: data,
		};
	}


	async get(me: any, id: string) {
		const adminId = tenantId(me);
		const entity = await CRUD.findOne(this.supplierRepo, "suppliers", id, ["categories"]);
		return entity;
	}

	private async validateCategories(me: any, categoryIds: string[]) {
		if (!categoryIds || categoryIds.length === 0) {
			throw new BadRequestException("At least one category is required");
		}

		const adminId = tenantId(me);
		const categories = await this.categoryRepo.find({
			where: categoryIds.map((id) => ({ id, adminId })) as any,
		});

		if (categories.length !== categoryIds.length) {
			throw new BadRequestException("Some categories not found or not in your tenant");
		}

		return categories;
	}

	async create(me: any, dto: CreateSupplierDto) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const categories = await this.validateCategories(me, dto.categoryIds);

		const supplier = this.supplierRepo.create({
			adminId,
			name: dto.name,
			address: dto.address,
			description: dto.description,
			phone: dto.phone,
			phoneCountry: dto.phoneCountry,
			secondPhone: dto.secondPhone,
			secondPhoneCountry: dto.secondPhoneCountry,
			email: dto.email,
			categories,
			dueBalance: 0,
			purchaseValue: 0,
		});

		return this.supplierRepo.save(supplier);
	}

	async update(me: any, id: string, dto: UpdateSupplierDto) {
		const supplier = await this.get(me, id);

		if (dto.categoryIds !== undefined) {
			const categories = await this.validateCategories(me, dto.categoryIds);
			(supplier as any).categories = categories;
		}

		if (dto.name !== undefined) (supplier as any).name = dto.name;
		if (dto.address !== undefined) (supplier as any).address = dto.address;
		if (dto.description !== undefined) (supplier as any).description = dto.description;
		if (dto.phone !== undefined) (supplier as any).phone = dto.phone;
		if (dto.phoneCountry !== undefined) (supplier as any).phoneCountry = dto.phoneCountry;
		if (dto.secondPhone !== undefined) (supplier as any).secondPhone = dto.secondPhone;
		if (dto.secondPhoneCountry !== undefined) (supplier as any).secondPhoneCountry = dto.secondPhoneCountry;
		if (dto.email !== undefined) (supplier as any).email = dto.email;

		return this.supplierRepo.save(supplier as any);
	}

	async updateFinancials(me: any, id: string, dto: UpdateSupplierFinancialsDto) {
		const supplier = await this.get(me, id);

		if (dto.dueBalance !== undefined) (supplier as any).dueBalance = dto.dueBalance;
		if (dto.purchaseValue !== undefined) (supplier as any).purchaseValue = dto.purchaseValue;

		return this.supplierRepo.save(supplier as any);
	}

	async remove(me: any, id: string) {
		await this.get(me, id);
		return CRUD.delete(this.supplierRepo, "suppliers", id);
	}

	async getStats(me: any) {
		const adminId = tenantId(me);

		const result = await this.supplierRepo
			.createQueryBuilder("supplier")
			.select("SUM(supplier.purchaseValue)", "totalPurchases")
			.addSelect("SUM(supplier.dueBalance)", "totalDue")
			.addSelect("COUNT(supplier.id)", "totalSuppliers")
			.where("supplier.adminId = :adminId", { adminId })
			.getRawOne();

		return {
			totalPurchases: parseFloat(result?.totalPurchases || "0"),
			totalDue: parseFloat(result?.totalDue || "0"),
			totalSuppliers: parseInt(result?.totalSuppliers || "0", 10),
		};
	}

	async export(me: any, q?: any) {
		const data = await this.list(me, { ...q, limit: 1000000 });

		// Transform for Excel export
		const records = data.records.map((s: any) => ({
			"الرقم": s.id,
			"اسم المورد": s.name,
			"رقم الهاتف": s.phone,
			"رقم الهاتف الثاني": s.secondPhone || "",
			"البريد الإلكتروني": s.email || "",
			"العنوان": s.address || "",
			"الفئات": s.categories?.map((c: any) => c.name).join(", ") || "",
			"الرصيد المستحق": s.dueBalance,
			"قيمة المشتريات": s.purchaseValue,
			"تاريخ الإنشاء": s.created_at,
		}));

		return records;
	}
}