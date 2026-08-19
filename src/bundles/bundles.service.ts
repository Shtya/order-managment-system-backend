// --- File: src/bundles/bundles.service.ts ---
import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Like, Not, Repository } from "typeorm";
import { tenantId } from "../category/category.service";

import { BundleEntity, BundleItemEntity } from "entities/bundle.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import { CategoryEntity } from "entities/categories.entity";
import { CreateBundleDto, UpdateBundleDto } from "dto/bundle.dto";
import { CRUD } from "../../common/crud.service";
import * as ExcelJS from "exceljs";
import { StoresService } from "src/stores/stores.service";
import { OrdersService } from "src/orders/services/orders.service";
import { TranslationService } from "common/translation.service";
import { OrphanFileEntity } from "entities/files.entity";
import { OrphanFilesService } from "src/orphan-files/orphan-files.service";
import {
  deletePhysicalFiles,
  generateSlug,
  getErrorMessage,
} from "common/healpers";
import { StoreEntity } from "entities/stores.entity";
import { ProductSyncStateEntity } from "entities/product_sync_error.entity";
import { OnboardingAchievementService } from "src/queue/queues/onboarding-achievement.queue";
import { GettingStartedAchievementType } from "entities/getting-started.entity";

@Injectable()
export class BundlesService {
  constructor(
    @InjectRepository(BundleEntity)
    private bundleRepo: Repository<BundleEntity>,

    @InjectRepository(BundleItemEntity)
    private itemRepo: Repository<BundleItemEntity>,

    @InjectRepository(ProductVariantEntity)
    private pvRepo: Repository<ProductVariantEntity>,

    @InjectRepository(CategoryEntity)
    private catRepo: Repository<CategoryEntity>,

    @InjectRepository(OrphanFileEntity)
    private orphanRepo: Repository<OrphanFileEntity>,

    @Inject(forwardRef(() => StoresService))
    private storesService: StoresService,

    private readonly ordersService: OrdersService,
    private readonly orphanFilesService: OrphanFilesService,

    private readonly dataSource: DataSource,
    private readonly translations: TranslationService,
    private readonly onboardingAchievementService: OnboardingAchievementService,
  ) {}

  private async assertOwnedOrNull(
    repo: Repository<any>,
    adminId: string,
    id?: string | null,
    label = "entity",
  ) {
    if (id == null) return null;
    const e = await repo.findOne({ where: { id } as any });
    if (!e) {
      throw new BadRequestException(
        this.translations.t("domains.bundles.not_found"),
      );
    }
    return e;
  }

  async checkSku(me: any, sku: string, bundleId?: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    if (bundleId) {
      const entity = await this.bundleRepo.findOne({
        where: { id: bundleId, adminId } as any,
      });
      if (entity && sku === entity.sku) return { isUnique: true };
    }

    const exists = await this.bundleRepo.findOne({
      where: {
        adminId,
        sku: sku.trim(),
        isActive: true,
      },
      select: ["id"],
    });

    return { isUnique: !exists };
  }

  async checkSlug(me: any, slug: string, bundleId?: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }
    const formattedSlug = slug.trim().toLowerCase();

    if (bundleId) {
      const entity = await this.bundleRepo.findOne({
        where: { id: bundleId, adminId } as any,
      });
      if (entity && formattedSlug === entity.slug) return { isUnique: true };
    }

    const exists = await this.bundleRepo.findOne({
      where: {
        adminId,
        slug: formattedSlug,
        isActive: true,
      },
      select: ["id"],
    });

