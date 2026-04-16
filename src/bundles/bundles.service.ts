// --- File: src/bundles/bundles.service.ts ---
import { BadRequestException, forwardRef, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Like, Repository } from "typeorm";
import { tenantId } from "../category/category.service";

import { BundleEntity, BundleItemEntity } from "entities/bundle.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import { CreateBundleDto, UpdateBundleDto } from "dto/bundle.dto";
import { CRUD } from "../../common/crud.service";
import * as ExcelJS from "exceljs";
import { StoresService } from "src/stores/stores.service";

@Injectable()
export class BundlesService {
	constructor(
		@InjectRepository(BundleEntity)
		private bundleRepo: Repository<BundleEntity>,

		@InjectRepository(BundleItemEntity)
		private itemRepo: Repository<BundleItemEntity>,

		@InjectRepository(ProductVariantEntity)
		private pvRepo: Repository<ProductVariantEntity>,

		@Inject(forwardRef(() => StoresService))
		private storesService: StoresService,

		private readonly dataSource: DataSource,
	) { }


	async list(me: any, q?: any) {
		const page = Number(q?.page) || 1;
		const limit = Number(q?.limit) || 10;
		const skip = (page - 1) * limit;
		const adminId = tenantId(me);

		const qb = this.bundleRepo.createQueryBuilder("bundle");

		// 1. Joins & Selective Loading
		// We use a condition in the join to filter out inactive bundle items
		qb.leftJoinAndSelect("bundle.variant", "variant")
			.leftJoinAndSelect("variant.product", "product")
			.leftJoinAndSelect("bundle.store", "store")
			.leftJoinAndSelect(
				"bundle.items",
				"items",
				"items.isActive = :itemActive",
				{ itemActive: true }
			)
			.leftJoinAndSelect("items.variant", "itemVariant");

		// 2. Base Filters (Tenant & Status)
		qb.where("bundle.adminId = :adminId", { adminId });
		qb.andWhere("bundle.isActive = :bundleActive", { bundleActive: true });

		// 3. Dynamic Filters
		if (q?.categoryId && q?.categoryId !== "none") {
			qb.andWhere("bundle.categoryId = :categoryId", { categoryId: q.categoryId });
		}

		if (q?.storeId && q?.storeId !== "none") {
			qb.andWhere("bundle.storeId = :storeId", { storeId: q.storeId });
		}

		// 4. Numeric Range Filter (Price)
		if (q?.["wholesalePrice.gte"]) {
			qb.andWhere("bundle.price >= :minPrice", { minPrice: Number(q["wholesalePrice.gte"]) });
		}
		if (q?.["wholesalePrice.lte"]) {
			qb.andWhere("bundle.price <= :maxPrice", { maxPrice: Number(q["wholesalePrice.lte"]) });
		}

		// 5. Search (Name or SKU)
		if (q?.search) {
			qb.andWhere(
				"(bundle.name ILIKE :search OR bundle.sku ILIKE :search)",
				{ search: `%${q.search}%` }
			);
		}

		// 6. Sorting
		const sortBy = q?.sortBy || "created_at";
		const sortOrder = (q?.sortOrder?.toUpperCase() === "ASC" ? "ASC" : "DESC");
		// Ensure we use the alias to avoid ambiguity
		qb.orderBy(`bundle.${sortBy}`, sortOrder);

		// 7. Pagination
		// Use 'take' and 'skip' instead of 'limit'/'offset' when working with relations
		qb.skip(skip).take(limit);

		// 8. Execute
		const [data, total] = await qb.getManyAndCount();

		return {
			records: data,
			total_records: total,
			current_page: page,
			per_page: limit
		};
	}


	async get(me: any, id: string) {
		const adminId = tenantId(me);
		const bundle = await this.bundleRepo.createQueryBuilder("bundle")
			.leftJoinAndSelect("bundle.variant", "variant")
			.leftJoinAndSelect("variant.product", "product")
			.leftJoinAndSelect("bundle.store", "store")
			.leftJoinAndSelect("bundle.items", "items", "items.isActive = :isActive", { isActive: true })
			.leftJoinAndSelect("items.variant", "itemVariant")
			.where("bundle.id = :id AND bundle.adminId = :adminId", { id, adminId })
			.getOne();

		if (!bundle) throw new BadRequestException("bundle not found");
		return bundle;
	}

	async getBySku(me: any, sku: string) {
		const adminId = tenantId(me);
		const bundle = await this.bundleRepo.createQueryBuilder("bundle")
			.leftJoinAndSelect("bundle.variant", "variant")
			.leftJoinAndSelect("variant.product", "product")
			.leftJoinAndSelect("bundle.store", "store")
			.leftJoinAndSelect("bundle.items", "items", "items.isActive = :isActive", { isActive: true })
			.leftJoinAndSelect("items.variant", "itemVariant")
			.where("bundle.sku = :sku AND bundle.adminId = :adminId", { sku, adminId })
			.getOne();

		if (!bundle) throw new BadRequestException("bundle SKU not found");
		return bundle;
	}

