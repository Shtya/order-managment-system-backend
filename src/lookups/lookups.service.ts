import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Permission, Role, SystemRole, User } from 'entities/user.entity';
import { Brackets, Repository } from 'typeorm';
import { CategoryEntity } from 'entities/categories.entity';
import { StoreEntity } from 'entities/stores.entity';
import { WarehouseEntity } from 'entities/warehouses.entity';
import { ProductEntity, ProductVariantEntity } from '../../entities/sku.entity';
import { SupplierEntity } from '../../entities/supplier.entity';

type UsersLookupParams = {
	q?: string;
	roleId?: number;
	isActive?: boolean;
	limit: number;
};

type SimpleLookupParams = {
	q?: string;
	limit: number;
};



type ActiveLookupParams = {
	q?: string;
	isActive?: boolean;
	limit: number;
};

type SkusLookupParams = {
	q?: string;
	productId?: number;
	limit: number;
};


@Injectable()
export class LookupsService {
	constructor(
		@InjectRepository(User) private readonly usersRepo: Repository<User>,
		@InjectRepository(Role) private readonly rolesRepo: Repository<Role>,
		@InjectRepository(Permission) private readonly permsRepo: Repository<Permission>,

		@InjectRepository(CategoryEntity) private readonly categoriesRepo: Repository<CategoryEntity>,
		@InjectRepository(StoreEntity) private readonly storesRepo: Repository<StoreEntity>,
		@InjectRepository(WarehouseEntity) private readonly warehousesRepo: Repository<WarehouseEntity>,

		@InjectRepository(ProductEntity) private readonly productsRepo: Repository<ProductEntity>,
		@InjectRepository(ProductVariantEntity) private readonly variantsRepo: Repository<ProductVariantEntity>,
		@InjectRepository(SupplierEntity) private readonly suppliersRepo: Repository<SupplierEntity>,
	) { }

	private isSuperAdmin(me: User) {
		return me.role?.name === SystemRole.SUPER_ADMIN;
	}


	async suppliers(me: User, params: SimpleLookupParams) {
		const qb = this.suppliersRepo
			.createQueryBuilder('s')
			.select([
				's.id AS id',
				's.name AS name',
				's.phone AS phone',
				's.email AS email',
				's.address AS address',
			])
			.orderBy('s.id', 'DESC')
			.limit(params.limit);

		this.applyTenantScope(qb, 's', me);

		if (params.q?.trim()) {
			const q = `%${params.q.trim().toLowerCase()}%`;
			qb.andWhere(
				new Brackets((b) => {
					b.where('LOWER(s.name) LIKE :q', { q })
						.orWhere('LOWER(s.phone) LIKE :q', { q })
						.orWhere('LOWER(s.email) LIKE :q', { q });
				}),
			);
		}

		const rows = await qb.getRawMany();
		return rows.map((x) => ({
			id: Number(x.id),
			label: x.phone ? `${x.name} (${x.phone})` : x.name,
			name: x.name,
			phone: x.phone ?? null,
			email: x.email ?? null,
			address: x.address ?? null,
		}));
	}


	async skus(me: User, params: SkusLookupParams) {
		const qb = this.variantsRepo
			.createQueryBuilder('v')
			.select([
				'v.id AS id',
				'v.productId AS "productId"',
				'v.sku AS sku',
				'v.key AS "key"',
				'v.stockOnHand AS "stockOnHand"',
				'v.reserved AS reserved',
				'v.price AS price',
			])
			.orderBy('v.id', 'DESC')
			.limit(params.limit);

		this.applyTenantScope(qb, 'v', me);

		if (params.productId) {
			qb.andWhere('v.productId = :productId', { productId: params.productId });
		}

		if (params.q?.trim()) {
			const tokens = params.q.trim().toLowerCase().split(/\s+/).filter(Boolean);

			qb.andWhere(
				new Brackets((b) => {
					for (const t of tokens) {
						const like = `%${t}%`;
						b.andWhere(
							new Brackets((bb) => {
								bb.where('LOWER(v.sku) LIKE :like', { like })
									.orWhere('LOWER(v.key) LIKE :like', { like });
							}),
						);
					}
				}),
			);
		}


		const rows = await qb.getRawMany();
		return rows.map((x) => ({
			id: Number(x.id),
			productId: Number(x.productId),
			label: x.sku ? x.sku : `#${x.id}`,
			sku: x.sku ?? null,
			key: x.key ?? null,
			stockOnHand: Number(x.stockOnHand ?? 0),
			reserved: Number(x.reserved ?? 0),
			price: Number(x.price ?? 0),
			available: Math.max(0, Number(x.stockOnHand ?? 0) - Number(x.reserved ?? 0)),
		}));
	}