    return { isUnique: !exists };
  }

  async list(me: any, q?: any) {
    const page = Number(q?.page) || 1;
    const limit = Number(q?.limit) || 10;
    const skip = (page - 1) * limit;
    const adminId = tenantId(me);
    const ids = q?.ids?.split(",") || [];

    const qb = this.bundleRepo.createQueryBuilder("bundle");
    const isActiveFilter = q?.isActive !== "false";
    const itemConditions = isActiveFilter
      ? "items.isActive = :itemActive"
      : "items.isActive = :itemActive AND items.deletdWithParent = true";

    // 1. Joins & Selective Loading
    // We use a condition in the join to filter out inactive bundle items
    qb
      // .leftJoinAndSelect("bundle.variant", "variant")
      // 	.leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("bundle.store", "store")
      .leftJoinAndSelect("bundle.category", "category")
      .leftJoinAndSelect("bundle.items", "items", itemConditions, {
        itemActive: isActiveFilter,
      })
      .leftJoinAndMapMany(
        "bundle.syncStates",
        ProductSyncStateEntity,
        "syncState",
        `
				"syncState"."bundleId" = bundle.id
				AND "syncState"."adminId" = bundle."adminId"
				AND "syncState"."storeId" = bundle."storeId"
				AND "syncState"."externalStoreId" = "store"."externalStoreId"
			  `,
      )

      .leftJoinAndSelect("items.variant", "itemVariant");

    // 2. Base Filters (Tenant & Status)
    qb.where("bundle.adminId = :adminId", { adminId });
    qb.andWhere("bundle.isActive = :bundleActive", {
      bundleActive: isActiveFilter,
    });

    // 3. Dynamic Filters
    if (q?.categoryId && q?.categoryId !== "none") {
      qb.andWhere("bundle.categoryId = :categoryId", {
        categoryId: q.categoryId,
      });
    }

    if (q?.storeId && q?.storeId !== "none") {
      qb.andWhere("bundle.storeId = :storeId", { storeId: q.storeId });
    }

    // 4. Numeric Range Filter (Price)
    if (q?.["wholesalePrice.gte"]) {
      qb.andWhere("bundle.price >= :minPrice", {
        minPrice: Number(q["wholesalePrice.gte"]),
      });
    }
    if (q?.["wholesalePrice.lte"]) {
      qb.andWhere("bundle.price <= :maxPrice", {
        maxPrice: Number(q["wholesalePrice.lte"]),
      });
    }

    if (!!ids && ids?.length > 0) {
      qb.andWhere("bundle.id IN (:...ids)", { ids: ids });
    }

    // 5. Search (Name or SKU)
    if (q?.search) {
      qb.andWhere("(bundle.name ILIKE :search OR bundle.sku ILIKE :search)", {
        search: `%${q.search}%`,
      });
    }

    // 6. Sorting
    const sortBy = q?.sortBy || "created_at";
    const sortOrder = q?.sortOrder?.toUpperCase() === "ASC" ? "ASC" : "DESC";
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
      per_page: limit,
    };
  }

  async get(me: any, id: string) {
    const adminId = tenantId(me);

    const bundle = await this.bundleRepo.findOne({
      where: { id, adminId },
    });

    if (!bundle) {
      throw new BadRequestException(
        this.translations.t("domains.bundles.not_found"),
      );
    }

    const itemCondition = bundle.isActive
      ? "items.isActive = true"
      : "items.isActive = false AND items.deletdWithParent = true";

    return (
      this.bundleRepo
        .createQueryBuilder("bundle")
        // .leftJoinAndSelect("bundle.variant", "variant")
        // .leftJoinAndSelect("variant.product", "product")
        .leftJoinAndSelect("bundle.store", "store")
        .leftJoinAndSelect("bundle.category", "category")
        .leftJoinAndSelect("bundle.items", "items", itemCondition)
        .leftJoinAndSelect("items.variant", "itemVariant")
        .where("bundle.id = :id AND bundle.adminId = :adminId", { id, adminId })
        .getOne()
    );
  }

  async getBySku(me: any, sku: string) {
    const adminId = tenantId(me);
    const bundle = await this.bundleRepo
      .createQueryBuilder("bundle")
      // .leftJoinAndSelect("bundle.variant", "variant")
      // .leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("bundle.store", "store")
      .leftJoinAndSelect("bundle.category", "category")
      .leftJoinAndSelect(
        "bundle.items",
        "items",
        "items.isActive = :isActive",
        { isActive: true },
      )
      .leftJoinAndSelect("items.variant", "itemVariant")
      .where("bundle.sku = :sku AND bundle.adminId = :adminId", {
        sku,
        adminId,
      })
      .getOne();

    if (!bundle) {
      throw new BadRequestException(
        this.translations.t("domains.bundles.sku_not_found"),
      );
    }
    return bundle;
  }

  async create(me: any, dto: CreateBundleDto) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    const items = Array.isArray(dto.items) ? dto.items : [];
    if (!items.length) {
      throw new BadRequestException(
        this.translations.t("domains.bundles.items_required"),
      );
    }

    // ensure items are unique
    const itemIds = items.map((it) => it.variantId);
    if (new Set(itemIds).size !== itemIds.length) {
      throw new BadRequestException(
        this.translations.t("domains.bundles.duplicate_items"),
      );
    }

    // Validate Store if storeId is provided
    let store: StoreEntity | null = null;
    if (dto.storeId) {
      store = await this.storesService.getStoreById(me, dto.storeId);
      if (!store) {
        throw new BadRequestException(
          this.translations.t("common.store_not_found"),
        );
      }
    }

    for (const it of items) {
      if (!Number.isInteger(it.qty) || it.qty <= 0) {
        throw new BadRequestException(
          this.translations.t("common.qty_must_be_positive"),
        );
      }
    }

    // ensure variants exist and belong to admin
    const ids = items.map((x) => x.variantId);

    const variants2 = await this.pvRepo.find({ where: { adminId } as any });
    const variantSet = new Set(
      variants2.filter((v) => ids.includes(v.id)).map((v) => v.id),
    );

    for (const it of items) {
      if (!variantSet.has(it.variantId)) {
        throw new BadRequestException(
          this.translations.t("domains.bundles.variant_id_not_found", {
            args: { variantId: it.variantId },
          }),
        );
      }
    }

    // slug: use provided or generate from name
    let slug = dto.slug?.trim() || null;
    if (slug) {
      const existingSlug = await this.bundleRepo.findOne({
        where: { adminId, slug, isActive: true } as any,
      });
      if (existingSlug) {
        throw new BadRequestException(
          this.translations.t("common.slug_already_in_use", { args: { slug } }),
        );
      }
    } else {
      slug = generateSlug(dto.name) || `bundle-${Date.now()}`;
    }

    const existingSKU = await this.bundleRepo.findOne({
      where: {
        sku: dto.sku.trim(),
        adminId,
        isActive: true,
      },
    });

    if (existingSKU) {
      throw new BadRequestException(
        this.translations.t("domains.bundles.sku_already_in_use", {
          args: { sku: dto.sku },
        }),
      );
    }

    if (store) {
      try {
        const provider = this.storesService.getProvider(store?.provider);

        const promises: Promise<any>[] = [];
        promises.push(
          provider?.getProductBySlug(store, dto.slug.trim(), false),
        );

        if (dto.sku && this.storesService.isSkuFetchProvider(provider)) {
          promises.push(provider.getProductBySku(store, dto.sku.trim(), false));
        }

        const results = await Promise.allSettled(promises);

        // Check slug result
        const slugResult = results[0];
        if (slugResult.status === "fulfilled") {
          const remoteSlug = slugResult.value;
          if (remoteSlug?.id) {
            throw new BadRequestException(
              this.translations.t(
                "domains.products.slug_already_in_use_by_store",
                { args: { slug: dto.slug, storeName: store?.name } },
              ),
            );
          }
        } else if (slugResult.status === "rejected") {
          throw slugResult.reason;
        }

        // Check sku result if we had it
        if (results.length > 1) {
          const skuResult = results[1];
          if (skuResult.status === "fulfilled") {
            const remoteSku = skuResult.value;
            if (remoteSku?.id) {
              throw new BadRequestException(
                this.translations.t(
                  "domains.products.sku_already_in_use_by_store",
                  { args: { sku: dto.sku, storeName: store?.name } },
                ),
              );
            }
          } else if (skuResult.status === "rejected") {
            throw skuResult.reason;
          }
        }
      } catch (e) {
        if (e instanceof BadRequestException) {
          throw e;
        }
        const errorMsg = getErrorMessage(e);
        throw new BadRequestException(
          this.translations.t("domains.products.failed_to_verify_uniqueness", {
            args: { storeName: store?.name, errorMsg },
          }),
        );
      }
    }

    // mainImage: from URL or orphan
    let mainImage: string | null = null;
    const mainOrphanId = (dto as any).mainImageOrphanId;
    if (dto.mainImage && dto.mainImage.trim() !== "") {
      mainImage = dto.mainImage;
    } else if (mainOrphanId) {
      const mainRow = await this.orphanFilesService.resolveOrphanUrlsOrThrow(
        this.dataSource.manager,
        String(adminId),
        [mainOrphanId],
      );
      mainImage = mainRow[0]?.url ?? null;
    }

    // images: from URL array + orphan IDs
    const imagesMeta = (dto.images ?? [])
      .filter((img) => typeof img.url === "string" && img.url.trim() !== "")
      .map((img) => ({ url: img.url }));

    const orphanIds = Array.isArray(dto.imagesOrphanIds)
      ? dto.imagesOrphanIds
      : [];
    const orphanRows = await this.orphanFilesService.resolveOrphanUrlsOrThrow(
      this.dataSource.manager,
      String(adminId),
      orphanIds,
    );
    const orphanImages = orphanRows.map((r) => ({ url: r.url }));

    const finalImages = [...imagesMeta, ...orphanImages];

    // categoryId validation
    let category: CategoryEntity | null = null;
    if (dto.categoryId && dto.categoryId !== "none") {
      category = await this.assertOwnedOrNull(
        this.catRepo,
        adminId,
        dto.categoryId,
        "category",
      );
    }

    const b = this.bundleRepo.create({
      adminId,
      name: dto.name,
      slug,
      sku: dto.sku,
      price: dto.price,
      description: dto.description,
      storeId: dto.storeId,
      categoryId: category ? category.id : null,
      mainImage: mainImage as any,
      images: finalImages as any,
      items: items.map((it) =>
        this.itemRepo.create({
          adminId,
          variantId: it.variantId,
          qty: it.qty,
        }),
      ),
    });

    const saved = await this.bundleRepo.save(b);

    // delete used orphans AFTER save
    const toDelete = [mainOrphanId, ...orphanRows.map((r) => r.id)].filter(
      Boolean,
    ) as string[];
    if (toDelete.length) {
      await this.orphanFilesService.deleteOrphansByIds(
        this.dataSource.manager,
        String(adminId),
        toDelete,
      );
    }

    this.onboardingAchievementService.enqueueAchievement(
      adminId,
      GettingStartedAchievementType.FIRST_ORDER_BUNDLE_CREATED,
    );

    return this.get(me, saved.id);
  }

  async exportBundles(me: any, q?: any) {
    const adminId = tenantId(me);
    const qb = this.bundleRepo.createQueryBuilder("bundle");
    const isActiveFilter = q?.isActive !== "false";
    const itemConditions = isActiveFilter
      ? "items.isActive = :itemActive"
      : "items.isActive = :itemActive AND items.deletdWithParent = true";

    // 1. Joins & Selective Loading (Filtering inactive bundle items)
    qb
      // .leftJoinAndSelect("bundle.variant", "variant")
      // 	.leftJoinAndSelect("variant.product", "product")
      .leftJoinAndSelect("bundle.store", "store")
      .leftJoinAndSelect("bundle.category", "category")
      .leftJoinAndSelect("bundle.items", "items", itemConditions, {
        itemActive: isActiveFilter,
      })
      .leftJoinAndSelect("items.variant", "itemVariant");

    // 2. Base Filters
    qb.where("bundle.adminId = :adminId", { adminId });
    qb.andWhere("bundle.isActive = :bundleActive", {
      bundleActive: isActiveFilter,
    });

    // 3. Dynamic Filters (Category & Store)
    if (q?.categoryId && q?.categoryId !== "none") {
      qb.andWhere("bundle.categoryId = :categoryId", {
        categoryId: q.categoryId,
      });
    }
    if (q?.storeId && q?.storeId !== "none") {
      qb.andWhere("bundle.storeId = :storeId", { storeId: q.storeId });
    }

    // 4. Price Range Filters
    if (q?.["wholesalePrice.gte"]) {
      qb.andWhere("bundle.price >= :minPrice", {
        minPrice: Number(q["wholesalePrice.gte"]),
      });
    }
    if (q?.["wholesalePrice.lte"]) {
      qb.andWhere("bundle.price <= :maxPrice", {
        maxPrice: Number(q["wholesalePrice.lte"]),
      });
    }

    // 5. Search Logic
    if (q?.search) {
      qb.andWhere("(bundle.name ILIKE :search OR bundle.sku ILIKE :search)", {
        search: `%${q.search}%`,
      });
    }

    // 6. Sorting
    const sortBy = q?.sortBy || "created_at";
    const sortOrder = q?.sortOrder?.toUpperCase() === "ASC" ? "ASC" : "DESC";
    qb.orderBy(`bundle.${sortBy}`, sortOrder);

    // 7. Fetch all records (Exports usually ignore pagination limits)
    const bundles = await qb.getMany();

    // 8. Map Data for Excel
    const exportData = bundles.map((b) => ({
      id: b.id,
      name: b.name ?? "",
      sku: b.sku ?? "",
      price: b.price ?? 0,
      storeName: b.store?.name ?? "",
      itemsCount: b.items?.length ?? 0, // Only active items are counted here now
      description: b.description ?? "",
      created_at: b.created_at
        ? new Date(b.created_at).toLocaleDateString("en-US")
        : "",
    }));

    // 9. Generate Excel with Branding
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      this.translations.t("domains.bundles.export_sheet"),
    );

    worksheet.columns = [
      {
        header: this.translations.t("domains.bundles.export_id"),
        key: "id",
        width: 10,
      },
      {
        header: this.translations.t("domains.bundles.export_name"),
        key: "name",
        width: 30,
      },
      {
        header: this.translations.t("domains.bundles.export_sku"),
        key: "sku",
        width: 25,
      },
      {
        header: this.translations.t("domains.bundles.export_price"),
        key: "price",
        width: 15,
      },
      {
        header: this.translations.t("domains.bundles.export_store_name"),
        key: "storeName",
        width: 25,
      },
      {
        header: this.translations.t("domains.bundles.export_items_count"),
        key: "itemsCount",
        width: 15,
      },
      {
        header: this.translations.t("domains.bundles.export_description"),
        key: "description",
        width: 40,
      },
      {
        header: this.translations.t("domains.bundles.export_created_at"),
        key: "created_at",
        width: 18,
      },
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
    if (!b) {
      throw new BadRequestException(
        this.translations.t("domains.bundles.not_found"),
      );
    }

    if (dto.name !== undefined) b.name = dto.name;
    if (dto.price !== undefined) b.price = dto.price;
    if (dto.description !== undefined) b.description = dto.description;

    // slug update with uniqueness check
    if (dto.slug !== undefined) {
      const cleanSlug = dto.slug.trim();
      if (cleanSlug !== b.slug) {
        const existingSlug = await this.bundleRepo.findOne({
          where: {
            adminId,
            slug: cleanSlug,
            isActive: true,
            id: Not(id),
          } as any,
        });
        if (existingSlug) {
          throw new BadRequestException(
            this.translations.t("domains.bundles.slug_already_in_use", {
              args: { slug: cleanSlug },
            }),
          );
        }
      }
      b.slug = cleanSlug;
    }

    // ── removeImgs ──
    const removeImgs = (dto as any).removeImgs as string[] | undefined;
    if (removeImgs?.length) {
      deletePhysicalFiles(removeImgs);
      b.images = ((b as any).images ?? []).filter(
        (img: any) => img?.url && !removeImgs.includes(img.url),
      );
    }
    delete (dto as any).removeImgs;

    // ── mainImage via orphan ──
    const mainOrphanId = (dto as any).mainImageOrphanId;
    if (
      mainOrphanId !== undefined &&
      mainOrphanId !== null &&
      mainOrphanId !== ""
    ) {
      const mainRow = await this.orphanFilesService.resolveOrphanUrlsOrThrow(
        this.dataSource.manager,
        String(adminId),
        [mainOrphanId],
      );
      if (b.mainImage) {
        deletePhysicalFiles([b.mainImage]);
      }
      (b as any).mainImage = mainRow[0]?.url ?? null;
      await this.orphanFilesService.deleteOrphansByIds(
        this.dataSource.manager,
        String(adminId),
        [mainOrphanId],
      );
    }
    delete (dto as any).mainImageOrphanId;

    // ── gallery images via orphan ids ──
    const orphanIds = (dto as any).imagesOrphanIds;
    if (orphanIds !== undefined) {
      if (!Array.isArray(orphanIds)) {
        throw new BadRequestException(
          this.translations.t(
            "domains.bundles.images_orphan_ids_must_be_array",
          ),
        );
      }
      const rows = await this.orphanFilesService.resolveOrphanUrlsOrThrow(
        this.dataSource.manager,
        String(adminId),
        orphanIds,
      );
      const current = Array.isArray((b as any).images) ? (b as any).images : [];
      const toAppend = rows.map((r) => ({ url: r.url }));
      (b as any).images = [...current, ...toAppend];
      await this.orphanFilesService.deleteOrphansByIds(
        this.dataSource.manager,
        String(adminId),
        rows.map((r) => r.id),
      );
    }
    delete (dto as any).imagesOrphanIds;

    const finalItems = dto.items !== undefined ? dto.items : b.items;
    // ensure items are unique
    if (dto.items !== undefined) {
      const itemIds = dto.items.map((it) => it.variantId);
      if (new Set(itemIds).size !== itemIds.length) {
        throw new BadRequestException(
          this.translations.t("domains.bundles.duplicate_items"),
        );
      }
    }

    // Validate Store if storeId is provided/changed
    if (dto.storeId !== undefined) {
      if (dto.storeId === null) {
        b.storeId = null;
      } else {
        const store = await this.storesService.getStoreById(me, dto.storeId);
        if (!store) {
          throw new BadRequestException(
            this.translations.t("common.store_not_found"),
          );
        }
        b.storeId = dto.storeId;
      }
    }

    // Validate Category if categoryId is provided/changed
    if (dto.categoryId !== undefined && dto.categoryId !== "none") {
      const category = await this.assertOwnedOrNull(
        this.catRepo,
        adminId,
        dto.categoryId ?? null,
        "category",
      );
      b.categoryId = dto.categoryId ?? null;
    } else if (dto.categoryId === "none") {
      b.categoryId = null;
    }

    if (dto.items !== undefined) {
      const items = Array.isArray(dto.items) ? dto.items : [];
      if (!items.length) {
        throw new BadRequestException(
          this.translations.t("domains.bundles.items_required"),
        );
      }

      for (const it of items) {
        if (!Number.isInteger(it?.qty) || it.qty <= 0) {
          throw new BadRequestException(
            this.translations.t("common.qty_must_be_positive"),
          );
        }
      }

      const ids = items.map((x) => x.variantId);
      const variants = await this.pvRepo.find({
        where: { adminId, id: In(ids) } as any,
        select: ["id"],
      });
      const variantSet = new Set(variants.map((v) => v.id));

      for (const it of items) {
        if (!variantSet.has(it.variantId)) {
          throw new BadRequestException(
            this.translations.t("domains.bundles.variant_id_not_found", {
              args: { variantId: it.variantId },
            }),
          );
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
          item.deletdWithParent = false;
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
        ["items"],
        {
          relations: {
            items: {
              deletdWithParent: true,
            },
          },
        },
      );
    });
  }

  async restore(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) {
      throw new BadRequestException(
        this.translations.t("common.missing_admin_id"),
      );
    }

    return await this.dataSource.transaction(async (manager) => {
      const bundleRepo = manager.getRepository(BundleEntity);
      const itemEntity = manager.getRepository(BundleItemEntity);

      // 1. Restore product
      const product = await bundleRepo.findOne({
        where: { id, adminId },
      });

      if (!product) {
        throw new NotFoundException(
          this.translations.t("domains.bundles.not_found"),
        );
      }

      await bundleRepo.update(
        { id, adminId },
        {
          isActive: true,
          deactivatedAt: null,
        },
      );

      // 2. Restore only variants that were deleted with parent
      await itemEntity.update(
        {
          bundleId: id,
          adminId,
          deletdWithParent: true,
        },
        {
          isActive: true,
          deactivatedAt: null,
          deletdWithParent: false,
        },
      );
    });
  }

  // ✅ OPTIONAL helper: consume bundle stock (use it in invoices/orders)
  async consumeBundleStock(me: any, bundleSku: string, qty: number) {
    const adminId = tenantId(me);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new BadRequestException(
        this.translations.t("common.qty_must_be_positive"),
      );
    }

    const bundle = await this.getBySku(me, bundleSku);
    const items = bundle.items ?? [];

    // check availability
    for (const it of items) {
      const v = await this.pvRepo.findOne({
        where: { id: it.variantId, adminId } as any,
      });
      if (!v) {
        throw new BadRequestException(
          this.translations.t("domains.bundles.variant_not_found", {
            args: { variantId: it.variantId },
          }),
        );
      }

      const need = it.qty * qty;
      const available = await this.ordersService.calculateAvailableStock(
        v.stockOnHand ?? 0,
        v.reserved ?? 0,
        adminId,
      );
      if (available < need) {
        throw new BadRequestException(
          this.translations.t("domains.bundles.insufficient_stock", {
            args: { variantId: it.variantId },
          }),
        );
      }
    }

    // consume
    for (const it of items) {
      const v = await this.pvRepo.findOne({
        where: { id: it.variantId, adminId } as any,
      });
      const need = it.qty * qty;
      (v as any).stockOnHand = (v as any).stockOnHand - need;

      await this.pvRepo.save(v as any);
    }

    return { ok: true, bundleId: bundle.id };
  }
}