	async create(me: any, dto: CreateBundleDto) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const items = Array.isArray(dto.items) ? dto.items : [];
		if (!items.length) throw new BadRequestException("items is required");

		// ensure main variant is not in items
		if (items.some(it => it.variantId === dto.variantId)) {
			throw new BadRequestException("Main variant cannot be part of bundle items");
		}

		// ensure items are unique
		const itemIds = items.map(it => it.variantId);
		if (new Set(itemIds).size !== itemIds.length) {
			throw new BadRequestException("Bundle cannot contain duplicate items");
		}

		// Validate Store if storeId is provided
		if (dto.storeId) {
			const store = await this.storesService.getStoreById(me, dto.storeId);
			if (!store) throw new BadRequestException("Store not found");

			// Get provider from StoresService to check bundle support and max items
			const provider = this.storesService.getProvider(store.provider);
			if (!provider.supportBundle) {
				throw new BadRequestException(`Store "${store.name}" does not support bundles.`);
			}

			if (provider.maxBundleItems !== undefined && items.length > provider.maxBundleItems) {
				throw new BadRequestException(`Bundle exceeds maximum allowed items (${provider.maxBundleItems}) for store "${store.name}".`);
			}
		}

		for (const it of items) {
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
			variantId: dto.variantId,
			storeId: dto.storeId,
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
		const adminId = tenantId(me);
		const qb = this.bundleRepo.createQueryBuilder("bundle");

		// 1. Joins & Selective Loading (Filtering inactive bundle items)
		qb.leftJoinAndSelect("bundle.variant", "variant")
			.leftJoinAndSelect("variant.product", "product")
			.leftJoinAndSelect("bundle.store", "store")
			.leftJoinAndSelect(
				"bundle.items",
				"items",
				"items.isActive = :itemActive",
				{ itemActive: true }
			)
			.leftJoinAndSelect("items.variant", "itemVariant");

		// 2. Base Filters
		qb.where("bundle.adminId = :adminId", { adminId });
		qb.andWhere("bundle.isActive = :bundleActive", { bundleActive: true });

		// 3. Dynamic Filters (Category & Store)
		if (q?.categoryId && q?.categoryId !== "none") {
			qb.andWhere("bundle.categoryId = :categoryId", { categoryId: q.categoryId });
		}
		if (q?.storeId && q?.storeId !== "none") {
			qb.andWhere("bundle.storeId = :storeId", { storeId: q.storeId });
		}

		// 4. Price Range Filters
		if (q?.["wholesalePrice.gte"]) {
			qb.andWhere("bundle.price >= :minPrice", { minPrice: Number(q["wholesalePrice.gte"]) });
		}
		if (q?.["wholesalePrice.lte"]) {
			qb.andWhere("bundle.price <= :maxPrice", { maxPrice: Number(q["wholesalePrice.lte"]) });
		}

		// 5. Search Logic
		if (q?.search) {
			qb.andWhere(
				"(bundle.name ILIKE :search OR bundle.sku ILIKE :search)",
				{ search: `%${q.search}%` }
			);
		}

		// 6. Sorting
		const sortBy = q?.sortBy || "created_at";
		const sortOrder = (q?.sortOrder?.toUpperCase() === "ASC" ? "ASC" : "DESC");
		qb.orderBy(`bundle.${sortBy}`, sortOrder);

		// 7. Fetch all records (Exports usually ignore pagination limits)
		const bundles = await qb.getMany();

		// 8. Map Data for Excel
		const exportData = bundles.map((b) => ({
			id: b.id,
			name: b.name ?? "",
			sku: b.sku ?? "",
			price: b.price ?? 0,
			variantSku: b.variant?.sku ?? "",
			variantName: b.variant?.product?.name ?? "",
			storeName: b.store?.name ?? "",
			itemsCount: b.items?.length ?? 0, // Only active items are counted here now
			description: b.description ?? "",
			created_at: b.created_at
				? new Date(b.created_at).toLocaleDateString("en-US")
				: "",
		}));

		// 9. Generate Excel with Branding
		const workbook = new ExcelJS.Workbook();
		const worksheet = workbook.addWorksheet("Bundles");

		worksheet.columns = [
			{ header: "ID", key: "id", width: 10 },
			{ header: "Name", key: "name", width: 30 },
			{ header: "SKU", key: "sku", width: 25 },
			{ header: "Price", key: "price", width: 15 },
			{ header: "Main Variant SKU", key: "variantSku", width: 25 },
			{ header: "Main Variant Name", key: "variantName", width: 30 },
			{ header: "Store Name", key: "storeName", width: 25 },
			{ header: "Items Count", key: "itemsCount", width: 15 },
			{ header: "Description", key: "description", width: 40 },
			{ header: "Created At", key: "created_at", width: 18 },
		];

		// Apply Header Styling (Purple Theme)
		const headerRow = worksheet.getRow(1);
		headerRow.font = {
			bold: true,
			color: { argb: "FFFFFFFF" },
		};
		headerRow.fill = {
			type: "pattern",
			pattern: "solid",
			fgColor: { argb: "FF6C5CE7" }, // Your primary purple color
		};

		exportData.forEach((row) => worksheet.addRow(row));

		return await workbook.xlsx.writeBuffer();
	}

