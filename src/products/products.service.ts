// --- File: src/products/products.service.ts ---
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository, Like, Not, IsNull, EntityManager, Brackets } from "typeorm";

import { unlink } from 'fs/promises';
import { join } from 'path';
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
import { OrderItemEntity, OrderStatus } from "entities/order.entity";
import { deletePhysicalFiles } from "common/healpers";
import { NotificationService } from "src/notifications/notification.service";
import { NotificationType } from "entities/notifications.entity";
import { PurchaseReturnsService } from "src/purchases-return/purchases-return.service";
import { PurchasesService } from "src/purchases/purchases.service";
import { DataSource } from "typeorm";
import { OrphanFileEntity } from "entities/files.entity";
import { OrphanFilesService } from "src/orphan-files/orphan-files.service";

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
    private whRepo: Repository<WarehouseEntity>,

    @InjectRepository(OrderItemEntity)
    private orderItemRepo: Repository<OrderItemEntity>,

    @InjectRepository(OrphanFileEntity)
    private orphanRepo: Repository<OrphanFileEntity>,

    private readonly notificationService: NotificationService,
    private readonly purchasesService: PurchasesService,
    private readonly orphanFilesService: OrphanFilesService,
    private readonly dataSource: DataSource,
  ) { }



  public async handleImageCleanup(
    currentData: { images?: { url: string }[] },
    urlsToRemove: string[] | undefined
  ) {
    if (!urlsToRemove || urlsToRemove.length === 0) return;

    // 2. Physical Deletion from Disk
    deletePhysicalFiles(urlsToRemove);

    // 3. Return the filtered gallery images
    return (currentData.images ?? []).filter(
      (img) => img?.url && !urlsToRemove.includes(img.url)
    );
  }

  public canonicalKey(attrs: Record<string, string>): any {
    const key = Object.keys(attrs)
      .sort((a, b) => a.localeCompare(b))
      .map((k) => `${k}=${String(attrs[k])}`)
      .join("|");
    return key;
  }

  private generateSku(product: ProductEntity, attrs: Record<string, any>) {
    const rand = Math.random().toString(16).substring(2, 6).toUpperCase();

    const base = (product.name || "PRD")
      .toString()
      .replace(/\s+/g, "")
      .toUpperCase()
      .substring(0, 10);

    const attrPart = Object.values(attrs)
      .map(v => String(v).replace(/\s+/g, "").toUpperCase())
      .join("-");

    return `${base}-${attrPart}-${rand}`;
  }

  private async assertOwnedOrNull(
    repo: Repository<any>,
    adminId: string,
    id?: string | null,
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

    const byProduct = new Map<string, any[]>();
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

  private async attachSkusToProduct(me: any, product: any, manager?: EntityManager) {
    if (!product?.id) return product;

    const repo = manager ? manager.getRepository(ProductVariantEntity) : this.pvRepo;
    const rows = await repo.find({
      where: { adminId: me.adminId, productId: product.id } as any,
      order: { id: "ASC" },
    });

    product.skus = rows.map((r) => this.mapSkuRow(r));
    return product;
  }

  async getAdminSummary(me: any) {

    const adminId = tenantId(me);

    // Run all queries in parallel for better performance
    const [totalProducts, inventoryStats, orderStats] = await Promise.all([
      // 1. Total Products Count
      this.prodRepo.count({ where: { adminId } }),

      // 2. Inventory Stats (Reserved & Available)
      this.pvRepo
        .createQueryBuilder('pv')
        .select('SUM(pv.reserved)', 'totalReserved')
        .addSelect('SUM(pv.stockOnHand - pv.reserved)', 'totalAvailable')
        .where('pv.adminId = :adminId', { adminId })
        .getRawOne(),

      // 3. Order Item Stats using Enums
      this.orderItemRepo
        .createQueryBuilder('oi')
        .leftJoin('oi.order', 'order')
        .leftJoin('order.status', 'status')
        .select(
          `SUM(CASE WHEN status.code = :delivered THEN oi.quantity ELSE 0 END)`,
          'totalDelivered'
        )
        .addSelect(
          `SUM(CASE WHEN status.code = :shipped THEN oi.quantity ELSE 0 END)`,
          'totalShipped'
        )
        .where('oi.adminId = :adminId')
        .setParameters({
          adminId,
          delivered: OrderStatus.DELIVERED,
          shipped: OrderStatus.SHIPPED,
        })
        .getRawOne(),
    ]);

    return {
      productCount: Number(totalProducts),
      inventory: {
        reserved: Number(inventoryStats?.totalReserved || 0),
        available: Number(inventoryStats?.totalAvailable || 0),
      },
      orders: {
        soldQuantity: Number(orderStats?.totalDelivered || 0),
        inTransitQuantity: Number(orderStats?.totalShipped || 0),
      },
    };
  }

  async exportProducts(me: any, q?: any) {
    const adminId = tenantId(me);
    const filters: Record<string, any> = {};
    const type = q?.type ?? "PRODUCT";

    if (q?.categoryId && q?.categoryId != "none")
      filters.categoryId = q.categoryId;

    if (q?.storeId && q?.storeId != "none")
      filters.storeId = q.storeId;

    if (q?.warehouseId && q?.warehouseId != "none")
      filters.warehouseId = q.warehouseId;

    const rackSearch = q?.["storageRack.ilike"];
    if (rackSearch?.trim()) {
      filters.storageRack = { ilike: rackSearch };
    }
    if (q?.search) {
      filters.search = q.search?.trim();
    }

    if (q?.["wholesalePrice.gte"] || q?.["wholesalePrice.lte"]) {
      const gte = q["wholesalePrice.gte"];
      const lte = q["wholesalePrice.lte"];

      if (!Number.isNaN(Number(gte)))
        filters.wholesalePrice = { ...filters.wholesalePrice, gte: Number(gte) };

      if (!Number.isNaN(Number(lte)))
        filters.wholesalePrice = { ...filters.wholesalePrice, lte: Number(lte) };
    }

    if (q?.["salePrice.gte"] || q?.["salePrice.lte"]) {
      const gte = q["salePrice.gte"];
      const lte = q["salePrice.lte"];

      if (!Number.isNaN(Number(gte)))
        filters.salePrice = { ...filters.salePrice, gte: Number(gte) };

      if (!Number.isNaN(Number(lte)))
        filters.salePrice = { ...filters.salePrice, lte: Number(lte) };
    }

    let idleDate: Date | null = null;
    if (type === "PRODUCT_IDLE" && q?.["created_at.lte"]) {
      idleDate = new Date(q["created_at.lte"]);
    }

    // =====================================
    // 🔎 Build Query
    // =====================================
    const qb = this.prodRepo
      .createQueryBuilder("product")
      .leftJoinAndSelect("product.category", "category")
      .leftJoinAndSelect("product.store", "store")
      .leftJoinAndSelect("product.warehouse", "warehouse")
      .where("product.adminId = :adminId", { adminId });

    // Normal Filters
    if (filters.categoryId)
      qb.andWhere("product.categoryId = :categoryId", {
        categoryId: filters.categoryId,
      });

    if (filters.storeId)
      qb.andWhere("product.storeId = :storeId", {
        storeId: filters.storeId,
      });

    if (filters.warehouseId)
      qb.andWhere("product.warehouseId = :warehouseId", {
        warehouseId: filters.warehouseId,
      });

    if (filters.storageRack?.ilike)
      qb.andWhere("product.storageRack ILIKE :rack", {
        rack: `%${filters.storageRack.ilike}%`,
      });

    if (filters.wholesalePrice?.gte)
      qb.andWhere("product.wholesalePrice >= :gte", {
        gte: filters.wholesalePrice.gte,
      });

    if (filters.wholesalePrice?.lte)
      qb.andWhere("product.wholesalePrice <= :lte", {
        lte: filters.wholesalePrice.lte,
      });

    if (filters.salePrice?.gte)
      qb.andWhere("product.salePrice >= :gte", {
        gte: filters.salePrice.gte,
      });

    if (filters.salePrice?.lte)
      qb.andWhere("product.salePrice <= :lte", {
        lte: filters.salePrice.lte,
      });


    if (filters.search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("product.name ILIKE :s", { s: `%${filters.search}%` })
        }),
      );
    }


    // =====================================
    // 🟣 PRODUCT_IDLE LOGIC
    // =====================================
    if (type === "PRODUCT_IDLE" && idleDate) {
      qb.andWhere(
        `
      NOT EXISTS (
        SELECT 1
        FROM order_items oi
        INNER JOIN product_variants pv ON pv.id = oi."variantId"
        WHERE pv."productId" = product.id
        AND oi."created_at" > :idleDate
      )
      `,
        { idleDate }
      );
    }

    qb.orderBy(
      `product.${q?.sortBy ?? "created_at"}`,
      (q?.sortOrder ?? "DESC") as any
    );

    // ⚠️ No pagination for export
    const records = await qb.getMany();

    // =============================
    // 📊 Prepare Excel Data
    // =============================
    const exportData = records.map((p: any) => {
      const skus = p?.skus ?? [];

      const firstSku = skus?.[0]?.sku ?? "";
      const skuCount = skus.length;

      const totalStock = skus.reduce(
        (sum: number, s: any) => sum + (s.stockOnHand || 0),
        0
      );

      return {
        id: p.id,
        name: p.name ?? "",
        sku: firstSku,
        skuCount: skuCount > 1 ? `+${skuCount - 1}` : "",
        category: p.category?.name ?? "",
        store: p.store?.name ?? "",
        warehouse: p.warehouse?.name ?? "",
        storageRack: p.storageRack ?? "",
        wholesalePrice: p.wholesalePrice ?? "",
        salePrice: p.salePrice ?? "",
        lowestPrice: p.lowestPrice ?? "",
        totalStock: totalStock,
        created_at: p.created_at
          ? new Date(p.created_at).toLocaleDateString("en-US")
          : "",
      };
    });

    // =============================
    // 📦 Excel Generation
    // =============================
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Products");

    worksheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Name", key: "name", width: 30 },
      { header: "SKU", key: "sku", width: 20 },
      { header: "Extra SKUs", key: "skuCount", width: 12 },
      { header: "Category", key: "category", width: 20 },
      { header: "Store", key: "store", width: 20 },
      { header: "Warehouse", key: "warehouse", width: 20 },
      { header: "Storage Rack", key: "storageRack", width: 18 },
      { header: "Wholesale Price", key: "wholesalePrice", width: 16 },
      { header: "Sale Price", key: "salePrice", width: 16 },
      { header: "Lowest Price", key: "lowestPrice", width: 16 },
      { header: "Total Stock", key: "totalStock", width: 14 },
      { header: "Created At", key: "created_at", width: 18 },
    ];

    // 🎨 Header Styling (same style you use)
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
    const adminId = tenantId(me);
    const filters: Record<string, any> = {};
    const type = q?.type ?? "PRODUCT";

      
    if (q?.categoryId && q?.categoryId != "none")
      filters.categoryId = q.categoryId;

    if (q?.storeId && q?.storeId != "none")
      filters.storeId = q.storeId;

    if (q?.warehouseId && q?.warehouseId != "none")
      filters.warehouseId = q.warehouseId;

    const rackSearch = q?.["storageRack.ilike"];
    if (rackSearch?.trim()) {
      filters.storageRack = { ilike: rackSearch };
    }
    if (q?.search) {
      filters.search = q.search?.trim();
    }

    if (q?.["wholesalePrice.gte"] || q?.["wholesalePrice.lte"]) {
      const gte = q["wholesalePrice.gte"];
      const lte = q["wholesalePrice.lte"];

      if (!Number.isNaN(Number(gte))) {
        filters.wholesalePrice = { ...filters.wholesalePrice, gte: Number(gte) };
      }

      if (!Number.isNaN(Number(lte))) {
        filters.wholesalePrice = { ...filters.wholesalePrice, lte: Number(lte) };
      }
    }

    if (q?.["salePrice.gte"] || q?.["salePrice.lte"]) {
      const gte = q["salePrice.gte"];
      const lte = q["salePrice.lte"];

      if (!Number.isNaN(Number(gte)))
        filters.salePrice = { ...filters.salePrice, gte: Number(gte) };

      if (!Number.isNaN(Number(lte)))
        filters.salePrice = { ...filters.salePrice, lte: Number(lte) };
    }

    // =========================================
    // 🟣 PRODUCT_IDLE LOGIC
    // =========================================
    let idleDate: Date | null = null;

    if (type === "PRODUCT_IDLE" && q?.["created_at.lte"]) {
      idleDate = new Date(q["created_at.lte"]);
    }

   const qb = this.prodRepo
    .createQueryBuilder("product")
    .leftJoinAndSelect("product.category", "category")
    .leftJoinAndSelect("product.store", "store")
    .leftJoinAndSelect("product.warehouse", "warehouse")
    .where("product.adminId = :adminId", { adminId })
    .andWhere("product.isActive = :isActive", { isActive: true });

    // Apply normal filters manually (since we use QueryBuilder now)
    if (filters.categoryId)
      qb.andWhere("product.categoryId = :categoryId", { categoryId: filters.categoryId });

    if (filters.storeId)
      qb.andWhere("product.storeId = :storeId", { storeId: filters.storeId });

    if (filters.warehouseId)
      qb.andWhere("product.warehouseId = :warehouseId", { warehouseId: filters.warehouseId });

    if (filters.storageRack?.ilike)
      qb.andWhere("product.storageRack ILIKE :rack", { rack: `%${filters.storageRack.ilike}%` });

    if (filters.wholesalePrice?.gte)
      qb.andWhere("product.wholesalePrice >= :gte", { gte: filters.wholesalePrice.gte });

    if (filters.wholesalePrice?.lte)
      qb.andWhere("product.wholesalePrice <= :lte", { lte: filters.wholesalePrice.lte });

    if (filters.salePrice?.gte)
      qb.andWhere("product.salePrice >= :gte", { gte: filters.salePrice.gte });

    if (filters.salePrice?.lte)
      qb.andWhere("product.salePrice <= :lte", { lte: filters.salePrice.lte });

    if (filters.search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("product.name ILIKE :s", { s: `%${filters.search}%` })
        }),
      );
    }

    // =========================================
    // 🔥 Idle Products Filter
    // =========================================
    if (type === "PRODUCT_IDLE" && idleDate) {
      qb.andWhere(`
      NOT EXISTS (
        SELECT 1
        FROM order_items oi
        INNER JOIN product_variants pv ON pv.id = oi."variantId"
        WHERE pv."productId" = product.id
        AND oi."created_at" > :idleDate
      )
    `, { idleDate });
    }

    qb.orderBy(
      `product.${q?.sortBy ?? "created_at"}`,
      (q?.sortOrder ?? "DESC") as any
    );

    qb.skip(((q?.page ?? 1) - 1) * (q?.limit ?? 10));
    qb.take(q?.limit ?? 10);

    const [records, total] = await qb.getManyAndCount();

    const enriched = await this.attachSkusToProducts(me, records);

    return {
      records: enriched,
      total_records: total,
      current_page: q?.page ?? 1,
      per_page: q?.limit ?? 10,
    };
  }

  async get(me: any, id: string, manager?: EntityManager) {
    const repo = manager ? manager.getRepository(ProductEntity) : this.prodRepo;

    const p = await CRUD.findOne(repo, "products", id, [
      "category",
      "store",
      "warehouse",
    ]);

    return this.attachSkusToProduct(me, p as any, manager);
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

  async getSkus(me: any, productId: string) {
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

  async upsertSkus(
    me: any,
    productId: string,
    body: UpsertProductSkusDto,
    manager?: EntityManager
  ) {
    const adminId = tenantId(me);
    const product = await this.get(me, productId, manager);

    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) throw new BadRequestException("items is required");

    const pvRepo = manager
      ? manager.getRepository(ProductVariantEntity)
      : this.pvRepo;

    const existing = await pvRepo.find({
      where: { adminId, productId } as any,
    });

    const existingByKey = new Map(existing.map((e) => [e.key, e]));

    const toSave: ProductVariantEntity[] = [];
    const incomingKeys = new Set<string>();

    // Used to generate incremental number safely
    let count = existing.length;

    for (const it of items as any[]) {
      const attrs = it.attributes ?? {};
      if (!Object.keys(attrs).length) {
        throw new BadRequestException("Each item must have attributes");
      }

      const key = this.canonicalKey(attrs);

      incomingKeys.add(key);

      let row = existingByKey.get(key);

      if (row) {
        // 🔄 UPDATE EXISTING
        row.attributes = attrs;
        row.price =
          it.price !== undefined && it.price !== null
            ? Number(it.price)
            : null;

        if (it.stockOnHand !== undefined)
          row.stockOnHand = Number(it.stockOnHand) || 0;

        if (it.reserved !== undefined)
          row.reserved = Number(it.reserved) || 0;

        toSave.push(row);
      } else {
        // ➕ CREATE NEW
        count++;

        const sku = await this.generateSku(product, attrs);

        const created = pvRepo.create({
          adminId,
          productId,
          key,
          sku,
          price:
            it.price !== undefined && it.price !== null
              ? Number(it.price)
              : null,
          attributes: attrs,
          stockOnHand: 0,
          reserved: 0,
        });

        toSave.push(created);
      }
    }

    // ==========================
    // 🗑 DELETE REMOVED VARIANTS
    // ==========================
    // const toDelete = existing.filter((e) => !incomingKeys.has(e.key));

    // if (toDelete.length) {
    //   await pvRepo.remove(toDelete);
    // }

    // ==========================
    // 🔒 VALIDATIONS
    // ==========================
    for (const r of toSave) {
      if (r.stockOnHand < 0)
        throw new BadRequestException("stockOnHand cannot be negative");

      if (r.reserved < 0)
        throw new BadRequestException("reserved cannot be negative");

      if (r.reserved > r.stockOnHand)
        throw new BadRequestException(
          "reserved cannot exceed stockOnHand"
        );
    }

    await pvRepo.save(toSave);

    return {
      updated: toSave.length,
      // deleted: toDelete.length,
    };
  }

  async adjustVariantStock(me: any, productId: string, variantId: string, body: AdjustVariantStockDto) {
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


  async create(me: any, dto: CreateProductDto, manager?: EntityManager) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const work = async (mgr: EntityManager) => {
      const prodRepo = mgr.getRepository(ProductEntity);
      const catRepo = mgr.getRepository(CategoryEntity);
      const storeRepo = mgr.getRepository(StoreEntity);
      const whRepo = mgr.getRepository(WarehouseEntity);
      const pvRepo = mgr.getRepository(ProductVariantEntity);

      const category = await this.assertOwnedOrNull(catRepo, adminId, dto.categoryId ?? null, "category");
      const store = await this.assertOwnedOrNull(storeRepo, adminId, dto.storeId ?? null, "store");
      const warehouse = await this.assertOwnedOrNull(whRepo, adminId, dto.warehouseId ?? null, "warehouse");

      const existingSlug = await prodRepo.findOne({
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

      const p = prodRepo.create({
        adminId,
        name: dto.name,
        slug: dto.slug,
        wholesalePrice: dto.wholesalePrice ?? null,
        lowestPrice: dto.lowestPrice ?? null,
        salePrice: dto.salePrice ?? null,
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
        mainImage: dto.mainImage as any,
        images: dto.images ?? [],
        updatedByUserId: null,
      });

      const mainOrphanId = (dto as any).mainImageOrphanId;
      if (!p.mainImage) {
        if (!mainOrphanId) {
          throw new BadRequestException("mainImageOrphanId is required");
        }
        const mainRow = await mgr.getRepository(OrphanFileEntity).findOne({
          where: { adminId: String(adminId), id: mainOrphanId } as any,
          select: ["id", "url"],
        });
        if (!mainRow) throw new BadRequestException("mainImageOrphanId not found");
        p.mainImage = mainRow.url;
      }

      const imagesMeta = Array.isArray(dto.images) ? dto.images : [];
      const orphanIds = Array.isArray((dto as any).imagesOrphanIds) ? (dto as any).imagesOrphanIds : [];
      const orphanRows = await this.orphanFilesService.resolveOrphanUrlsOrThrow(mgr, String(adminId), orphanIds);
      const orphanImages = orphanRows.map((r) => ({ url: r.url }));

      const finalImages = [...imagesMeta, ...orphanImages];
      if (finalImages.length > 20) {
        throw new BadRequestException("Total images cannot exceed 20");
      }
      p.images = finalImages;

      const savedProduct = await prodRepo.save(p);

      // delete used orphans AFTER product save
      const toDelete = [
        Number.isFinite(mainOrphanId) && mainOrphanId > 0 ? mainOrphanId : null,
        ...orphanRows.map((r) => r.id),
      ].filter(Boolean) as number[];
      await this.orphanFilesService.deleteOrphansByIds(mgr, String(adminId), toDelete);

      const combos = Array.isArray((dto as any).combinations) ? (dto as any).combinations : [];
      let savedVariants: ProductVariantEntity[] = [];

      if (combos.length) {
        const rows: ProductVariantEntity[] = combos.map((c: any) => {
          const attrs = c.attributes ?? {};

          if (!Object.keys(attrs).length) {
            throw new BadRequestException("Each combination must have attributes");
          }

          const key = this.canonicalKey(attrs); // ✅ Always generated
          const sku = this.generateSku(savedProduct, attrs); // ✅ Always generated

          if (!key) throw new BadRequestException("Each combination must have key or attributes");

          const stockOnHand = 0;
          const reserved = 0;

          if (stockOnHand < 0) throw new BadRequestException("stockOnHand cannot be negative");
          if (reserved < 0) throw new BadRequestException("reserved cannot be negative");
          if (reserved > stockOnHand) throw new BadRequestException("reserved cannot exceed stockOnHand");

          return pvRepo.create({
            adminId,
            productId: savedProduct.id,
            key,
            sku: sku ?? null,
            price: c.price !== undefined && c.price !== null ? Number(c.price) : null,
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
          const exists = await pvRepo.find({
            where: { adminId, productId: savedProduct.id, key: In(keys) } as any,
            select: ["id", "key"],
          });

          if (exists.length) {
            throw new BadRequestException(`Duplicate combination key already exists: ${exists[0].key}`);
          }
        }

        savedVariants = await pvRepo.save(rows);
      }

      // Handle Purchase Data if provided
      if (dto.purchase) {
        // Map combinations to variant IDs for purchase items
        const purchaseItems = savedVariants.map(v => {
          // Find original combo to get purchaseCost and quantity
          const combo = combos.find(c => this.canonicalKey(c.attributes) === v.key);
          return {
            variantId: v.id,
            quantity: Number(combo?.stockOnHand) || 0,
            purchaseCost: Number(dto.wholesalePrice) || 0, // Fallback to product wholesale price
          };
        }).filter(it => it.quantity > 0);

        if (purchaseItems.length) {
          await this.purchasesService.create(me, {
            ...dto.purchase,
            items: purchaseItems
          }, undefined, mgr);
        }
      }

      await this.notificationService.create({
        userId: adminId,
        type: NotificationType.PRODUCT_CREATED,
        title: "New Product Created",
        message: `Product "${savedProduct.name}" has been created successfully.`,
        relatedEntityType: "product",
        relatedEntityId: String(savedProduct.id),
      }, mgr);

      return savedProduct.id;
    };

    const savedId = manager ? await work(manager) : await this.dataSource.transaction(mgr => work(mgr));
    return this.get(me, savedId);
  }

  async update(me: any, id: string, dto: UpdateProductDto) {
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
    }
    const removeUrls = dto.removeImgs as string[] | undefined;

    if (removeUrls?.length) {
      p.images = await this.handleImageCleanup(
        p,
        removeUrls,
      );
    }

    delete (dto as any).removeImgs;


    // images replacement (existing + library) from frontend
    const imagesCount = dto.imagesOrphanIds?.length + p.images.length;
    if (imagesCount > 20) throw new BadRequestException("Total images cannot exceed 20");

    const imagesMeta = (dto as any).imagesMeta;
    delete (dto as any).imagesMeta;

    // main image via orphan id
    const mainOrphanId = (dto as any).mainImageOrphanId;
    if (mainOrphanId !== undefined && mainOrphanId !== null && mainOrphanId !== "") {
      const oid = mainOrphanId;
      if (!oid) throw new BadRequestException("mainImageOrphanId is invalid");
      const row = await this.orphanRepo.findOne({
        where: { adminId: String(adminId), id: oid } as any,
        select: ["id", "url"],
      });
      if (!row) throw new BadRequestException("mainImageOrphanId not found");
      if ((p as any).mainImage) {
        deletePhysicalFiles([p.mainImage])
      }
      (p as any).mainImage = row.url;
      await this.orphanRepo.delete({ adminId: String(adminId), id: oid } as any);
    }
    delete (dto as any).mainImageOrphanId;

    // append gallery images via orphan ids
    const orphanIds = (dto as any).imagesOrphanIds;

    if (orphanIds !== undefined) {
      if (!Array.isArray(orphanIds)) throw new BadRequestException("imagesOrphanIds must be an array");
      const rows = await this.dataSource.transaction(async (mgr) => {
        const found = await this.orphanFilesService.resolveOrphanUrlsOrThrow(mgr, String(adminId), orphanIds);
        return found;
      });

      const current = Array.isArray((p as any).images) ? (p as any).images : [];
      const toAppend = rows.map((r) => ({ url: r.url }));

      if (current.length + toAppend.length > 20) {
        throw new BadRequestException("Total images cannot exceed 20");
      }

      (p as any).images = [...current, ...toAppend];

      await this.orphanRepo.delete({
        adminId: String(adminId),
        id: In(rows.map((r) => r.id)),
      } as any);
    }
    delete (dto as any).imagesOrphanIds;

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

  async remove(me: any, id: string) {
    const adminId = tenantId(me);
    return await this.dataSource.transaction(async (manager) => {
        await CRUD.toggleStatus(
            manager, 
            ProductEntity, 
            id, 
            adminId, 
            false, // Deactivate
            ['variants'] 
        );
    });
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
        storeId: storeId ? storeId : IsNull()
      },
      select: ["id"] // نختار الـ id فقط لتحسين الأداء
    });

    return { isUnique: !exists };
  }
}
