// --- File: src/products/products.service.ts ---
import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository, Like, Not, IsNull } from "typeorm";

import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";
import { CategoryEntity } from "entities/categories.entity";
import { StoreEntity } from "entities/stores.entity";
import { WarehouseEntity } from "entities/warehouses.entity";

import {
  CreateProductDto,
  UpdateProductDto,
  UpsertProductSkusDto,
  AdjustVariantStockDto,
} from "dto/product.dto";

import { CRUD } from "../../common/crud.service";
import { tenantId } from "../category/category.service";
import * as ExcelJS from "exceljs";

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(ProductEntity)
    private prodRepo: Repository<ProductEntity>,

    @InjectRepository(ProductVariantEntity)
    private pvRepo: Repository<ProductVariantEntity>,

    @InjectRepository(CategoryEntity)
    private catRepo: Repository<CategoryEntity>,

    @InjectRepository(StoreEntity)
    private storeRepo: Repository<StoreEntity>,

    @InjectRepository(WarehouseEntity)
    private whRepo: Repository<WarehouseEntity>
  ) { }

  public canonicalKey(attrs: Record<string, string>) {
    return Object.keys(attrs)
      .sort((a, b) => a.localeCompare(b))
      .map((k) => `${k}=${String(attrs[k])}`)
      .join("|");
  }

  private async assertOwnedOrNull(
    repo: Repository<any>,
    adminId: string,
    id?: number | null,
    label = "entity"
  ) {
    if (id == null) return null;
    const e = await repo.findOne({ where: { id } as any });
    if (!e) throw new BadRequestException(`${label} not found`);
    return e;
  }

  private mapSkuRow(r: ProductVariantEntity) {
    return {
      id: r.id,
      key: r.key,
      sku: r.sku,
      price: (r as any).price ?? null, // ✅ NEW
      attributes: r.attributes,
      stockOnHand: r.stockOnHand,
      reserved: r.reserved,
      available: Math.max(0, (r.stockOnHand ?? 0) - (r.reserved ?? 0)),
    };
  }

  private async attachSkusToProducts(me: any, products: any[]) {
    const productIds = (products ?? []).map((p) => p.id).filter(Boolean);
    if (!productIds.length) return products;

    const rows = await this.pvRepo.find({
      where: { adminId: me.adminId, productId: In(productIds) } as any,
      order: { id: "ASC" },
    });

    const byProduct = new Map<number, any[]>();
    for (const r of rows) {
      const arr = byProduct.get(r.productId) ?? [];
      arr.push(this.mapSkuRow(r));
      byProduct.set(r.productId, arr);
    }

    for (const p of products) {
      p.skus = byProduct.get(p.id) ?? [];
    }

    return products;
  }

  private async attachSkusToProduct(me: any, product: any) {
    if (!product?.id) return product;

    const rows = await this.pvRepo.find({
      where: { adminId: me.adminId, productId: product.id } as any,
      order: { id: "ASC" },
    });

    product.skus = rows.map((r) => this.mapSkuRow(r));
    return product;
  }

  async export(me: any, q: any, res: any) {
    const result = await CRUD.findAll(
      this.prodRepo,
      "products",
      q?.search,
      1,
      q?.limit ?? 1000000,
      q?.sortBy ?? "created_at",
      (q?.sortOrder ?? "DESC") as any,
      ["category", "store", "warehouse"],
      ["name", "category.name", "store.name", "warehouse.name"],
      {
        ...q,
        __tenant: { role: me?.role?.name, userId: me?.id, adminId: me?.adminId },
      } as any
    );

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Products");

    ws.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Name", key: "name", width: 30 },
      { header: "Wholesale Price", key: "wholesalePrice", width: 16 },
      { header: "Lowest Price", key: "lowestPrice", width: 16 },
      { header: "Storage Rack", key: "storageRack", width: 18 },
      { header: "Category", key: "category", width: 20 },
      { header: "Store", key: "store", width: 20 },
      { header: "Warehouse", key: "warehouse", width: 20 },
      { header: "Upselling Enabled", key: "upsellingEnabled", width: 18 },
      { header: "Created At", key: "created_at", width: 24 },
    ];

    (result.records ?? []).forEach((p: any) => {
      ws.addRow({
        id: p.id,
        name: p.name,
        wholesalePrice: p.wholesalePrice ?? "",
        lowestPrice: p.lowestPrice ?? "",
        storageRack: p.storageRack ?? "",
        category: p.category?.name ?? "",
        store: p.store?.name ?? "",
        warehouse: p.warehouse?.name ?? "",
        upsellingEnabled: p.upsellingEnabled ? "Yes" : "No",
        created_at: p.created_at ? new Date(p.created_at).toISOString() : "",
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="products.xlsx"`);

    await wb.xlsx.write(res);
    res.end();
  }

  async searchWithSkus(me: any, q?: any) {
    const adminId = tenantId(me);
    const searchTerm = q?.search || "";

    if (!searchTerm || searchTerm.length < 2) {
      return {
        total_records: 0,
        current_page: 1,
        per_page: 10,
        records: [],
      };
    }

    const productsByName = await this.prodRepo.find({
      where: { adminId, name: Like(`%${searchTerm}%`) } as any,
      take: 20,
      relations: ["category", "store", "warehouse"],
    });

    const skusByCode = await this.pvRepo.find({
      where: { adminId, sku: Like(`%${searchTerm}%`) } as any,
      take: 20,
    });

    const productIdsFromSkus = [...new Set(skusByCode.map((s) => s.productId))];

    const productsBySku =
      productIdsFromSkus.length > 0
        ? await this.prodRepo.find({
          where: { adminId, id: In(productIdsFromSkus) } as any,
          relations: ["category", "store", "warehouse"],
        })
        : [];

    const productMap = new Map();
    [...productsByName, ...productsBySku].forEach((p) => {
      if (!productMap.has(p.id)) productMap.set(p.id, p);
    });

    const products = Array.from(productMap.values());
    const productsWithSkus = await this.attachSkusToProducts(me, products);

    return {
      total_records: productsWithSkus.length,
      current_page: 1,
      per_page: 20,
      records: productsWithSkus,
    };
  }

  async list(me: any, q?: any) {
    const filters: Record<string, any> = {};

    if (q?.categoryId && q?.categoryId != "none") filters.categoryId = q.categoryId;
    if (q?.storeId && q?.storeId != "none") filters.storeId = q.storeId;
    if (q?.warehouseId && q?.warehouseId != "none") filters.warehouseId = q.warehouseId;

    if (q?.["wholesalePrice.gte"] || q?.["wholesalePrice.lte"]) {
      const gte = q["wholesalePrice.gte"];
      const lte = q["wholesalePrice.lte"];

      if (gte !== undefined && gte !== "" && !Number.isNaN(Number(gte))) {
        filters.wholesalePrice = filters.wholesalePrice ?? {};
        filters.wholesalePrice.gte = Number(gte);
      }

      if (lte !== undefined && lte !== "" && !Number.isNaN(Number(lte))) {
        filters.wholesalePrice = filters.wholesalePrice ?? {};
        filters.wholesalePrice.lte = Number(lte);
      }

      if (filters.wholesalePrice && Object.keys(filters.wholesalePrice).length === 0) {
        delete filters.wholesalePrice;
      }
    }

    const result = await CRUD.findAll(
      this.prodRepo,
      "products",
      q?.search,
      q?.page ?? 1,
      q?.limit ?? 10,
      q?.sortBy ?? "created_at",
      (q?.sortOrder ?? "DESC") as any,
      ["category", "store", "warehouse"],
      ["name", "category.name", "store.name", "warehouse.name"],
      {
        __tenant: {
          role: me?.role?.name,
          userId: me?.id,
          adminId: me?.adminId,
        },
        filters,
      } as any
    );

    result.records = await this.attachSkusToProducts(me, result.records ?? []);
    return result;
  }

  async get(me: any, id: number) {
    const p = await CRUD.findOne(this.prodRepo, "products", id, [
      "category",
      "store",
      "warehouse",
    ]);

    return this.attachSkusToProduct(me, p as any);
  }

  async getBySku(me: any, sku: string) {
    const adminId = tenantId(me);

    const row = await this.pvRepo.findOne({
      where: { adminId, sku } as any,
    });
    if (!row) throw new BadRequestException("SKU not found");

    const product = await this.get(me, row.productId);

    return {
      product,
      matchedCombination: this.mapSkuRow(row),
    };
  }

  async getSkus(me: any, productId: number) {
    await this.get(me, productId);

    const rows = await this.pvRepo.find({
      where: { adminId: me.adminId, productId } as any,
      order: { id: "ASC" },
    });

    return {
      productId,
      items: rows.map((r) => this.mapSkuRow(r)),
    };
  }

  async upsertSkus(me: any, productId: number, body: UpsertProductSkusDto) {
    const adminId = tenantId(me);
    await this.get(me, productId);

    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) throw new BadRequestException("items is required");

    {
      const seen = new Set<string>();
      for (const it of items) {
        const key = it?.key;
        if (!key) continue;
        if (seen.has(key)) throw new BadRequestException(`Duplicate combination key in request: ${key}`);
        seen.add(key);
      }
    }

    const existing = await this.pvRepo.find({ where: { adminId, productId } as any });
    const byKey = new Map(existing.map((e) => [e.key, e]));

    const toSave: ProductVariantEntity[] = [];

    for (const it of items as any[]) {
      const key = it.key;
      if (!key) throw new BadRequestException("item.key required");

      const row = byKey.get(key);
      if (row) {
        if (it.sku !== undefined) row.sku = it.sku;
        if (it.price !== undefined) (row as any).price = it.price; // ✅ NEW
        if (it.stockOnHand !== undefined) row.stockOnHand = Number(it.stockOnHand) || 0;
        if (it.reserved !== undefined) row.reserved = Number(it.reserved) || 0;
        if (it.attributes !== undefined) row.attributes = it.attributes;
        toSave.push(row);
      } else {
        const created = this.pvRepo.create({
          adminId,
          productId,
          key,
          sku: it.sku ?? null,
          price: it.price !== undefined && it.price !== null ? Number(it.price) : null, // ✅ NEW
          attributes: it.attributes ?? {},
          stockOnHand: Number(it.stockOnHand) || 0,
          reserved: Number(it.reserved) || 0,
        } as any);
        toSave.push(created as any);
      }
    }

    for (const r of toSave) {
      if (r.stockOnHand < 0) throw new BadRequestException("stockOnHand cannot be negative");
      if (r.reserved < 0) throw new BadRequestException("reserved cannot be negative");
      if (r.reserved > r.stockOnHand) throw new BadRequestException("reserved cannot exceed stockOnHand");
    }

    const saved = await this.pvRepo.save(toSave);
    return { updated: saved.length };
  }

  async adjustVariantStock(me: any, productId: number, variantId: number, body: AdjustVariantStockDto) {
    const adminId = tenantId(me);
    await this.get(me, productId);

    const delta = Number(body?.delta);
    if (!Number.isFinite(delta)) throw new BadRequestException("delta must be a number");

    const row = await this.pvRepo.findOne({
      where: { id: variantId, adminId, productId } as any,
    });
    if (!row) throw new BadRequestException("variant sku row not found");

    const next = row.stockOnHand + delta;
    if (next < 0) throw new BadRequestException("stock cannot go below zero");

    row.stockOnHand = next;
    await this.pvRepo.save(row);

    return {
      ...this.mapSkuRow(row),
      productId,
    };
  }

  async create(me: any, dto: CreateProductDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const category = await this.assertOwnedOrNull(this.catRepo, adminId, dto.categoryId ?? null, "category");
    const store = await this.assertOwnedOrNull(this.storeRepo, adminId, dto.storeId ?? null, "store");
    const warehouse = await this.assertOwnedOrNull(this.whRepo, adminId, dto.warehouseId ?? null, "warehouse");
    const existingSlug = await this.prodRepo.findOne({
      where: {
        adminId,
        slug: dto.slug.trim(),
        storeId: dto.storeId ?? null
      }
    });

    if (existingSlug) {
      if (store?.name) {
        throw new BadRequestException(
          `This slug "${dto.slug}" is already in use for store "${store.name}".`
        );
      } else {
        throw new BadRequestException(
          `This slug "${dto.slug}" is already in use.`
        );
      }
    }
    const p = this.prodRepo.create({
      adminId,
      name: dto.name,
      slug: dto.slug,
      wholesalePrice: dto.wholesalePrice ?? null,
      lowestPrice: dto.lowestPrice ?? null,
      storageRack: dto.storageRack ?? null,

      categoryId: dto.categoryId ?? null,
      category: category ?? null,
      storeId: dto.storeId ?? null,
      store: store ?? null,
      warehouseId: dto.warehouseId ?? null,
      warehouse: warehouse ?? null,

      description: dto.description ?? null,
      callCenterProductDescription: dto.callCenterProductDescription ?? null,

      upsellingEnabled: dto.upsellingEnabled ?? false,
      upsellingProducts: (dto.upsellingProducts as any) ?? [],

      createdByUserId: me?.id ?? null,
      mainImage: dto.mainImage,
      images: dto.images ?? [],
      updatedByUserId: null,
    });

    const savedProduct = await this.prodRepo.save(p);

    const combos = Array.isArray((dto as any).combinations) ? (dto as any).combinations : [];
    if (combos.length) {
      const rows: ProductVariantEntity[] = combos.map((c: any) => {
        const attrs = c.attributes ?? {};
        const key = c.key || (Object.keys(attrs).length ? this.canonicalKey(attrs) : null);

        if (!key) throw new BadRequestException("Each combination must have key or attributes");

        const stockOnHand = Number(c.stockOnHand) || 0;
        const reserved = Number(c.reserved) || 0;

        if (stockOnHand < 0) throw new BadRequestException("stockOnHand cannot be negative");
        if (reserved < 0) throw new BadRequestException("reserved cannot be negative");
        if (reserved > stockOnHand) throw new BadRequestException("reserved cannot exceed stockOnHand");

        return this.pvRepo.create({
          adminId,
          productId: savedProduct.id,
          key,
          sku: c.sku ?? null,
          price: c.price !== undefined && c.price !== null ? Number(c.price) : null, // ✅ NEW
          attributes: attrs,
          stockOnHand,
          reserved,
        } as any);
      });

      {
        const seen = new Set<string>();
        for (const r of rows) {
          const k = `${adminId}::${savedProduct.id}::${r.key}`;
          if (seen.has(k)) throw new BadRequestException(`Duplicate combination key: ${r.key}`);
          seen.add(k);
        }
      }

      {
        const keys = rows.map((r) => r.key);
        const exists = await this.pvRepo.find({
          where: { adminId, productId: savedProduct.id, key: In(keys) } as any,
          select: ["id", "key"],
        });

        if (exists.length) {
          throw new BadRequestException(`Duplicate combination key already exists: ${exists[0].key}`);
        }
      }

      await this.pvRepo.save(rows);
    }

    return this.get(me, savedProduct.id);
  }

  async update(me: any, id: number, dto: UpdateProductDto) {
    const adminId = tenantId(me);
    const p = await CRUD.findOne(this.prodRepo, "products", id, ["category", "store", "warehouse"]);
    if (!p) throw new BadRequestException("product not found");

    if (dto.slug) {
      const cleanSlug = dto.slug;

      // التحقق من أن الـ Slug غير مستخدم من قبل منتج آخر
      // (نبحث عن نفس الـ Slug ونستبعد المنتج الحالي باستخدام Not(id))
      const existingSlug = await this.prodRepo.findOne({
        where: {
          adminId,
          slug: cleanSlug,
          storeId: dto.storeId !== undefined ? (dto.storeId ?? null) : p.storeId,
          id: Not(id) // أهم خطوة: استثناء المنتج الحالي من البحث
        }
      });

      if (existingSlug) {
        throw new BadRequestException(`The slug "${cleanSlug}" is already in use by another product.`);
      }

      p.slug = cleanSlug;
    }

    // ✅ removeImgs
    const removeImgs = (dto as any).removeImgs as string[] | undefined;
    if (removeImgs?.length) {
      (p as any).images = ((p as any).images ?? []).filter(
        (img: any) => img?.url && !removeImgs.includes(img.url)
      );

      const mainWillBeRemoved = removeImgs.includes((p as any).mainImage);
      const newMainProvided = Boolean((dto as any).mainImage);

      if (mainWillBeRemoved && !newMainProvided) {
        throw new BadRequestException("Cannot remove mainImage without providing a new mainImage");
      }
    }
    delete (dto as any).removeImgs;

    if ((dto as any).mainImage) {
      (p as any).mainImage = (dto as any).mainImage;
    }

    const append = (dto as any)._appendImages as any[] | undefined;
    if (append?.length) {
      (p as any).images = [...((p as any).images ?? []), ...append];
    }
    delete (dto as any)._appendImages;

    if (dto.categoryId !== undefined) {
      const category = await this.assertOwnedOrNull(this.catRepo, adminId, dto.categoryId ?? null, "category");
      (p as any).categoryId = dto.categoryId ?? null;
      (p as any).category = category ?? null;
    }

    if (dto.storeId !== undefined) {
      const store = await this.assertOwnedOrNull(this.storeRepo, adminId, dto.storeId ?? null, "store");
      (p as any).storeId = dto.storeId ?? null;
      (p as any).store = store ?? null;
    }

    if (dto.warehouseId !== undefined) {
      const warehouse = await this.assertOwnedOrNull(this.whRepo, adminId, dto.warehouseId ?? null, "warehouse");
      (p as any).warehouseId = dto.warehouseId ?? null;
      (p as any).warehouse = warehouse ?? null;
    }



    const patch: any = { ...dto };
    delete patch.categoryId;
    delete patch.storeId;
    delete patch.warehouseId;

    Object.assign(p as any, patch, { updatedByUserId: me?.id ?? null });

    const saved = await this.prodRepo.save(p as any);
    return this.get(me, saved.id);
  }

  async remove(me: any, id: number) {
    await this.get(me, id);
    return CRUD.delete(this.prodRepo, "products", id);
  }

  async checkSlug(me: any, slug, storeId, productId) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    if (productId) {
      const entity = await CRUD.findOne(this.prodRepo, "products", productId);
      if (slug === entity.slug) return {
        isUnique: true
      }
    }

    const exists = await this.prodRepo.findOne({
      where: {
        adminId,
        slug: slug.trim().toLowerCase(),
        storeId: storeId ? Number(storeId) : IsNull()
      },
      select: ["id"] // نختار الـ id فقط لتحسين الأداء
    });

    return { isUnique: !exists };
  }
}