	async update(me: any, id: string, dto: UpdateBundleDto) {
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
		if (dto.variantId !== undefined) b.variantId = dto.variantId;

		const finalVariantId = dto.variantId !== undefined ? dto.variantId : b.variantId;
		const finalItems = dto.items !== undefined ? dto.items : b.items;

		// ensure main variant is not in items
		if (finalItems.some((it: any) => it.variantId === finalVariantId)) {
			throw new BadRequestException("Main variant cannot be part of bundle items");
		}

		// ensure items are unique
		if (dto.items !== undefined) {
			const itemIds = dto.items.map((it) => it.variantId);
			if (new Set(itemIds).size !== itemIds.length) {
				throw new BadRequestException("Bundle cannot contain duplicate items");
			}
		}

		// Validate Store if storeId is provided/changed
		if (dto.storeId !== undefined) {
			if (dto.storeId === null) {
				b.storeId = null;
			} else {
				const store = await this.storesService.getStoreById(me, dto.storeId);
				if (!store) throw new BadRequestException("Store not found");

				const provider = this.storesService.getProvider(store.provider);
				if (!provider.supportBundle) {
					throw new BadRequestException(`Store "${store.name}" does not support bundles.`);
				}

				// Check items count for the store
				const itemsToValidate = dto.items !== undefined ? dto.items : b.items;
				if (provider.maxBundleItems !== undefined && itemsToValidate.length > provider.maxBundleItems) {
					throw new BadRequestException(`Bundle exceeds maximum allowed items (${provider.maxBundleItems}) for store "${store.name}".`);
				}
				b.storeId = dto.storeId;
			}
		} else if (dto.items !== undefined && b.storeId) {
			// storeId didn't change but items did, re-validate max items
			const store = await this.storesService.getStoreById(me, b.storeId);
			const provider = this.storesService.getProvider(store.provider);
			if (provider.maxBundleItems !== undefined && dto.items.length > provider.maxBundleItems) {
				throw new BadRequestException(`Bundle exceeds maximum allowed items (${provider.maxBundleItems}) for store "${store.name}".`);
			}
		}

		if (dto.items !== undefined) {
			const items = Array.isArray(dto.items) ? dto.items : [];
			if (!items.length) throw new BadRequestException("items is required");

			for (const it of items) {
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

			// Instead of delete, we deactivate old ones and reactivate/update existing ones
			const existingItems = await this.itemRepo.find({
				where: { adminId, bundleId: b.id } as any,
			});

			const updatedItems: BundleItemEntity[] = [];
			const dtoItemsMap = new Map(items.map((it) => [it.variantId, it.qty]));

			// 1. Update or Reactivate
			for (const [vId, qty] of dtoItemsMap) {
				let item = existingItems.find((ei) => ei.variantId === vId);
				if (item) {
					item.qty = qty;
					item.isActive = true;
					item.deactivatedAt = null;
				} else {
					item = new BundleItemEntity();
					item.adminId = adminId;
					item.bundleId = b.id;
					item.variantId = vId;
					item.qty = qty;
					item.isActive = true;
					item.deactivatedAt = null;
				}
				updatedItems.push(item);
			}

			// 2. Deactivate those not in DTO
			for (const ei of existingItems) {
				if (!dtoItemsMap.has(ei.variantId)) {
					ei.isActive = false;
					ei.deactivatedAt = new Date();
					updatedItems.push(ei);
				}
			}

			b.items = updatedItems;

		}

		await this.bundleRepo.save(b);
		return this.get(me, b.id);
	}


	async remove(me: any, id: string) {
		const adminId = tenantId(me);
		return await this.dataSource.transaction(async (manager) => {
			await CRUD.toggleStatus(
				manager,
				BundleEntity,
				id,
				adminId,
				false, // Deactivate
				['items']
			);
		});
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
