import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
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
  const filters: Record<string, any> = {};

  if (q?.categoryId && q?.categoryId !== "none") {
    filters.categories = { id: Number(q.categoryId) }; // مهم تتحول لرقم
  }

  return CRUD.findAll(
    this.supplierRepo,
    "suppliers",
    q?.search,
    q?.page ?? 1,
    q?.limit ?? 10,
    q?.sortBy ?? "created_at",
    (q?.sortOrder ?? "DESC") as any,
    ["categories"],
    ["name", "phone", "email", "address"],
    {
      __tenant: {
        role: me?.role?.name,
        userId: me?.id,
        adminId: me?.adminId,
      },
      filters
    }
  );
}


	async get(me: any, id: number) {
		const adminId = tenantId(me);
		const entity = await CRUD.findOne(this.supplierRepo, "suppliers", id, ["categories"]);
 		return entity;
	}

	private async validateCategories(me: any, categoryIds: number[]) {
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

	async update(me: any, id: number, dto: UpdateSupplierDto) {
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

	async updateFinancials(me: any, id: number, dto: UpdateSupplierFinancialsDto) {
		const supplier = await this.get(me, id);

		if (dto.dueBalance !== undefined) (supplier as any).dueBalance = dto.dueBalance;
		if (dto.purchaseValue !== undefined) (supplier as any).purchaseValue = dto.purchaseValue;

		return this.supplierRepo.save(supplier as any);
	}

	async remove(me: any, id: number) {
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