	async products(me: User, params: SimpleLookupParams) {
		const qb = this.productsRepo
			.createQueryBuilder('p')
			.select([
				'p.id AS id',
				'p.name AS name',
				'p.mainImage AS "mainImage"',
				'p.wholesalePrice AS "wholesalePrice"',
				'p.lowestPrice AS "lowestPrice"',
			])
			.orderBy('p.id', 'DESC')
			.limit(params.limit);

		this.applyTenantScope(qb, 'p', me);

		if (params.q?.trim()) {
			const q = `%${params.q.trim().toLowerCase()}%`;
			qb.andWhere('LOWER(p.name) LIKE :q', { q });
		}

		const rows = await qb.getRawMany();
		return rows.map((x) => ({
			id: Number(x.id),
			label: x.name,
			name: x.name,
			mainImage: x.mainImage ?? null,
			wholesalePrice: x.wholesalePrice ?? null,
			lowestPrice: x.lowestPrice ?? null,
		}));
	}


	private applyTenantScope(qb: any, alias: string, me: User) {
		if (this.isSuperAdmin(me)) {
			qb.andWhere(`${alias}.adminId IS NULL`);
			return;
		}

		if (me.role?.name === SystemRole.ADMIN) {
			qb.andWhere(`(${alias}.adminId IS NULL OR ${alias}.adminId = :meId)`, { meId: me.id });
			return;
		}

		if (me.adminId) {
			qb.andWhere(`(${alias}.adminId IS NULL OR ${alias}.adminId = :ownerAdminId)`, {
				ownerAdminId: me.adminId,
			});
			return;
		}

		qb.andWhere(`${alias}.adminId IS NULL`);
	}

	async users(me: User, params: UsersLookupParams) {
		const qb = this.usersRepo
			.createQueryBuilder('u')
			.leftJoin('u.role', 'r')
			// fields صغيرة للـ dropdown
			.select([
				'u.id AS id',
				'u.name AS name',
				'u.email AS email',
				'u.isActive AS "isActive"',
				'u.roleId AS "roleId"',
				'r.name AS "roleName"',
			])
			.orderBy('u.id', 'DESC')
			.limit(params.limit);

		// نفس policy الموجودة في UsersService.list:
		// super_admin => كل المستخدمين
		// admin => فقط users اللي adminId = me.id
		// user => نفسه فقط
		if (this.isSuperAdmin(me)) {
			// no extra filter
		} else if (me.role?.name === SystemRole.ADMIN) {
			qb.andWhere('u.adminId = :adminId', { adminId: me.id });
		} else {
			qb.andWhere('u.id = :meId', { meId: me.id });
		}

		if (typeof params.isActive === 'boolean') {
			qb.andWhere('u.isActive = :isActive', { isActive: params.isActive });
		}

		if (params.roleId) {
			qb.andWhere('u.roleId = :roleId', { roleId: params.roleId });
		}

		if (params.q?.trim()) {
			const q = `%${params.q.trim().toLowerCase()}%`;
			qb.andWhere(
				new Brackets((w) => {
					w.where('LOWER(u.name) LIKE :q', { q }).orWhere('LOWER(u.email) LIKE :q', { q });
				}),
			);
		}

		const rows = await qb.getRawMany();

		// صيغة مناسبة للدروب داون + معلومات إضافية للبحث/العرض
		return rows.map((x) => ({
			id: Number(x.id),
			label: `${x.name} (${x.email})`,
			name: x.name,
			email: x.email,
			isActive: x.isActive,
			roleId: Number(x.roleId),
			roleName: x.roleName,
		}));
	}

