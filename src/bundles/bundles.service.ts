// --- File: src/bundles/bundles.service.ts ---
import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Like, Repository } from "typeorm";
import { tenantId } from "../category/category.service";

import { BundleEntity, BundleItemEntity } from "entities/bundle.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import { CreateBundleDto, UpdateBundleDto } from "dto/bundle.dto";
import { CRUD } from "../../common/crud.service";
import * as ExcelJS from "exceljs";

@Injectable()
export class BundlesService {
	constructor(
		@InjectRepository(BundleEntity)
		private bundleRepo: Repository<BundleEntity>,

		@InjectRepository(BundleItemEntity)
		private itemRepo: Repository<BundleItemEntity>,

		@InjectRepository(ProductVariantEntity)
		private pvRepo: Repository<ProductVariantEntity>
	) { }


	async list(me: any, q?: any) {
		const filters: Record<string, any> = {};

		// 1. Category Filter
		if (q?.categoryId && q?.categoryId !== "none") {
			filters.categoryId = q.categoryId;
		}

		// 2. Numeric Range Filter (Mapping query 'wholesalePrice' to entity 'price')
		if (q?.["wholesalePrice.gte"] || q?.["wholesalePrice.lte"]) {
			const gte = q["wholesalePrice.gte"];
			const lte = q["wholesalePrice.lte"];

			if (gte !== undefined && gte !== "" && !Number.isNaN(Number(gte))) {
				filters.price = filters.price ?? {};
				filters.price.gte = Number(gte);
			}

			if (lte !== undefined && lte !== "" && !Number.isNaN(Number(lte))) {
				filters.price = filters.price ?? {};
				filters.price.lte = Number(lte);
			}
		}

		// 3. Main CRUD Call
		return CRUD.findAll(
			this.bundleRepo,
			"bundle", // Alias
			q?.search, // Search term
			q?.page ?? 1,
			q?.limit ?? 10,
			q?.sortBy ?? "created_at",
			(q?.sortOrder ?? "DESC") as any,
			["items", "items.variant"], // Relations to load
			["name", "sku"], // 🔎 Searchable fields as requested
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
		const adminId = tenantId(me);
		const bundle = await this.bundleRepo.findOne({
			where: { id, adminId } as any,
			relations: ["items", "items.variant"],
		});
		if (!bundle) throw new BadRequestException("bundle not found");
		return bundle;
	}

	async getBySku(me: any, sku: string) {
		const adminId = tenantId(me);
		const bundle = await this.bundleRepo.findOne({
			where: { adminId, sku } as any,
			relations: ["items", "items.variant"],
		});
		if (!bundle) throw new BadRequestException("bundle SKU not found");
		return bundle;
	}

	async create(me: any, dto: CreateBundleDto) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const items = Array.isArray(dto.items) ? dto.items : [];
		if (!items.length) throw new BadRequestException("items is required");

		for (const it of items) {
			if (!Number.isInteger(it.variantId)) throw new BadRequestException("variantId must be int");
			if (!Number.isInteger(it.qty) || it.qty <= 0) throw new BadRequestException("qty must be > 0");
		}

		// ensure variants exist and belong to admin
		const ids = items.map((x) => x.variantId);

		const variants2 = await this.pvRepo.find({ where: { adminId } as any });
		const variantSet = new Set(variants2.filter(v => ids.includes(v.id)).map(v => v.id));

		for (const it of items) {
			if (!variantSet.has(it.variantId)) {
				throw new BadRequestException(`variantId not found: ${it.variantId}`);
			}
		}

		const b = this.bundleRepo.create({
			adminId,
			name: dto.name,
			sku: dto.sku,
			price: dto.price,
			description: dto.description,
			items: items.map((it) =>
				this.itemRepo.create({
					adminId,
					variantId: it.variantId,
					qty: it.qty,
				})
			),
		});

		const saved = await this.bundleRepo.save(b);
		return this.get(me, saved.id);
	}

