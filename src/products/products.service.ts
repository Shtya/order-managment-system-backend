// --- File: src/products/products.service.ts ---
import { BadRequestException, forwardRef, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository, Like, Not, IsNull, EntityManager, Brackets } from "typeorm";

import { unlink } from 'fs/promises';
import { join } from 'path';
import { ProductEntity, ProductType, ProductVariantEntity } from "entities/sku.entity";
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
import { PurchaseInvoiceItemEntity } from "entities/purchase.entity";
import { PurchaseReturnInvoiceItemEntity } from "entities/purchase_return.entity";
import { ApprovalStatus } from "common/enums";
import { deletePhysicalFiles, generateSlug, getErrorMessage } from "common/healpers";
import { NotificationService } from "src/notifications/notification.service";
import { NotificationType } from "entities/notifications.entity";
import { PurchaseReturnsService } from "src/purchases-return/purchases-return.service";
import { PurchasesService } from "src/purchases/purchases.service";
import { DataSource } from "typeorm";
import { OrphanFileEntity } from "entities/files.entity";
import { OrphanFilesService } from "src/orphan-files/orphan-files.service";
import { ProductSyncStateService } from "src/product-sync-state/product-sync-state.service";
import { ProductSyncStateEntity, ProductSyncStatus } from "entities/product_sync_error.entity";
import { RemoteImageHelper } from "common/emote-image.helper";
import { StoresService } from "src/stores/stores.service";


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

    @InjectRepository(PurchaseInvoiceItemEntity)
    private purchaseItemRepo: Repository<PurchaseInvoiceItemEntity>,

    @InjectRepository(PurchaseReturnInvoiceItemEntity)
    private purchaseReturnItemRepo: Repository<PurchaseReturnInvoiceItemEntity>,

    @InjectRepository(OrphanFileEntity)
    private orphanRepo: Repository<OrphanFileEntity>,

    private readonly productSyncStateService: ProductSyncStateService,
    private readonly remoteImageHelper: RemoteImageHelper,

    private readonly notificationService: NotificationService,
    private readonly purchasesService: PurchasesService,
    private readonly orphanFilesService: OrphanFilesService,
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => StoresService))
    private storesService: StoresService,
    @InjectRepository(ProductSyncStateEntity) protected readonly productSyncStateRepo: Repository<ProductSyncStateEntity>,
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

  public slugifyKey(s) {
    return (s || '')
      .toString()
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      // .replace(/[^\w]/g, '')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
  }


  private generateSku(product: ProductEntity, attrs: Record<string, any>) {
    const parts = (product.slug || "product").split("-");

    const base = parts.slice(0, 2).join("-").toUpperCase();

    const attrPart = Object.values(attrs)
      .map(v => String(v).replace(/\s+/g, "").toUpperCase())
      .join("-");

    return `${base}-${attrPart}`;
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
      unitCost: (r as any).unitCost ?? null, // ✅ NEW
      attributes: r.attributes,
      stockOnHand: r.stockOnHand,
      reserved: r.reserved,
      isActive: r.isActive,
      deactivatedAt: r.deactivatedAt,
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

  private buildEmptyProductStockSummary() {
    return {
      productCount: 1,
      inventory: { reserved: 0, available: 0, totalOnHand: 0 },
      orders: { soldQuantity: 0, inTransitQuantity: 0 },
      purchases: { acceptedQuantity: 0 },
      purchaseReturns: { acceptedReturnedQuantity: 0 },
    };
  }

  private async getStockSummariesForProductIds(adminId: string, productIds: string[]): Promise<Map<string, any>> {
    const map = new Map<string, any>();
    for (const id of productIds) {
      map.set(id, this.buildEmptyProductStockSummary());
    }

    const [invRows, ordRows, purRows, retRows] = await Promise.all([
      this.pvRepo
        .createQueryBuilder('pv')
        .select('pv.productId', 'productId')
        .addSelect('COALESCE(SUM(pv.reserved), 0)', 'reserved')
        .addSelect('COALESCE(SUM(pv.stockOnHand - pv.reserved), 0)', 'available')
        .addSelect('COALESCE(SUM(pv.stockOnHand), 0)', 'totalOnHand')
        .where('pv.adminId = :adminId', { adminId })
        .andWhere('pv.productId IN (:...ids)', { ids: productIds })
        .groupBy('pv.productId')
        .getRawMany(),
      this.orderItemRepo
        .createQueryBuilder('oi')
        .innerJoin('oi.order', 'order')
        .innerJoin('order.status', 'status')
        .innerJoin('oi.variant', 'pv')
        .select('pv.productId', 'productId')
        .addSelect(`SUM(CASE WHEN status.code = :delivered THEN oi.quantity ELSE 0 END)`, 'sold')
        .addSelect(`SUM(CASE WHEN status.code = :shipped THEN oi.quantity ELSE 0 END)`, 'inTransit')
        .where('oi.adminId = :adminId', { adminId })
        .andWhere('pv.productId IN (:...ids)', { ids: productIds })
        .groupBy('pv.productId')
        .setParameters({ delivered: OrderStatus.DELIVERED, shipped: OrderStatus.SHIPPED })
        .getRawMany(),
      this.purchaseItemRepo
        .createQueryBuilder('pii')
        .innerJoin('pii.invoice', 'pi')
        .innerJoin('pii.variant', 'pv')
        .select('pv.productId', 'productId')
        .addSelect('COALESCE(SUM(pii.quantity), 0)', 'qty')
        .where('pii.adminId = :adminId', { adminId })
        .andWhere('pi.adminId = :adminId', { adminId })
        .andWhere('pi.status = :accepted', { accepted: ApprovalStatus.ACCEPTED })
        .andWhere('pv.productId IN (:...ids)', { ids: productIds })
        .groupBy('pv.productId')
        .getRawMany(),
      this.purchaseReturnItemRepo
        .createQueryBuilder('prii')
        .innerJoin('prii.invoice', 'pri')
        .innerJoin('prii.variant', 'pv')
        .select('pv.productId', 'productId')
        .addSelect('COALESCE(SUM(prii.returnedQuantity), 0)', 'qty')
        .where('prii.adminId = :adminId', { adminId })
        .andWhere('pri.adminId = :adminId', { adminId })
        .andWhere('pri.status = :accepted', { accepted: ApprovalStatus.ACCEPTED })
        .andWhere('pv.productId IN (:...ids)', { ids: productIds })
        .groupBy('pv.productId')
        .getRawMany(),
    ]);

    const pidOf = (row: any) => row.productId ?? row.productid;
    for (const row of invRows) {
      const pid = pidOf(row);
      const s = map.get(pid);
      if (!s) continue;
      s.inventory.reserved = Number(row.reserved || 0);
      s.inventory.available = Number(row.available || 0);
      s.inventory.totalOnHand = Number(row.totalOnHand || 0);
    }
    for (const row of ordRows) {
      const pid = pidOf(row);
      const s = map.get(pid);
      if (!s) continue;
      s.orders.soldQuantity = Number(row.sold || 0);
      s.orders.inTransitQuantity = Number(row.inTransit || 0);
    }
    for (const row of purRows) {
      const pid = pidOf(row);
      const s = map.get(pid);
      if (!s) continue;
      s.purchases.acceptedQuantity = Number(row.qty || 0);
    }
    for (const row of retRows) {
      const pid = pidOf(row);
      const s = map.get(pid);
      if (!s) continue;
      s.purchaseReturns.acceptedReturnedQuantity = Number(row.qty || 0);
    }

    return map;
  }

  private async attachStockSummariesToProducts(me: any, products: any[]) {
    const adminId = tenantId(me);
    const ids = (products ?? []).map((p) => p.id).filter(Boolean);
    if (!adminId || !ids.length) return products;
    const summaries = await this.getStockSummariesForProductIds(adminId, ids);
    for (const p of products) {
      p.stockSummary = summaries.get(p.id) ?? this.buildEmptyProductStockSummary();
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
    const [
      totalProducts,
      inventoryStats,
      orderStats,
      acceptedPurchaseStats,
      acceptedReturnStats,
    ] = await Promise.all([
      // 1. Total Products Count
      this.prodRepo.count({ where: { adminId } }),

      // 2. Inventory Stats (Reserved & Available)
      this.pvRepo
        .createQueryBuilder('pv')
        .select('SUM(pv.reserved)', 'totalReserved')
        .addSelect('SUM(pv.stockOnHand - pv.reserved)', 'totalAvailable')
        .addSelect('SUM(pv.stockOnHand)', 'totalStockOnHand')
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

      // 4. Accepted purchase invoices — total line quantity
      this.purchaseItemRepo
        .createQueryBuilder('pii')
        .innerJoin('pii.invoice', 'pi')
        .select('COALESCE(SUM(pii.quantity), 0)', 'totalAcceptedPurchaseQty')
        .where('pii.adminId = :adminId', { adminId })
        .andWhere('pi.adminId = :adminId', { adminId })
        .andWhere('pi.status = :accepted', { accepted: ApprovalStatus.ACCEPTED })
        .getRawOne(),

      // 5. Accepted purchase return invoices — total returned quantity
      this.purchaseReturnItemRepo
        .createQueryBuilder('prii')
        .innerJoin('prii.invoice', 'pri')
        .select('COALESCE(SUM(prii.returnedQuantity), 0)', 'totalAcceptedReturnQty')
        .where('prii.adminId = :adminId', { adminId })
        .andWhere('pri.adminId = :adminId', { adminId })
        .andWhere('pri.status = :accepted', { accepted: ApprovalStatus.ACCEPTED })
        .getRawOne(),

    ]);

    return {
      productCount: Number(totalProducts),
      inventory: {
        reserved: Number(inventoryStats?.totalReserved || 0),
        available: Number(inventoryStats?.totalAvailable || 0),
        totalOnHand: Number(inventoryStats?.totalStockOnHand || 0),
      },
      orders: {
        soldQuantity: Number(orderStats?.totalDelivered || 0),
        inTransitQuantity: Number(orderStats?.totalShipped || 0),
      },
      purchases: {
        acceptedQuantity: Number(acceptedPurchaseStats?.totalAcceptedPurchaseQty || 0),
      },
      purchaseReturns: {
        acceptedReturnedQuantity: Number(acceptedReturnStats?.totalAcceptedReturnQty || 0),
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
    if (q?.productType && q?.productType !== "none") {
      filters.productType = q.productType;
    }

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
      .where("product.adminId = :adminId", { adminId })
      .andWhere("product.isActive = :isActive", { isActive: true });

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
    if (filters.productType) {
      qb.andWhere("product.type = :productType", { productType: filters.productType });
    }

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
    const enriched = await this.attachSkusToProducts(me, records);

    // =============================
    // 📊 Prepare Excel Data
    // =============================
    const exportData = enriched.map((p: any) => {
      const skus = p?.skus ?? [];

      const firstSku = skus?.[0]?.sku ?? "";
      const skuCount = skus.length;

      const totalStock = skus.reduce(
        (sum: number, s: any) => sum + (s.stockOnHand || 0),
        0
      );
      const totalReserved = skus.reduce(
        (sum: number, s: any) => sum + (Number(s?.reserved) || 0),
        0
      );
      const totalAvailable = skus.reduce(
        (sum: number, s: any) => sum + (Number(s?.available) || 0),
        0
      );

      return {
        id: p.id,
        slug: p.slug ?? "",
        name: p.name ?? "",
        type: p.type ?? "",
        sku: firstSku,
        skuCount: skuCount,
        category: p.category?.name ?? "",
        store: p.store?.name ?? "",
        warehouse: p.warehouse?.name ?? "",
        storageRack: p.storageRack ?? "",
        wholesalePrice: p.wholesalePrice ?? "",
        salePrice: p.salePrice ?? "",
        lowestPrice: p.lowestPrice ?? "",
        totalStock: totalStock,
        totalReserved: totalReserved,
        totalAvailable: totalAvailable,
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
      { header: "Slug", key: "slug", width: 25 },
      { header: "Name", key: "name", width: 30 },
      { header: "Type", key: "type", width: 14 },
      { header: "SKU", key: "sku", width: 20 },
      { header: "SKUs Count", key: "skuCount", width: 12 },
      { header: "Category", key: "category", width: 20 },
      { header: "Store", key: "store", width: 20 },
      { header: "Warehouse", key: "warehouse", width: 20 },
      { header: "Storage Rack", key: "storageRack", width: 18 },
      { header: "Wholesale Price", key: "wholesalePrice", width: 16 },
      { header: "Sale Price", key: "salePrice", width: 16 },
      { header: "Lowest Price", key: "lowestPrice", width: 16 },
      { header: "Total Stock", key: "totalStock", width: 14 },
      { header: "Total Reserved", key: "totalReserved", width: 14 },
      { header: "Total Available", key: "totalAvailable", width: 14 },
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
        per_page: 12,
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

    const ids = q?.ids?.split(',') || [];

    if (q?.categoryId && q?.categoryId != "none")
      filters.categoryId = q.categoryId;

    if (q?.storeId && q?.storeId != "none")
      filters.storeId = q.storeId;

    if (q?.warehouseId && q?.warehouseId != "none")
      filters.warehouseId = q.warehouseId;
    if (q?.productType && q?.productType !== "none") {
      filters.productType = q.productType;
    }

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
    const isActiveFilter = q?.isActive !== 'false';

    const qb = this.prodRepo
      .createQueryBuilder("product")
      .leftJoinAndSelect("product.category", "category")
      .leftJoinAndSelect("product.store", "store")
      .leftJoinAndSelect("product.warehouse", "warehouse")
      .leftJoinAndMapMany(
        "product.syncStates",
        ProductSyncStateEntity,
        "syncState",
        `
    "syncState"."productId" = product.id
    AND "syncState"."adminId" = product."adminId"
    AND "syncState"."storeId" = product."storeId"
    AND "syncState"."externalStoreId" = "store"."externalStoreId"
  `
      )
      .where("product.adminId = :adminId", { adminId })
      .andWhere("product.isActive = :isActive", { isActive: isActiveFilter });

    // Apply normal filters manually (since we use QueryBuilder now)
    if (!!ids && ids?.length > 0)
      qb.andWhere("product.id IN (:...ids)", { ids: ids });

    if (filters.categoryId)
      qb.andWhere("product.categoryId = :categoryId", { categoryId: filters.categoryId });

    if (filters.storeId)
      qb.andWhere("product.storeId = :storeId", { storeId: filters.storeId });

    if (filters.warehouseId)
      qb.andWhere("product.warehouseId = :warehouseId", { warehouseId: filters.warehouseId });
    if (filters.productType) {
      qb.andWhere("product.type = :productType", { productType: filters.productType });
    }

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
            .orWhere("product.slug ILIKE :s", { s: `%${filters.search}%` });
        }),
      );
    }

    // =========================================
    // 🔥 Idle Products Filter
    // =========================================
    if (type === "PRODUCT_IDLE" && idleDate) {
      qb.andWhere(`
      product."created_at" <= :idleDate
      AND  NOT EXISTS (
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
    const withSummaries = await this.attachStockSummariesToProducts(me, enriched);

    return {
      records: withSummaries,
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

      const categoryName = dto.categoryName;
      let category: CategoryEntity | null = null;
      if (categoryName && categoryName.trim() !== "") {
        category = await catRepo.findOne({
          where: {
            name: categoryName.trim(),
            adminId,
          },
        });

        if (!category) {
          const slug = generateSlug(categoryName)
          category = catRepo.create({
            name: categoryName.trim(),
            slug: slug && slug !== "-" ? slug : `category-${Date.now()}`,
            adminId,
          });

          category = await catRepo.save(category);
        }
      }

      else if (dto.categoryId && dto.categoryId !== "none") {

        category = await this.assertOwnedOrNull(
          catRepo,
          adminId,
          dto.categoryId,
          "category"
        );
      }

      let store: StoreEntity;
      if (dto.storeId && dto.storeId !== 'none') {
        store = await this.assertOwnedOrNull(storeRepo, adminId, dto.storeId ?? null, "store");
      }

      if (dto.warehouseId && dto.warehouseId !== 'none') {
        const warehouse = await this.assertOwnedOrNull(whRepo, adminId, dto.warehouseId ?? null, "warehouse");
      }

      const existingSlug = await prodRepo.findOne({
        where: {
          adminId,
          slug: dto.slug.trim(),
          isActive: true,
          // storeId: dto.storeId === "none" ? IsNull() : dto.storeId,
        }
      });

      if (existingSlug) {
        throw new BadRequestException(
          `This slug "${dto.slug}" is already in use by another product.`
        );

      }

      if (store && !dto.skipRemoteCheck) {
        try {


          const provider = this.storesService.getProvider(store?.provider)
          const remoteSlug = await provider?.getProductBySlug(store, dto.slug.trim(), false)
          if (remoteSlug?.id) {
            throw new BadRequestException(`This slug "${dto.slug}" is already in use by "${store?.name}" store.`);
          }

          // 🔹 Slug check (if supported)
          if (dto.sku && this.storesService.isSkuFetchProvider(provider)) {
            const remoteSku = await provider.getProductBySku(
              store,
              dto.sku.trim(),
              false
            );

            if (remoteSku?.id) {
              throw new BadRequestException(
                `This SKU "${dto.sku}" is already in use by "${store.name}" store.`
              );
            }
          }

        } catch (e) {
          const errorMsg = getErrorMessage(e);
          throw new BadRequestException(errorMsg || "Error checking remote product.");
        }

      }


      const existingSKU = await prodRepo.findOne({
        where: {
          sku: dto.sku.trim(),
          adminId,
          isActive: true,
          // storeId: dto.storeId === "none" ? IsNull() : dto.storeId,
        }
      });

      if (existingSKU) {
        throw new BadRequestException(
          `This SKU "${dto.sku}" is already in use by another product.`
        );
      }



      const p = prodRepo.create({
        adminId,
        name: dto.name,
        slug: dto.slug,
        sku: dto.sku,
        type: dto.type,
        wholesalePrice: dto.wholesalePrice ?? null,
        lowestPrice: dto.lowestPrice ?? null,
        salePrice: dto.salePrice ?? null,
        storageRack: dto.storageRack ?? null,
        categoryId: category ? category.id : null,
        storeId: dto.storeId !== undefined && dto.storeId !== 'none' ? dto.storeId ?? null : null,
        warehouseId: dto.warehouseId !== undefined && dto.warehouseId !== 'none' ? dto.warehouseId ?? null : null,

        description: dto.description ?? null,
        callCenterProductDescription: dto.callCenterProductDescription ?? null,

        upsellingEnabled: dto.upsellingEnabled ?? false,
        upsellingProducts: (dto.upsellingProducts as any) ?? [],

        createdByUserId: me?.id ?? null,
        updatedByUserId: null,
      });

      const mainOrphanId = (dto as any).mainImageOrphanId;
      const mainImageUrl = dto.mainImage;
      if (!p.mainImage) {
        if (mainImageUrl && mainImageUrl.trim() !== "") {
          const newMainUrl = await this.remoteImageHelper.downloadAndSaveImage(mainImageUrl)
          p.mainImage = newMainUrl.url;
        } else if (mainOrphanId) {
          const mainRow = await mgr.getRepository(OrphanFileEntity).findOne({
            where: {
              adminId: String(adminId),
              id: mainOrphanId,
            } as any,
            select: ["id", "url"],
          });

          if (!mainRow) {
            throw new BadRequestException("mainImageOrphanId not found");
          }

          p.mainImage = mainRow.url;
        } else {
          throw new BadRequestException(
            "Either mainImage or mainImageOrphanId is required"
          );
        }
      }

      const imagesMeta = await Promise.all(
        (dto.images ?? [])
          .filter((img) => typeof img.url === "string" && img.url.trim() !== "")
          .map(async (img) => {
            const file = await this.remoteImageHelper.downloadAndSaveImage(img.url);

            return { url: file.url };
          })
      );
      const orphanIds = Array.isArray((dto as any).imagesOrphanIds) ? (dto as any).imagesOrphanIds : [];
      const orphanRows = await this.orphanFilesService.resolveOrphanUrlsOrThrow(mgr, String(adminId), orphanIds);
      const orphanImages = orphanRows.map((r) => ({ url: r.url }));

      const finalImages = [...imagesMeta, ...orphanImages];
      if (finalImages.length > 20) {
        throw new BadRequestException("Total images cannot exceed 20");
      }
      p.images = finalImages;

      const savedProduct = await prodRepo.save(p);

      if (dto.remoteId && store) {
        await this.productSyncStateService.upsertSyncState({ adminId, productId: savedProduct.id, storeId: store.id, externalStoreId: store.externalStoreId }, {
          remoteProductId: dto.remoteId,
          status: ProductSyncStatus.PENDING
        },
          mgr)
      }

      // delete used orphans AFTER product save
      const toDelete = [
        Number.isFinite(mainOrphanId) && mainOrphanId > 0 ? mainOrphanId : null, ...orphanRows.map((r) => r.id),
      ].filter(Boolean) as number[];
      await this.orphanFilesService.deleteOrphansByIds(mgr, String(adminId), toDelete);

      const productType = p.type === ProductType.VARIABLE ? ProductType.VARIABLE : ProductType.SINGLE;
      const combos = productType === ProductType.VARIABLE
        ? (Array.isArray(dto.combinations) ? dto.combinations : [])
        : [];

      let savedVariants: ProductVariantEntity[] = [];

      const candidateSkus = productType === ProductType.SINGLE
        ? []
        : combos
          .map(c => c.sku)
          .filter((sku): sku is string => !!sku);

      if (candidateSkus.length > 0) {
        const existingVariants = await pvRepo.find({
          where: {
            adminId,
            sku: In(candidateSkus)
          },
          select: ['sku']
        });

        if (existingVariants.length > 0) {
          const duplicateSkus = existingVariants.map(v => v.sku);
          throw new BadRequestException(
            `The following SKUs already exist in your account: ${duplicateSkus.join(', ')}. Please choose another one.`
          );
        }
      }

      let singleRow;
      if (productType === ProductType.SINGLE) {
        const defaultPrice = dto.salePrice !== undefined && dto.salePrice !== null
          ? Number(dto.salePrice)
          : 0;
        singleRow = pvRepo.create({
          adminId,
          productId: savedProduct.id,
          key: "default",
          sku: savedProduct?.sku ?? null,
          price: defaultPrice,
          attributes: {},
          stockOnHand: 0,
          reserved: 0,
          isActive: true,
          deactivatedAt: null,
        } as any);
        savedVariants = [await pvRepo.save(singleRow as any)];
      } else if (combos.length) {
        const skusToCheck = combos
          .map(c => c.sku)
          .filter((sku): sku is string => !!sku);

        if (skusToCheck.length > 0) {
          const existingVariants = await pvRepo.find({
            where: {
              adminId,
              sku: In(skusToCheck)
            },
            select: ['sku']
          });

          if (existingVariants.length > 0) {
            const duplicateSkus = existingVariants.map(v => v.sku);
            throw new BadRequestException(
              `The following SKUs already exist in your account: ${duplicateSkus.join(', ')}. Please choose another one.`
            );
          }
        }

        const rows: ProductVariantEntity[] = combos.map((c) => {
          const attrs = c.attributes ?? {};

          if (!Object.keys(attrs).length) {
            throw new BadRequestException("Each combination must have attributes");
          }

          const key = this.canonicalKey(attrs); // ✅ Always generated
          const sku = c.sku;

          if (!key) throw new BadRequestException("Each combination must have key or attributes");

          return {
            adminId,
            productId: savedProduct.id,
            key,
            sku: sku ?? null,
            price: c.price !== undefined && c.price !== null ? Number(c.price) : null,
            attributes: attrs,
            stockOnHand: 0,
            reserved: 0,
            isActive: c.isActive,
            deactivatedAt: c.isActive ? null : new Date()
          } as any
        });

        {
          const seen = new Set<string>();
          const skusInRequest = new Set<string>();
          for (const r of rows) {
            const k = `${adminId}::${savedProduct.id}::${r.key}`;
            if (seen.has(k)) throw new BadRequestException(`Found duplicate attributes in request: ${r.key}`);
            seen.add(k);

            if (r.sku) {
              if (skusInRequest.has(r.sku)) throw new BadRequestException(`Duplicate SKU in request: ${r.sku}`);
              skusInRequest.add(r.sku);
            }
          }
        }

        {
          const keys = rows.map((r) => r.key);
          const exists = await pvRepo.find({
            where: { adminId, productId: savedProduct.id, key: In(keys) } as any,
            select: ["id", "key"],
          });

          if (exists.length) {
            const attrDetails = Object.entries(exists[0].attributes || {})
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ")

            throw new BadRequestException(
              `A variant with these attributes already exists for this product: (${attrDetails}). Please modify the combination.`
            );
          }
        }

        savedVariants = await pvRepo.save(rows);
      }

      // Handle Purchase Data if provided
      if (dto.purchase) {
        // Map combinations to variant IDs for purchase items
        const purchaseItems = savedVariants.map(v => {
          const combo = productType === ProductType.SINGLE
            ? singleRow
            : combos.find(c => this.canonicalKey(c.attributes) === v.key);


          return {
            variantId: v.id,
            quantity: productType === ProductType.SINGLE ? Number(dto.purchase.quantity || 0) : Number(combo?.stockOnHand) || 0,
            purchaseCost: Number(dto.purchase.wholesalePrice || 0) || 0, 
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

  async update(me: any, id: string, dto: UpdateProductDto, manager?: EntityManager) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const work = async (mgr: EntityManager) => {
      const prodRepo = mgr.getRepository(ProductEntity);
      const catRepo = mgr.getRepository(CategoryEntity);
      const storeRepo = mgr.getRepository(StoreEntity);
      const whRepo = mgr.getRepository(WarehouseEntity);
      const pvRepo = mgr.getRepository(ProductVariantEntity);
      const orphanRepo = mgr.getRepository(OrphanFileEntity);

      // 1. Fetch existing product
      const p = await prodRepo.findOne({
        where: { id, adminId } as any,
        relations: ["category", "store", "warehouse"]
      });

      if (!p) throw new BadRequestException("product not found");

      if (dto.slug) {
        const cleanSlug = dto.slug;
        const existingSlug = await prodRepo.findOne({
          where: {
            adminId,
            slug: cleanSlug,
            isActive: true,
            // storeId: dto.storeId !== undefined && dto.storeId !== 'none' ? (dto.storeId ?? null) : p.storeId,
            id: Not(id)
          }
        });

        if (existingSlug) {
          throw new BadRequestException(`The slug "${cleanSlug}" is already in use by another product.`);
        }

        p.slug = cleanSlug;
      }

      // --- 2. Handle Base Relations & Fields ---
      if (dto.categoryId !== undefined && dto.categoryId !== 'none') {
        const category = await this.assertOwnedOrNull(catRepo, adminId, dto.categoryId ?? null, "category");
        (p as any).categoryId = dto.categoryId ?? null;
        (p as any).category = category ?? null;
      } else if (dto.categoryId === 'none') {
        (p as any).categoryId = null;
        (p as any).category = null;
      }


      if (dto.storeId !== undefined && dto.storeId !== 'none') {
        const store = await this.assertOwnedOrNull(storeRepo, adminId, dto.storeId ?? null, "store");
        (p as any).storeId = dto.storeId ?? null;
        (p as any).store = store ?? null;
      } else if (dto.storeId === 'none') {
        (p as any).storeId = null;
        (p as any).store = null;
      }

      if (dto.warehouseId !== undefined && dto.warehouseId !== 'none') {
        const warehouse = await this.assertOwnedOrNull(whRepo, adminId, dto.warehouseId ?? null, "warehouse");
        (p as any).warehouseId = dto.warehouseId ?? null;
        (p as any).warehouse = warehouse ?? null;
      } else if (dto.warehouseId === 'none') {
        (p as any).warehouseId = null;
        (p as any).warehouse = null;
      }


      if (p.storeId) {
        let store: StoreEntity;
        store = await this.assertOwnedOrNull(storeRepo, adminId, dto.storeId ?? null, "store");
        const provider = this.storesService.getProvider(store?.provider)
        const remoteSlug = await provider?.getProductBySlug(store, dto.slug.trim(), false)

        const productSyncState = await this.productSyncStateRepo.findOne({
          where: {
            productId: p.id,
            storeId: store.id,
            adminId: p.adminId,
            externalStoreId: store?.externalStoreId
          }
        });
        let externalId = productSyncState?.remoteProductId;
        if (remoteSlug && remoteSlug?.id?.toString() !== externalId?.toString()) {
          throw new BadRequestException(`This slug "${dto.slug}" is already in use by "${store?.name}" store.`);
        }

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
        const row = await orphanRepo.findOne({
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
        const rows = await this.orphanFilesService.resolveOrphanUrlsOrThrow(mgr, String(adminId), orphanIds);

        const current = Array.isArray((p as any).images) ? (p as any).images : [];
        const toAppend = rows.map((r) => ({ url: r.url }));

        if (current.length + toAppend.length > 20) {
          throw new BadRequestException("Total images cannot exceed 20");
        }

        (p as any).images = [...current, ...toAppend];

        await orphanRepo.delete({
          adminId: String(adminId),
          id: In(rows.map((r) => r.id)),
        } as any);
      }
      delete (dto as any).imagesOrphanIds;


      const patch: any = { ...dto };
      delete patch.categoryId;
      delete patch.storeId;
      delete patch.warehouseId;
      delete patch.combinations;

      const combos = dto.combinations;
      const hasRealVariants = Array.isArray(combos) && combos.some(c => Object.keys(c.attributes || {}).length > 0);

      if (p.type === ProductType.SINGLE && hasRealVariants) {
        p.type = ProductType.VARIABLE;
      }

      Object.assign(p as any, patch, { updatedByUserId: me?.id ?? null });
      const savedProduct = await prodRepo.save(p as any);

      if (
        p.type === ProductType.SINGLE &&
        dto.salePrice !== undefined &&
        dto.salePrice !== null
      ) {
        const mainVariant = await pvRepo.findOne({
          where: { adminId, productId: p.id, key: "default" } as any,
          order: { id: "ASC" } as any,
        });

        if (!mainVariant) {
          throw new BadRequestException("Main SKU row not found for single product");
        }

        if (mainVariant) {
          mainVariant.price = Number(dto.salePrice);
          await pvRepo.save(mainVariant);
        }
      }

      if (p.type !== ProductType.SINGLE && dto.combinations && Array.isArray(dto.combinations)) {
        const combos = dto.combinations;


        const keysInRequest = new Set<string>();
        const skusInRequest = new Set<string>();

        for (const c of combos) {
          const attrs = c.attributes ?? {};
          const key = Object.keys(attrs).length > 0 ? this.canonicalKey(attrs) : (c.key === 'default' ? 'default' : null);

          if (!key) {
            throw new BadRequestException("Each combination must have attributes or be a default variant");
          }

          if (keysInRequest.has(key)) throw new BadRequestException(`Found duplicate attributes in request: ${key}`);
          keysInRequest.add(key);

          if (c.sku) {
            if (skusInRequest.has(c.sku)) throw new BadRequestException(`Duplicate SKU in request: ${c.sku}`);
            skusInRequest.add(c.sku);
          }
        }

        const existingVariants = await pvRepo.find({ where: { adminId, productId: p.id } as any });
        const existingVariantMap = new Map(existingVariants.map(v => [v.key, v]));

        const existingSkusForThisProduct = new Set(existingVariants.map(v => v.sku).filter(Boolean));

        const skusToCheck = Array.from(skusInRequest).filter(sku => !existingSkusForThisProduct.has(sku));

        if (skusToCheck.length > 0) {
          const conflictingVariants = await pvRepo.find({
            where: { adminId, sku: In(skusToCheck) } as any,
            select: ['sku']
          });

          if (conflictingVariants.length > 0) {
            const duplicateSkus = conflictingVariants.map(v => v.sku);
            throw new BadRequestException(
              `The following SKUs already exist in your account: ${duplicateSkus.join(', ')}. Please choose another one.`
            );
          }
        }

        // D. Map items to Update, Create, or Deactivate
        const variantsToSave: ProductVariantEntity[] = [];

        for (const c of combos) {
          const attrs = c.attributes ?? {};
          const key = Object.keys(attrs).length > 0 ? this.canonicalKey(attrs) : 'default';

          const existing = existingVariantMap.get(key);

          if (existing) {
            // UPDATE: Variant exists. Update fields and ensure it is active.
            existing.sku = c.sku ?? null;
            existing.price = c.price !== undefined && c.price !== null ? Number(c.price) : null;
            const nextActive = c.isActive !== false;
            existing.isActive = nextActive;
            existing.deletdWithParent = false;
            existing.deactivatedAt = nextActive ? null : new Date();
            variantsToSave.push(existing);
          } else {
            // CREATE: Brand new variant combination
            variantsToSave.push({
              adminId,
              productId: savedProduct.id,
              key,
              sku: c.sku ?? null,
              price: c.price !== undefined && c.price !== null ? Number(c.price) : null,
              attributes: c.attributes,
              stockOnHand: 0,
              reserved: 0,
              isActive: c.isActive,
              deactivatedAt: c.isActive ? null : new Date()
            } as any);
          }
        }


        if (variantsToSave.length > 0) {
          await pvRepo.save(variantsToSave);
        }
      }

      return savedProduct.id;
    };

    // Run everything inside a transaction to prevent partial updates
    const savedId = manager ? await work(manager) : await this.dataSource.transaction(mgr => work(mgr));
    return this.get(me, savedId);
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
        ['variants'],
        {
          relations: {
            variants: {
              deletdWithParent: true
            }
          }
        }
      );
    });
  }

  async restore(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    return await this.dataSource.transaction(async (manager) => {
      const productRepo = manager.getRepository(ProductEntity);
      const variantRepo = manager.getRepository(ProductVariantEntity);

      // 1. Restore product
      const product = await productRepo.findOne({
        where: { id, adminId }
      });

      if (!product) {
        throw new NotFoundException("Product not found");
      }

      await productRepo.update(
        { id, adminId },
        {
          isActive: true,
          deactivatedAt: null,
        }
      );

      // 2. Restore only variants that were deleted with parent
      await variantRepo.update(
        {
          productId: id,
          adminId,
          deletdWithParent: true
        },
        {
          isActive: true,
          deactivatedAt: null,
          deletdWithParent: false
        }
      );

      const items = await variantRepo.find({
        where: {
          productId: id,
          adminId,
          deletdWithParent: true,
        },
      });

      for (const item of items) {
        item.isActive = true;
        item.deactivatedAt = null;
        item.deletdWithParent = false;
      }

      await variantRepo.save(items);
    });
  }

  async checkSlug(me: any, slug, productId) {
    const adminId = tenantId(me);
    const formatedSlug = slug.trim().toLowerCase();
    if (!adminId) throw new BadRequestException("Missing adminId");

    if (productId) {
      const entity = await CRUD.findOne(this.prodRepo, "products", productId);
      if (formatedSlug === entity.slug) return {
        isUnique: true
      }
    }

    const exists = await this.prodRepo.findOne({
      where: {
        adminId,
        slug: formatedSlug,
        isActive: true
        // storeId: storeId ? storeId : IsNull()
      },
      select: ["id"] // نختار الـ id فقط لتحسين الأداء
    });

    return { isUnique: !exists };
  }

  async checkSku(me: any, sku, productId) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    if (productId) {
      const entity = await CRUD.findOne(this.prodRepo, "products", productId);
      if (sku === entity.sku) return {
        isUnique: true
      }
    }

    const exists = await this.prodRepo.findOne({
      where: {
        adminId,
        sku: sku.trim(),
        isActive: true
        // storeId: storeId ? storeId : IsNull()
      },
      select: ["id"] // نختار الـ id فقط لتحسين الأداء
    });

    return { isUnique: !exists };
  }

  async checkSkusAvailability(me: any, skus: string[] = [], productId?: string) {
    const adminId = tenantId(me);
    const normalized = Array.from(
      new Set(
        (Array.isArray(skus) ? skus : [])
          .map((sku) => String(sku ?? "").trim())
          .filter(Boolean)
      )
    );

    if (!normalized.length) {
      return {
        existing: [],
        available: [],
      };
    }

    const existingRows = await this.pvRepo.find({
      where: {
        adminId,
        sku: In(normalized),
      } as any,
      select: ["sku", "productId"],
    });

    const existingSet = new Set(
      existingRows
        .filter((row) => !productId || String(row.productId) !== String(productId))
        .map((row) => row.sku)
    );

    const existing = normalized.filter((sku) => existingSet.has(sku));
    const available = normalized.filter((sku) => !existingSet.has(sku));

    return {
      existing,
      available,
    };
  }
}