	async roles(me: User, params: SimpleLookupParams) {
		const qb = this.rolesRepo
			.createQueryBuilder('r')
			.select([
				'r.id AS id',
				'r.name AS name',
				'r.description AS description',
				'r.adminId AS adminId',
			])
			.orderBy('r.id', 'DESC')
			.limit(params.limit);

		// نفس list/get
		if (this.isSuperAdmin(me)) {
			// super admin: only adminId null
			qb.where('r.adminId IS NULL');
		} else {
			// everyone except super admin: block super_admin/admin roles
			qb.where('r.name NOT IN (:...blocked)', {
				blocked: [SystemRole.SUPER_ADMIN, SystemRole.ADMIN],
			});

			if (me.role?.name === SystemRole.ADMIN) {
				// Admin: global OR owned by him
				qb.andWhere('(r.adminId IS NULL OR r.adminId = :meId)', { meId: me.id });
			} else if (me.adminId) {
				// User under admin: global OR owned by his owner admin
				qb.andWhere('(r.adminId IS NULL OR r.adminId = :ownerAdminId)', {
					ownerAdminId: me.adminId,
				});
			} else {
				// User without adminId: global only
				qb.andWhere('r.adminId IS NULL');
			}
		}

		// search q
		if (params.q?.trim()) {
			const q = `%${params.q.trim().toLowerCase()}%`;
			qb.andWhere('(LOWER(r.name) LIKE :q OR LOWER(r.description) LIKE :q)', { q });
		}

		const rows = await qb.getRawMany();

		return rows.map((x) => ({
			id: Number(x.id),
			label: x.name,
			name: x.name,
			description: x.description,
		}));
	}

	async permissions(params: SimpleLookupParams) {
		const qb = this.permsRepo
			.createQueryBuilder('p')
			.select(['p.id AS id', 'p.name AS name'])
			.orderBy('p.id', 'DESC')
			.limit(params.limit);

		if (params.q?.trim()) {
			const q = `%${params.q.trim().toLowerCase()}%`;
			qb.where('LOWER(p.name) LIKE :q', { q });
		}

		const rows = await qb.getRawMany();
		return rows.map((x) => ({
			id: Number(x.id),
			label: x.name,
			name: x.name,
		}));
	}


	async categories(me: User, params: SimpleLookupParams) {
		const qb = this.categoriesRepo
			.createQueryBuilder('c')
			.select(['c.id AS id', 'c.name AS name', 'c.slug AS slug', 'c.image AS image'])
			.orderBy('c.id', 'DESC')
			.limit(params.limit);

		this.applyTenantScope(qb, 'c', me);

		if (params.q?.trim()) {
			const q = `%${params.q.trim().toLowerCase()}%`;
			qb.andWhere('(LOWER(c.name) LIKE :q OR LOWER(c.slug) LIKE :q)', { q });
		}

		const rows = await qb.getRawMany();
		return rows.map((x) => ({
			id: Number(x.id),
			label: x.name,
			name: x.name,
			slug: x.slug,
			image: x.image,
		}));
	}

	async stores(me: User, params: ActiveLookupParams) {
		const qb = this.storesRepo
			.createQueryBuilder('s')
			.select(['s.id AS id', 's.name AS name', 's.isActive AS "isActive"'])
			.orderBy('s.id', 'DESC')
			.limit(params.limit);

		this.applyTenantScope(qb, 's', me);

		if (typeof params.isActive === 'boolean') qb.andWhere('s.isActive = :isActive', { isActive: params.isActive });

		if (params.q?.trim()) {
			const q = `%${params.q.trim().toLowerCase()}%`;
			qb.andWhere('(LOWER(s.name) LIKE :q', { q });
		}

		const rows = await qb.getRawMany();
		return rows.map((x) => ({
			id: Number(x.id),
			label: `${x.name}`,
			name: x.name,
			code: x.code,
			isActive: x.isActive,
		}));
	}

	async warehouses(me: User, params: ActiveLookupParams) {
		const qb = this.warehousesRepo
			.createQueryBuilder('w')
			.leftJoin('w.manager', 'm')
			.select([
				'w.id AS id',
				'w.name AS name',
				'w.location AS location',
				'w.isActive AS "isActive"',
				'm.id AS "managerId"',
				'm.name AS "managerName"',
			])
			.orderBy('w.id', 'DESC')
			.limit(params.limit);

		this.applyTenantScope(qb, 'w', me);

		if (typeof params.isActive === 'boolean') qb.andWhere('w.isActive = :isActive', { isActive: params.isActive });

		if (params.q?.trim()) {
			const q = `%${params.q.trim().toLowerCase()}%`;
			qb.andWhere(
				new Brackets((b) => {
					b.where('LOWER(w.name) LIKE :q', { q })
						.orWhere('LOWER(w.location) LIKE :q', { q })
						.orWhere('LOWER(m.name) LIKE :q', { q });
				}),
			);
		}

		const rows = await qb.getRawMany();
		return rows.map((x) => ({
			id: Number(x.id),
			label: x.location ? `${x.name} - ${x.location}` : x.name,
			name: x.name,
			location: x.location,
			isActive: x.isActive,
			managerId: x.managerId ? Number(x.managerId) : null,
			managerName: x.managerName || null,
		}));
	}
}