	async exportBundles(me: any, q?: any) {
		const filters: Record<string, any> = {};

		// 1. Basic Filters
		if (q?.categoryId && q?.categoryId !== "none") {
			filters.categoryId = q.categoryId;
		}

		// 2. Price Range Filters (Query "wholesalePrice" -> DB "price")
		if (q?.["wholesalePrice.gte"] || q?.["wholesalePrice.lte"]) {
			const gte = q["wholesalePrice.gte"];
			const lte = q["wholesalePrice.lte"];

			if (gte !== undefined && gte !== "" && !Number.isNaN(Number(gte))) {
				filters.price = filters.price ?? {};
				filters.price.gte = Number(gte);
			}

			if (lte !== undefined && lte !== "" && !Number.isNaN(Number(lte))) {
				filters.price = filters.price ?? {};
				filters.price.lte = Number(lte);
			}
		}

		// 3. Fetch Data using SAME logic as list()
		const result = await CRUD.findAll(
			this.bundleRepo,
			"bundle",
			q?.search,
			1,
			q?.limit ?? 1000000,
			q?.sortBy ?? "created_at",
			(q?.sortOrder ?? "DESC") as any,
			["items"], // Relations needed for item count
			["name", "sku"], // Searchable fields
			{
				__tenant: {
					role: me?.role?.name,
					userId: me?.id,
					adminId: me?.adminId,
				},
				filters,
			} as any
		);

		// 4. Prepare Data for Excel
		const exportData = (result.records ?? []).map((b: any) => {
			return {
				id: b.id,
				name: b.name ?? "",
				sku: b.sku ?? "",
				price: b.price ?? 0,
				itemsCount: b.items?.length ?? 0,
				description: b.description ?? "",
				created_at: b.created_at
					? new Date(b.created_at).toLocaleDateString("en-US")
					: "",
			};
		});

		// 5. Generate Excel
		const workbook = new ExcelJS.Workbook();
		const worksheet = workbook.addWorksheet("Bundles");

		worksheet.columns = [
			{ header: "ID", key: "id", width: 10 },
			{ header: "Name", key: "name", width: 30 },
			{ header: "SKU", key: "sku", width: 25 },
			{ header: "Price", key: "price", width: 15 },
			{ header: "Items Count", key: "itemsCount", width: 15 },
			{ header: "Description", key: "description", width: 40 },
			{ header: "Created At", key: "created_at", width: 18 },
		];

		// 🎨 Apply your specific Branding (Purple Header)
		worksheet.getRow(1).font = {
			bold: true,
			color: { argb: "FFFFFFFF" },
		};
		worksheet.getRow(1).fill = {
			type: "pattern",
			pattern: "solid",
			fgColor: { argb: "FF6C5CE7" },
		};

		exportData.forEach((row) => worksheet.addRow(row));

		return await workbook.xlsx.writeBuffer();
	}

	async update(me: any, id: number, dto: UpdateBundleDto) {
		const adminId = tenantId(me);

		const b = await this.bundleRepo.findOne({
			where: { id, adminId } as any,
			relations: ["items"],
		});
		if (!b) throw new BadRequestException("bundle not found");

		if (dto.name !== undefined) b.name = dto.name;
		if (dto.sku !== undefined) b.sku = dto.sku;
		if (dto.price !== undefined) b.price = dto.price;
		if (dto.description !== undefined) b.description = dto.description;

		if (dto.items !== undefined) {
			const items = Array.isArray(dto.items) ? dto.items : [];
			if (!items.length) throw new BadRequestException("items is required");

			for (const it of items) {
				if (!Number.isInteger(it?.variantId)) throw new BadRequestException("variantId must be int");
				if (!Number.isInteger(it?.qty) || it.qty <= 0) throw new BadRequestException("qty must be > 0");
			}

			const ids = items.map((x) => x.variantId);
			const variants = await this.pvRepo.find({
				where: { adminId, id: In(ids) } as any,
				select: ["id"],
			});
			const variantSet = new Set(variants.map((v) => v.id));

			for (const it of items) {
				if (!variantSet.has(it.variantId)) {
					throw new BadRequestException(`variantId not found: ${it.variantId}`);
				}
			}

			await this.itemRepo.delete({ adminId, bundleId: b.id } as any);

			b.items = items.map((it) => {
				const newItem = new BundleItemEntity();
				newItem.adminId = adminId;
				newItem.variantId = it.variantId;
				newItem.qty = it.qty;
				return newItem;
			});

		}

		await this.bundleRepo.save(b);
		return this.get(me, b.id);
	}


	async remove(me: any, id: number) {
		const adminId = tenantId(me);
		await this.get(me, id);
		await this.itemRepo.delete({ bundleId: id, adminId } as any);
		await this.bundleRepo.delete({ id, adminId } as any);

		return { ok: true };
	}


	// ✅ OPTIONAL helper: consume bundle stock (use it in invoices/orders)
	async consumeBundleStock(me: any, bundleSku: string, qty: number) {
		const adminId = tenantId(me);
		if (!Number.isInteger(qty) || qty <= 0) throw new BadRequestException("qty must be > 0");

		const bundle = await this.getBySku(me, bundleSku);
		const items = bundle.items ?? [];

		// check availability
		for (const it of items) {
			const v = await this.pvRepo.findOne({ where: { id: it.variantId, adminId } as any });
			if (!v) throw new BadRequestException(`variant not found: ${it.variantId}`);

			const need = it.qty * qty;
			const available = Math.max(0, (v.stockOnHand ?? 0) - (v.reserved ?? 0));
			if (available < need) {
				throw new BadRequestException(`Not enough stock for variantId=${it.variantId}`);
			}
		}

		// consume
		for (const it of items) {
			const v = await this.pvRepo.findOne({ where: { id: it.variantId, adminId } as any });
			const need = it.qty * qty;
			(v as any).stockOnHand = (v as any).stockOnHand - need;

			await this.pvRepo.save(v as any);
		}

		return { ok: true, bundleId: bundle.id };
	}
}
