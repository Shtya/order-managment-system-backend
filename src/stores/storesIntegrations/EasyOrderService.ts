import { Injectable, InternalServerErrorException, forwardRef, Inject, NotFoundException, UnauthorizedException, BadRequestException } from "@nestjs/common";
import { StoreEntity, StoreProvider, SyncStatus } from "entities/stores.entity";
import { ProductSyncStatus, ProductSyncStateEntity, ProductSyncAction } from "entities/product_sync_error.entity";
import { ProductSyncStateService } from "src/product-sync-state/product-sync-state.service";

import axios, { AxiosRequestConfig } from "axios";
import { BaseStoreProvider, WebhookOrderPayload, WebhookOrderUpdatePayload, UnifiedProductDto, UnifiedProductVariantDto, MappedProductDto } from "./BaseStoreProvider";
import { CategoryEntity } from "entities/categories.entity";
import { InjectRepository } from "@nestjs/typeorm";
import { StoresService } from "../stores.service";
import { EncryptionService } from "common/encryption.service";
import { EntityManager, MoreThan, Repository } from "typeorm";
import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";
import { v4 as uuidv4 } from 'uuid'; // You might need to install uuid: npm i uuid @types/uuid
import { OrderEntity, OrderStatus, OrderStatusEntity, PaymentMethod, PaymentStatus } from "entities/order.entity";
import { OrdersService } from "src/orders/services/orders.service";
import { RedisService } from "common/redis/RedisService";
import { ProductsService } from "src/products/products.service";
import { CategoriesService } from "src/category/category.service";
import { CreateProductDto, CreateSkuItemDto, UpsertProductSkusDto } from "dto/product.dto";
import { AppGateway } from "common/app.gateway";
import { NotificationService } from "src/notifications/notification.service";
import { NotificationType } from "entities/notifications.entity";


@Injectable()
export class EasyOrderService extends BaseStoreProvider {


    maxBundleItems?: number;

    supportBundle: boolean = false;
    code: StoreProvider = StoreProvider.EASYORDER;
    displayName: string = "EasyOrder";
    baseUrl: string = process.env.EASY_ORDER_BASE_URL || "https://api.easy-orders.net/api/v1/external-apps";
    constructor(
        @InjectRepository(StoreEntity) protected readonly storesRepo: Repository<StoreEntity>,
        @InjectRepository(OrderStatusEntity) protected readonly statusRepo: Repository<OrderStatusEntity>,
        @InjectRepository(CategoryEntity) protected readonly categoryRepo: Repository<CategoryEntity>,
        @InjectRepository(ProductEntity) protected readonly productsRepo: Repository<ProductEntity>,
        @InjectRepository(ProductVariantEntity) protected readonly pvRepo: Repository<ProductVariantEntity>,
        @InjectRepository(ProductSyncStateEntity) protected readonly productSyncStateRepo: Repository<ProductSyncStateEntity>,
        private readonly notificationService: NotificationService,
        @Inject(forwardRef(() => StoresService))
        protected readonly mainStoresService: StoresService,
        @Inject(forwardRef(() => OrdersService))
        protected readonly ordersService: OrdersService,
        @Inject(forwardRef(() => ProductsService))
        private readonly productsService: ProductsService,
        @Inject(forwardRef(() => CategoriesService))
        private readonly categoriesService: CategoriesService,
        private readonly productSyncStateService: ProductSyncStateService,
        protected readonly redisService: RedisService,
        protected readonly encryptionService: EncryptionService,
        private readonly appGateway: AppGateway,
    ) {
        super(storesRepo, categoryRepo, productSyncStateRepo, encryptionService, mainStoresService, 40, StoreProvider.EASYORDER)
    }


    /**
     * Helpers
     */
    private async getHeaders(store: StoreEntity) {
        // const cacheKey = `store_auth:${store.id}`;

        // 1. Try to get from Redis
        // let apiKey = await this.redisService.get(cacheKey);

        // if (!apiKey) {
        // 2. Cache miss: Decrypt and save to Redis with a TTL (e.g., 1 hour)
        const keys = store?.credentials;

        if (!keys.apiKey) {
            throw new InternalServerErrorException(`Missing API Key for store ${store.name}`);
        }

        const apiKey = keys.apiKey?.trim(); // Applying your trim preference

        // Save to Redis for 3600 seconds (1 hour)
        //     await this.redisService.set(cacheKey, apiKey, 3600);
        // }

        return {
            "Api-Key": apiKey,
            "Content-Type": "application/json",
        };
    }

    protected async sendRequest(
        store: StoreEntity,
        config: AxiosRequestConfig,
        attempt = 0,
        retry = true
    ): Promise<any> {
        const headers = await this.getHeaders(store); // ✅ await here
        const baseConfig: AxiosRequestConfig = {
            ...config,
            headers: { ...headers, ...config.headers },
        };
        return await super.sendRequest(store, baseConfig, attempt, retry); // ✅ return + await
    }



    private async getStoreForSync(adminId: string): Promise<StoreEntity | null> {
        const cleanAdminId = adminId; // Remember to trim
        if (!cleanAdminId) return null;

        const store = await this.storesRepo.findOne({
            where: {
                adminId: cleanAdminId,
                provider: StoreProvider.EASYORDER,
                isActive: true // Only sync to active store
            },
        });
        return store;
    }

    // ===========================================================================
    // SYNC CATEGORY METHODS
    // ===========================================================================
    private async createCategory(category: CategoryEntity, store: StoreEntity) {

        const payload = {
            name: category.name?.trim(), // Remember to trim
            slug: category.slug,
            thumb: this.getImageUrl(category.image?.trim() || `/uploads/default-category.png`),
            show_in_header: false,
            hidden: false,
            position: 1,
            parent_id: null
        };

        const response = await this.sendRequest(store, {
            method: 'POST',
            url: '/categories',
            data: payload
        });
        return response.data;
    }

    private async updateCategory(category: CategoryEntity, store: StoreEntity, externalId) {
        if (!externalId) {
            this.logCtxWarn(`[Category] Skipping update: No external ID provided for category ${category.name}`, store);
            return;
        }

        const payload = {
            name: category.name?.trim(),
            slug: category.slug,
            thumb: this.getImageUrl(category.image?.trim() || `/uploads/default-category.png`),
            show_in_header: false,
            hidden: false,
            position: 1,
            parent_id: null
        };


        const response = await this.sendRequest(store, {
            method: 'PATCH',
            url: `/categories/${externalId}`,
            data: payload
        });

        return response;
    }

    private async getCategory(externalCategoryId: string, store: StoreEntity) {
        const response = await this.sendRequest(store, {
            method: 'GET',
            url: `/categories/${externalCategoryId}`,
        });

        return response;

    }
    /**
     * Fetches all categories with optional filtering.
     * * Operators:
     * - eq      (Equal)               ['name||eq||iphone']
     * - ne      (Not Equal)           ['quantity||ne||0']
     * - gt/lt   (Greater/Less)        ['price||gt||100']
     * - gte/lte (Greater/Less Equal)  ['price||lte||150']
     * - $in     (In list)             ['status||$in||active,pending']
     * - cont    (Contains)            ['name||cont||iphone']
     * - isnull  (Is Null)             ['parent_id||isnull']
     * - notnull (Is Not Null)         ['description||notnull']
     * * Example: getAllCategories(store, ['parent_id||isnull', 'hidden||eq||false'])
     */
    private async getAllCategories(store: StoreEntity, filters: string[] = []) {
        const filterStr = filters.length > 0 ? ` with filters: [${filters.join(', ')}]` : '';


        const response = await this.sendRequest(store, {
            method: 'GET',
            url: '/categories/',
            params: {
                filter: filters
            },
            // Custom serializer to ensure the format filter=val1&filter=val2 
            // instead of the default filter[]=val1
            paramsSerializer: {
                indexes: null // removes the brackets [] from the query key
            }
        });

        return response;

    }

    public async syncCategory({ category, relatedAdminId, slug }: { category: CategoryEntity, relatedAdminId?: string, slug?: string }) {
        const { adminId } = category;

        const finalAdmin = relatedAdminId ? relatedAdminId : adminId;
        // 1. Fetch only what we need
        const activeStore = await this.getStoreForSync(finalAdmin)

        if (!activeStore) {
            throw new Error(`No active store enabled for admin (${finalAdmin})`);
        }

        const checkSlug = slug ? slug : category.slug;
        const searchFilters = [`slug||eq||${checkSlug?.trim()}`];
        const existingCategories = await this.getAllCategories(activeStore, searchFilters);

        const remoteCategory = existingCategories?.length > 0 ? existingCategories[0] : null;

        if (remoteCategory) {
            return await this.updateCategory(category, activeStore, remoteCategory.id);
        }
        else {
            return await this.createCategory(category, activeStore);
        }
    }

    /**
 * Sync Categories: Fetch 30 by 30 using ID as cursor
 */
    private async syncCategoriesCursor(store: StoreEntity): Promise<Map<string, string>> {

        const categoryMap = new Map<string, string>();
        let lastId = "";
        let hasMore = true;
        let totalProcessed = 0;
        let totalCreated = 0;
        let totalUpdated = 0;

        while (hasMore) {
            const localBatch = await this.categoryRepo.find({
                where: {
                    adminId: store.adminId,
                    ...(lastId ? { id: MoreThan(lastId) } : {})
                },
                order: { id: 'ASC' } as any,
                take: 30
            });

            if (localBatch.length === 0) {
                hasMore = false;
                break;
            }

            // Bulk check existence: Use names for categories as they are unique identifiers in EasyOrder
            const slugs = localBatch.map(c => c.slug).join(',');
            const remoteItems = await this.getAllCategories(store, [`slug||$in||${slugs}`]);
            const remoteMap = new Map(remoteItems.map((r: any) => [r.slug?.trim(), r.id]));

            for (const cat of localBatch) {
                let extId = remoteMap.get(cat.slug?.trim());

                try {
                    const response = extId
                        ? await this.updateCategory(cat, store, extId)
                        : await this.createCategory(cat, store);

                    const finalId = extId ? String(extId) : String(response.id);
                    categoryMap.set(cat.id, finalId);

                    if (extId) {
                        totalUpdated++;
                    } else {
                        totalCreated++;
                    }
                } catch (error) {
                    const message = this.getErrorMessage(error);
                    this.logCtxError(`[Sync] Error processing category ${cat.name} (ID: ${cat.id}): ${message}`, store);
                }

                totalProcessed++;
            }

            lastId = localBatch[localBatch.length - 1].id;
        }

        this.logCtx(`[Sync] ✓ Category sync completed | Total: ${totalProcessed} | Created: ${totalCreated} | Updated: ${totalUpdated}`, store);
        return categoryMap;
    }

    public async syncExternalCategory(user: any, remoteCategory: any, manager?: EntityManager): Promise<string | null> {
        if (!remoteCategory || !remoteCategory.slug) return null;

        // Check if category exists locally by slug
        const categoryRepo = manager ? manager.getRepository(CategoryEntity) : this.categoryRepo;
        let category = await categoryRepo.findOne({
            where: { adminId: user.adminId, slug: remoteCategory.slug }
        });

        if (!category) {
            let newCategory = await this.categoriesService.create(user, {
                name: remoteCategory.name || remoteCategory.slug,
                slug: remoteCategory.slug,
                image: remoteCategory.thumb || null
            });

            return newCategory?.[0].id
        }
        return category.id;
    }


    // ===========================================================================
    // SYNC PRODUCT METHODS
    // ===========================================================================
    /**
     * Maps your ProductEntity to the complex EasyOrder JSON format.
     * Automatically extracts "variations" (definitions) from your variants.
     */
    private async mapProductToPayload(product: ProductEntity, variants: ProductVariantEntity[], store: StoreEntity, externaCategoryId: string) {
        let categoryPayload = [];

        if (externaCategoryId) {
            categoryPayload.push({ id: String(externaCategoryId)?.trim() })
        }
        const activeVariants = variants.filter(v => v.isActive);
        const variationMap = new Map<string, Set<string>>();

        activeVariants.forEach(v => {
            if (v.attributes) {
                Object.entries(v.attributes).forEach(([key, value]) => {
                    if (!variationMap.has(key)) variationMap.set(key, new Set());
                    variationMap.get(key)?.add(String(value));
                });
            }
        });

        const variationsDef = Array.from(variationMap.entries()).map(([name, values]) => {
            const variationId = uuidv4();
            return {
                id: variationId,
                name: name?.trim(),
                product_id: null,
                type: "dropdown",
                props: Array.from(values).map(val => ({
                    id: uuidv4(),
                    name: val?.trim(),
                    variation_id: variationId,
                    value: val?.trim()
                }))
            };
        });

        let productQuantity = 0;
        const variantsPayload = activeVariants.map(v => {
            productQuantity += (v.stockOnHand - v.reserved);
            return {
                price: Number(v.price) || Number(product.salePrice) || 0,
                expense: Number(product.wholesalePrice) || 0,
                quantity: v.stockOnHand - v.reserved,
                taager_code: String(v.sku),
                variation_props: Object.entries(v.attributes || {}).map(([key, val]) => ({
                    variation: key?.trim(),
                    variation_prop: String(val)?.trim()
                }))
            };
        });

        return {
            name: product.name?.trim(),
            price: Number(product.salePrice) || 0,
            expense: Number(product.wholesalePrice) || 0,
            // sale_price: Number(product.salePrice) || 0,
            description: product.description || "",
            slug: product.slug,
            sku: `SKU-${product.slug.toUpperCase().replace(/-/g, '').substring(0, 8)}-${product.id}`?.trim(),
            thumb: this.getImageUrl(product.mainImage?.trim() || ""),
            images: product.images?.map(img => this.getImageUrl(img.url?.trim())) || [],
            categories: categoryPayload,
            quantity: productQuantity,
            track_stock: true,
            disable_orders_for_no_stock: true,
            // buy_now_text: "اضغط هنا للشراء",
            is_reviews_enabled: true,
            taager_code: String(product.id),
            // drop_shipping_provider: "MyStore",
            variations: variationsDef,
            variants: variantsPayload
        };
    }

    private async syncVariantsBySku(
        localVariants: ProductVariantEntity[],
        remoteVariants: any[],
        store: StoreEntity,
    ): Promise<void> {
        if (!remoteVariants?.length) return;

        // 1️⃣ Build local map by SKU
        const localMap = new Map<string, ProductVariantEntity>();

        for (const local of localVariants) {
            if (!local.sku) continue;
            localMap.set(local.sku?.trim(), local);
        }

        const variantsToSave: ProductVariantEntity[] = [];

        // 2️⃣ Match remote → local
        for (const remote of remoteVariants) {
            const sku = remote.taager_code?.trim();

            if (!sku) {
                this.logCtxError(
                    `[Variants Sync] Remote variant missing taager_code`,
                    store,
                );
                continue;
            }

            const localVariant = localMap.get(sku);

            if (!localVariant) {
                this.logCtxError(
                    `[Variants Sync] No local variant found for SKU ${sku}`,
                    store,
                );
                continue;
            }

            // 3️⃣ Update external ID
            localVariant.externalId = remote.id;

            variantsToSave.push(localVariant);
        }

        // 4️⃣ Save in one DB call (important)
        if (variantsToSave.length) {
            await this.pvRepo.save(variantsToSave);
        }
    }


    private async createProduct(product: ProductEntity, variants: ProductVariantEntity[], store: StoreEntity, externalCategoryId: string) {

        const payload = await this.mapProductToPayload(product, variants, store, externalCategoryId);

        const response = await this.sendRequest(store, {
            method: 'POST',
            url: '/products',
            data: payload
        });
        const externalId = response.data?.id;
        const remoteVariants = response.variants;
        await this.syncVariantsBySku(
            variants,
            remoteVariants,
            store
        );

        return { response, externalId, payload };
    }

    private async updateProduct(product: ProductEntity, variants: ProductVariantEntity[], store: StoreEntity, externalId: string, externalCategoryId: string) {

        const payload = await this.mapProductToPayload(product, variants, store, externalCategoryId);

        const response = await this.sendRequest(store, {
            method: 'PATCH',
            url: `/products/${externalId}`,
            data: payload
        });
        const remoteVariants = response.variants;
        await this.syncVariantsBySku(
            variants,
            remoteVariants,
            store
        );

        return { response, externalId, payload };
    }

    // SYNC STOCK ONLY (Efficient)
    /**
     * Updates the quantity of a specific variant.
     */
    async updateVariantStock(productInternalId: string, variantInternalId: string, quantity: number, store: StoreEntity) {
        const safeQuantity = Math.max(0, quantity);
        const url = `/products/variants/${productInternalId}/${variantInternalId}/quantity`;

        await this.sendRequest(store, {
            method: 'PATCH',
            url: url,
            data: { quantity: safeQuantity } // Ensure no negative stock
        });


    }

    /**
     * Fetches all categories with optional filtering.
     * * Operators:
     * - eq      (Equal)               ['name||eq||iphone']
     * - ne      (Not Equal)           ['quantity||ne||0']
     * - gt/lt   (Greater/Less)        ['price||gt||100']
     * - gte/lte (Greater/Less Equal)  ['price||lte||150']
     * - $in     (In list)             ['status||$in||active,pending']
     * - cont    (Contains)            ['name||cont||iphone']
     * - isnull  (Is Null)             ['parent_id||isnull']
     * - notnull (Is Not Null)         ['description||notnull']
     * * Example: getAllProducts(store, ['parent_id||isnull', 'hidden||eq||false'])
     */
    private async getAllProducts(store: StoreEntity, filters: string[] = [], retry = true) {
        const filterStr = filters.length > 0 ? ` with filters: [${filters.join(', ')}]` : '';

        const response = await this.sendRequest(store, {
            method: 'GET',
            url: '/products/',
            params: {
                filter: filters
            },
            // Custom serializer to ensure the format filter=val1&filter=val2 
            // instead of the default filter[]=val1
            paramsSerializer: {
                indexes: null // removes the brackets [] from the query key
            }
        }, 0, retry);
        return response;

    }

    private async getProduct(store: StoreEntity, remoteProductId: string) {
        try {
            return await this.sendRequest(store, {
                method: 'GET',
                url: `/products/${remoteProductId}`,
            });
        } catch (error) {
            return null;
        }
    }

    /**
     * Sync Products: Fetch 20 by 20 with Variants
     */
    private async syncProductsCursor(store: StoreEntity, categoryMap: Map<string, string>) {


        let lastId = "";
        let hasMore = true;
        let totalProcessed = 0;
        let totalCreated = 0;
        let totalUpdated = 0;
        let totalErrors = 0;

        while (hasMore) {
            const qb = this.storesRepo.manager.createQueryBuilder(ProductEntity, "product")
                .leftJoinAndSelect("product.variants", "variants")
                .leftJoinAndSelect("product.category", "category")
                .leftJoinAndMapOne(
                    "product.syncState",
                    ProductSyncStateEntity,
                    "syncState",
                    "syncState.productId = product.id AND syncState.storeId = :storeId AND syncState.adminId = :adminId AND syncState.externalStoreId = :externalStoreId",
                    { storeId: store.id, adminId: store.adminId, externalStoreId: store.externalStoreId }
                )
                .where("product.storeId = :storeId", { storeId: store.id })
                .andWhere("product.adminId = :adminId", { adminId: store.adminId })
                .orderBy("product.id", "ASC")
                .take(20);

            if (lastId) {
                qb.andWhere("product.id > :lastId", { lastId });
            }

            const localBatch = await qb.getMany() as any[];

            if (localBatch.length === 0) {
                hasMore = false;
                break;
            }

            // Bulk check existence: Use slug 
            const ids = localBatch.map(p => p.syncState?.remoteProductId).filter(Boolean).join(',');
            const remoteItems = ids ? await this.getAllProducts(store, [`id||$in||${ids}`]) : [];
            const remoteMap = new Map<string, any>(remoteItems.map((r: any) => [String(r.id), r]));

            for (const product of localBatch) {
                try {
                    if (!product.isActive) continue;
                    const remoteId = product?.syncState?.remoteProductId;
                    const remote = remoteId ? remoteMap.get(String(remoteId)) : null;

                    let extCatId = product.categoryId ? categoryMap.get(product.categoryId) : null;

                    if (!extCatId && product.category) {
                        const remoteCategory = await this.syncCategory({ relatedAdminId: product.adminId, category: product.category });
                        extCatId = remoteCategory?.id;
                    }

                    if (remote) {
                        const result = await this.updateProduct(product, product.variants, store, remote.id, extCatId);

                        // SUCCESS STATE UPDATE
                        await this.productSyncStateService.upsertSyncState(
                            { adminId: store.adminId, productId: product.id, storeId: store.id, externalStoreId: store.externalStoreId },
                            {
                                remoteProductId: result.externalId,
                                status: ProductSyncStatus.SYNCED,
                                lastError: null,
                                lastSynced_at: new Date(),
                            },
                        );

                        totalUpdated++;
                    } else {
                        const result = await this.createProduct(product, product.variants, store, extCatId);

                        // SUCCESS STATE UPDATE
                        await this.productSyncStateService.upsertSyncState(
                            { adminId: store.adminId, productId: product.id, storeId: store.id, externalStoreId: store.externalStoreId },
                            {
                                remoteProductId: result.externalId,
                                status: ProductSyncStatus.SYNCED,
                                lastError: null,
                                lastSynced_at: new Date(),
                            },
                        );

                        totalCreated++;
                    }
                    totalProcessed++;
                } catch (error: any) {
                    const errorMessage = this.getErrorMessage(error);
                    const remoteId = product?.syncState?.remoteProductId;
                    const action = remoteId ? ProductSyncAction.UPDATE : ProductSyncAction.CREATE;

                    // FAILURE STATE UPDATE
                    await this.productSyncStateService.upsertSyncState(
                        { adminId: store.adminId, productId: product.id, storeId: store.id, externalStoreId: store.externalStoreId },
                        {
                            remoteProductId: remoteId || null,
                            status: ProductSyncStatus.FAILED,
                            lastError: errorMessage,
                            lastSynced_at: new Date(),
                        },
                    );

                    // LOG THE ERROR
                    await this.productSyncStateService.upsertSyncErrorLog(
                        { adminId: store.adminId, productId: product.id, storeId: store.id },
                        {
                            remoteProductId: remoteId || null,
                            action: action,
                            errorMessage,
                            userMessage: `Failed to sync product "${product.name}" to ${store.name}: ${errorMessage}`,
                            responseStatus: error?.response?.status,
                            requestPayload: error?.config?.data ? JSON.parse(error.config.data) : null
                        }
                    );

                    this.logCtxError(`[Sync] Error processing product ${product.name} (ID: ${product.id}): ${errorMessage}`, store);
                    totalErrors++;
                }

            }

            lastId = localBatch[localBatch.length - 1].id;
        }

        this.logCtx(`[Sync] ✓ Product sync completed | Total: ${totalProcessed} | Created: ${totalCreated} | Updated: ${totalUpdated} | Errors: ${totalErrors}`, store);
    }
    private async syncExternalProductToLocal(adminId: string, store: StoreEntity, remoteProduct: any, manager: EntityManager): Promise<ProductEntity> {

        // A. Fetch Full Details from External API

        const userContext = {
            id: store.adminId, // Owner ID
            adminId: store.adminId,
            role: { name: 'admin' }
        };

        let combinations: CreateSkuItemDto[] = [];

        if (remoteProduct.variants && remoteProduct.variants.length > 0) {
            // Case A: Variable Product
            combinations = remoteProduct.variants.map((v: any) => {
                const atts = v.variation_props?.reduce((acc, p) => ({ ...acc, [p.variation]: p.variation_prop }), {}) || {};
                const sku = v.sku || v.taager_code || null;
                // Generate key from attributes; if empty, use SKU as fallback key
                let key = this.productsService.canonicalKey(atts);
                if (!key && sku) {
                    key = sku;
                } else if (!key) {
                    key = `variant_${remoteProduct.id}_${remoteProduct.variants.indexOf(v)}`;
                }
                return {
                    sku,
                    price: v.price,
                    stockOnHand: v.quantity || 0,
                    attributes: atts,
                    key

                }
            });
        } else {
            // Case B: Simple Product (No variants in EasyOrder)
            // ✅ Create one variant using the main product's info
            const sku = remoteProduct.sku || remoteProduct.taager_code || null;
            // If no SKU, use product slug as key
            const key = sku || `simple_${remoteProduct.id}`;
            combinations = [{
                sku,
                price: remoteProduct.price,
                stockOnHand: remoteProduct.quantity || 0,
                attributes: {},
                // key
            }];
        }

        const localCategoryId = await this.syncExternalCategory(userContext, remoteProduct.category, manager);
        // B. Map Remote Data to DTO
        const productDto: CreateProductDto = {
            name: remoteProduct.name,
            slug: remoteProduct.slug, // Crucial for matching
            description: remoteProduct.description,
            wholesalePrice: remoteProduct.price,
            salePrice: remoteProduct.sale_price || remoteProduct.price,
            lowestPrice: remoteProduct.price || remoteProduct.price,
            storeId: store.id,
            categoryId: localCategoryId,
            mainImage: remoteProduct.thumb || remoteProduct.images?.[0] || "",
            images: (remoteProduct.images || []).map(url => ({ url })),
            combinations,
            upsellingEnabled: false,

        };

        const productsRepository = manager.getRepository(ProductEntity);
        const existingProduct = await productsRepository.findOne({
            where: { adminId, slug: productDto.slug }
        });

        let savedProduct: ProductEntity;

        if (existingProduct) {
            this.logger.log(`[Reverse Sync] Updating existing product: ${existingProduct.slug}`);

            // Merge updated data using manager
            manager.merge(ProductEntity, existingProduct, {
                name: productDto.name,
                slug: productDto.slug,
                description: productDto.description,
                wholesalePrice: productDto.wholesalePrice,
                salePrice: productDto.salePrice,
                lowestPrice: productDto.lowestPrice,
                storeId: productDto.storeId,
                categoryId: productDto.categoryId,
                mainImage: productDto.mainImage
            });
            savedProduct = await productsRepository.save(existingProduct);


            if (productDto.combinations && productDto.combinations.length > 0) {
                const upsertDto: UpsertProductSkusDto = {
                    items: productDto.combinations.map(c => ({
                        ...c,
                        // key: c.key || this.productsService.canonicalKey(c.attributes || {}) // Access private helper or rely on logic
                    })) as any
                };

                await this.productsService.upsertSkus(userContext, savedProduct.id, upsertDto);
            }

        } else {
            this.logger.log(`[Reverse Sync] Creating new product: ${productDto.slug}`);
            // Create product entity using manager
            const newProduct = manager.create(ProductEntity, {
                name: productDto.name,
                slug: productDto.slug,
                description: productDto.description,
                wholesalePrice: productDto.wholesalePrice,
                salePrice: productDto.salePrice,
                lowestPrice: productDto.lowestPrice,
                storeId: productDto.storeId,
                categoryId: productDto.categoryId,
                mainImage: productDto.mainImage,
                adminId: adminId
            });
            savedProduct = await productsRepository.save(newProduct);
        }

        return savedProduct;
    }

    private mapRemoteProductToUnified(remoteProduct: any): UnifiedProductDto {
        let variants: UnifiedProductVariantDto[] = [];

        if (remoteProduct.variants && remoteProduct.variants.length > 0) {
            variants = remoteProduct.variants.map((v: any, index: number) => {
                const attributes =
                    v.variation_props?.reduce(
                        (acc: Record<string, string>, p: any) => ({
                            ...acc,
                            [p.variation]: p.variation_prop,
                        }),
                        {},
                    ) || {};

                const sku = v.sku || v.taager_code || null;
                let key = this.productsService.canonicalKey(attributes);
                if (!key && sku) {
                    key = sku;
                } else if (!key) {
                    key = `variant_${remoteProduct.slug}_${index}`;
                }

                return {
                    sku,
                    price: v.price,
                    stockOnHand: v.quantity || 0,
                    attributes,
                    key,
                };
            });
        } else {
            const rawSku = remoteProduct.sku || remoteProduct.taager_code || null;
            const cleanSlug = remoteProduct.slug?.trim();
            const key = cleanSlug || `simple_${remoteProduct.slug}`;

            variants = [
                {
                    sku: cleanSlug,
                    price: remoteProduct.price,
                    stockOnHand: remoteProduct.quantity || 0,
                    attributes: {},
                    key,
                },
            ];
        }

        const images: string[] = (remoteProduct.images || []).map((url: string) => url);

        const category = remoteProduct.category
            ? {
                slug: remoteProduct.category.slug,
                name: remoteProduct.category.name || remoteProduct.category.slug,
                thumb: remoteProduct.category.thumb || null,
            }
            : null;

        return {
            externalId: remoteProduct.id ? String(remoteProduct.id) : undefined,
            name: remoteProduct.name,
            slug: remoteProduct.slug,
            description: remoteProduct.description,
            basePrice: remoteProduct.price,
            mainImage: remoteProduct.thumb || images[0] || "",
            images,
            category,
            variants,
        };
    }

    // ===========================================================================
    // SYNC ORDER METHODS
    // ===========================================================================
    /**
    * Fetches order details from EasyOrder API
    */
    public async getOrderDetails(externalOrderId: string, store: StoreEntity) {
        return await this.sendRequest(store, {
            method: 'GET',
            url: `/orders/${externalOrderId}`,
        });
    }

    /**
     * Updates the status of an order on EasyOrder
     */
    public async updateOrderStatus(order: OrderEntity, store: StoreEntity) {
        if (!order.externalId) return;

        const remoteStatus = this.mapInternalStatusToExternal(order.status.code as OrderStatus);
        if (!remoteStatus) {
            this.logger.warn(`No status mapping found for order (${order.id}) | admin (${order.adminId}) | local status: ${order.status}`);
            return;
        }


        return await this.sendRequest(store, {
            method: 'PATCH',
            url: `/orders/${order.externalId}/status`,
            data: { status: remoteStatus }
        });

    }

    // ===========================================================================
    // MAIN ENTRY POINTS FOR SYNC
    // ===========================================================================
    public async syncProduct({ productId }: { productId: string }) {
        const product = await this.productsRepo.findOne({
            where: { id: productId },
            relations: ['category', 'store']
        });

        if (!product) {
            throw new Error(`Product with ID ${productId} not found`);
        }

        // 2️⃣ جلب الـ Variants الخاصة بالمنتج
        const variants = await this.pvRepo.find({
            where: { productId: product.id }
        });


        // 1. Validate Store
        // if (!product.store || product.store.provider !== StoreProvider.EASYORDER) {
        //     this.logCtxWarn(`[Sync] Skipping sync: Store not found or provider is not EASYORDER`, null, product.adminId);
        //     return;
        // }
        const productSyncState = await this.productSyncStateRepo.findOne({
            where: {
                productId: productId,
                storeId: product.store.id,
                adminId: product.adminId,
                externalStoreId: product?.store?.externalStoreId
            }
        });
        const activeStore = await this.getStoreForSync(product.adminId);

        if (!activeStore) {
            throw new Error(`No active store enabled for admin (${product.adminId})`);
        }

        // 2. ⚡ RESOLVE CATEGORY ID ⚡
        let easyOrderCategory = null;
        if (product.category) {
            easyOrderCategory = await this.syncCategory({ category: product.category, slug: product.category.slug, relatedAdminId: product.adminId });
        }

        const externalId = productSyncState?.remoteProductId;
        const action = externalId ? ProductSyncAction.UPDATE : ProductSyncAction.CREATE;

        try {
            let result;
            if (externalId) {
                const remoteProduct = await this.getProduct(activeStore, externalId);
                if (remoteProduct) {
                    result = await this.updateProduct(product, variants, activeStore, externalId, easyOrderCategory?.id);
                } else {
                    result = await this.createProduct(product, variants, activeStore, easyOrderCategory?.id);
                }
            } else {
                result = await this.createProduct(product, variants, activeStore, easyOrderCategory?.id);
            }

            // SUCCESS STATE UPDATE
            await this.productSyncStateService.upsertSyncState(
                { adminId: activeStore.adminId, productId: product.id, storeId: activeStore.id, externalStoreId: activeStore.externalStoreId },
                {
                    remoteProductId: result.externalId,
                    status: ProductSyncStatus.SYNCED,
                    lastError: null,
                    lastSynced_at: new Date(),
                },
            );

            return result.response;

        } catch (error: any) {
            const errorMessage = this.getErrorMessage(error);

            // FAILURE STATE UPDATE
            await this.productSyncStateService.upsertSyncState(
                { adminId: activeStore.adminId, productId: product.id, storeId: activeStore.id, externalStoreId: activeStore.externalStoreId },
                {
                    remoteProductId: externalId || null,
                    status: ProductSyncStatus.FAILED,
                    lastError: errorMessage,
                    lastSynced_at: new Date(),
                },
            );

            // LOG THE ERROR
            await this.productSyncStateService.upsertSyncErrorLog(
                { adminId: activeStore.adminId, productId: product.id, storeId: activeStore.id },
                {
                    remoteProductId: externalId || null,
                    action: action,
                    errorMessage,
                    userMessage: `Failed to sync product "${product.name}" to ${activeStore.name}: ${errorMessage}`,
                    responseStatus: error?.response?.status,
                    requestPayload: error?.config?.data ? JSON.parse(error.config.data) : null
                }
            );


            throw error;
        }
    }
    /**
     * Reusable helper to fetch a single remote product from Easy Order using filters.
     */
    private async fetchRemoteProductBySlug(store: StoreEntity, slug: string, retry = true): Promise<any | null> {
        const cleanSlug = slug?.trim();
        const searchFilters = [`slug||eq||${cleanSlug}`];

        const existingProducts = await this.getAllProducts(store, searchFilters, retry);
        return existingProducts?.length > 0 ? existingProducts[0] : null;
    }

    /**
     * Main entry point for syncing order status to all applicable stores
     */
    public async syncOrderStatus(order: OrderEntity) {


        const store = await this.getStoreForSync(order.adminId);
        if (!store) {
            throw new Error(`No active store enabled for admin (${order.adminId})`);
        }

        await this.updateOrderStatus(order, store);
    }

    /**
    * Main entry point for full store synchronization using Cursor Pagination
    */
    public async syncFullStore(store: StoreEntity) {
        if (!store || !store.isActive) {
            throw new Error(`Store is inactive or null`);
        }

        if (store.syncStatus === SyncStatus.SYNCING) {
            throw new Error(`Store is already syncing. Skipping.`);
        }

        try {

            await this.storesRepo.update(store.id, {
                syncStatus: SyncStatus.SYNCING,
                lastSyncAttemptAt: new Date()
            });

            // 1. Sync Categories with Cursor (Batch 30)
            const categoryMap = await this.syncCategoriesCursor(store);

            // 2. Sync Products with Cursor (Batch 20)
            await this.syncProductsCursor(store, categoryMap);

            await this.storesRepo.update(store.id, {
                syncStatus: SyncStatus.SYNCED,
            });

            // Notify admin via websocket about the new sync status
            if (store.adminId) {
                this.appGateway.emitStoreSyncStatus(String(store.adminId), {
                    storeId: store.id,
                    provider: store.provider,
                    status: SyncStatus.SYNCED,
                });
            }
        } catch (error) {
            await this.storesRepo.update(store.id, {
                syncStatus: SyncStatus.FAILED,
            });

            if (store.adminId) {
                this.appGateway.emitStoreSyncStatus(String(store.adminId), {
                    storeId: store.id,
                    provider: store.provider,
                    status: SyncStatus.FAILED,
                });
            }
            throw error;
        }
    }


    // ===========================================================================
    // WEBHOOK
    // ===========================================================================
    private mapPaymentMethod(method: string): PaymentMethod {
        switch (method?.toLowerCase()) {
            case 'cod': return PaymentMethod.CASH_ON_DELIVERY;
            case 'card': return PaymentMethod.CARD;
            case 'cash': return PaymentMethod.CASH;
            default: return PaymentMethod.UNKNOWN;
        }
    }



    private mapExternalStatusToInternal(externalStatus: string): {
        orderStatus: OrderStatus | null;
        paymentStatus: PaymentStatus | null;
    } {
        const map: Record<string, {
            orderStatus: OrderStatus | null;
            paymentStatus: PaymentStatus | null;
        }> = {

            // 🟡 Order lifecycle
            "pending": {
                orderStatus: OrderStatus.NEW,
                paymentStatus: null,
            },
            "confirmed": {
                orderStatus: OrderStatus.CONFIRMED,
                paymentStatus: null,
            },
            "processing": {
                orderStatus: OrderStatus.PREPARING,
                paymentStatus: null,
            },
            "waiting_for_pickup": {
                orderStatus: OrderStatus.READY,
                paymentStatus: null,
            },
            "in_delivery": {
                orderStatus: OrderStatus.SHIPPED,
                paymentStatus: null,
            },
            "delivered": {
                orderStatus: OrderStatus.DELIVERED,
                paymentStatus: null,
            },
            "canceled": {
                orderStatus: OrderStatus.CANCELLED,
                paymentStatus: null,
            },
            "returning_from_delivery": {
                orderStatus: OrderStatus.RETURNED,
                paymentStatus: null,
            },
            "refunded": {
                orderStatus: OrderStatus.RETURNED,
                paymentStatus: PaymentStatus.REFUNDED,
            },

            // 💰 Payment states
            "paid": {
                orderStatus: null,
                paymentStatus: PaymentStatus.PAID,
            },
            "unpaid": {
                orderStatus: null,
                paymentStatus: PaymentStatus.PENDING,
            },
            "paid_pending": {
                orderStatus: null,
                paymentStatus: PaymentStatus.PENDING,
            },

            // 🔴 Optional edge cases
            "paid_failed": {
                orderStatus: null,
                paymentStatus: PaymentStatus.PENDING,
            },
        };

        return map[externalStatus] || {
            orderStatus: null,
            paymentStatus: null,
        };
    }

    /**
     * Maps your Internal OrderStatus enum to EasyOrder (External) status strings.
     */
    private mapInternalStatusToExternal(internalStatus: OrderStatus): string | null {
        const map: Record<OrderStatus, string> = {
            // المرحلة الابتدائية والتدقيق (تعتبر pending خارجياً)
            [OrderStatus.NEW]: "pending",
            [OrderStatus.UNDER_REVIEW]: "pending",
            [OrderStatus.POSTPONED]: "pending",
            [OrderStatus.NO_ANSWER]: "pending",

            // مرحلة النجاح في التأكيد
            [OrderStatus.CONFIRMED]: "confirmed",

            // حالات الفشل في التأكيد (تعتبر إلغاء للطلب خارجياً)
            [OrderStatus.WRONG_NUMBER]: "canceled",
            [OrderStatus.OUT_OF_DELIVERY_AREA]: "canceled",
            [OrderStatus.DUPLICATE]: "canceled",

            // مرحلة التنفيذ والتوصيل
            [OrderStatus.PREPARING]: "processing",
            [OrderStatus.PRINTED]: "processing",
            [OrderStatus.DISTRIBUTED]: "processing",
            [OrderStatus.READY]: "waiting_for_pickup",
            [OrderStatus.PACKED]: "processing",
            [OrderStatus.SHIPPED]: "in_delivery",
            [OrderStatus.DELIVERED]: "delivered",

            // حالات الإغلاق
            [OrderStatus.FAILED_DELIVERY]: "cancelled",
            [OrderStatus.CANCELLED]: "canceled",
            [OrderStatus.REJECTED]: "canceled",

            [OrderStatus.RETURNED]: "returning_from_delivery",
            [OrderStatus.RETURN_PREPARING]: "returning_from_delivery",
        };
        return map[internalStatus] || null;
    }

    public verifyWebhookAuth(headers: Record<string, any>, body: any, store: StoreEntity, req?: any, action?: "create" | "update"): boolean {
        const incomingSecret = headers['secret'];
        const savedSecret = action === "create" ? store?.credentials?.webhookCreateOrderSecret : store?.credentials?.webhookUpdateStatusSecret;
        if (!savedSecret) {
            return true;
        }
        if (!incomingSecret || incomingSecret !== savedSecret) {
            return false;
        }
        return true;
    }
    public mapWebhookUpdate(body: any): WebhookOrderUpdatePayload {
        const externalStatus = body.new_status;
        const { orderStatus, paymentStatus } = this.mapExternalStatusToInternal(externalStatus);
        if (!orderStatus || !paymentStatus) {
            return null;
        }
        return {
            externalId: body.order_id,
            remoteStatus: externalStatus,
            mappedStatus: orderStatus,
            mappedPaymentStatus: paymentStatus
        };
    }
    public async mapWebhookCreate(body: any, store: StoreEntity): Promise<WebhookOrderPayload> {
        const { orderStatus, paymentStatus } = this.mapExternalStatusToInternal(body.status)
        return {
            externalOrderId: String(body.id),
            fullName: body.full_name,
            phone: body.phone,
            email: body.email,
            address: body.address,
            government: body.government || "Unknown",
            // Reuse your existing internal mapping logic for payment
            paymentMethod: this.mapPaymentMethod(body.payment_method),
            paymentStatus: paymentStatus || PaymentStatus.PENDING,
            status: orderStatus || OrderStatus.NEW,
            shippingCost: body.shipping_cost || 0,
            totalCost: body.total_cost,
            cartItems: (body.cart_items || []).map((item: any) => {
                const variationProps = (item.variant?.variation_props || []).map((p: any) => ({
                    name: p.variation?.trim(),
                    value: String(p.variation_prop)?.trim()
                }));

                const payloadAttrs: Record<string, string> = {};
                variationProps.forEach(prop => {
                    payloadAttrs[prop.name] = prop.value;
                });

                const attrs = (item.variant?.variation_props || []).reduce((acc: Record<string, string>, vp: any) => {
                    if (vp.variation && vp.variation_prop) {
                        const key = this.productsService.slugifyKey(vp.variation);
                        const value = this.productsService.slugifyKey(String(vp.variation_prop));
                        acc[key] = value;
                    }
                    return acc;
                }, {});


                const key = this.productsService.canonicalKey(attrs);

                return {
                    name: String(item.product?.name || item.product?.title),
                    productSlug: String(item.product?.slug),
                    quantity: Number(item.quantity),
                    price: Number(item.price),
                    remoteProductId: item.product_id,
                    variant: item.variant ? {
                        key,
                        variation_props: variationProps
                    } : undefined
                };
            })
        };
    }

    async validateProviderConnection(store: StoreEntity): Promise<boolean> {
        const apiKey = store?.credentials?.apiKey;
        if (!apiKey) return false;

        try {
            const response = await axios.get(`${this.baseUrl}/categories/`, {
                headers: {
                    "Api-Key": apiKey,
                    'Accept': 'application/json',
                },
                timeout: 5000, // 5 second timeout to keep the transaction fast
            });

            // If we get a 200-299 status, the key is valid
            return response.status >= 200 && response.status < 300;
        } catch (error: any) {
            // If the error is 401 (Unauthorized) or 403 (Forbidden), the credentials are wrong
            if (error.response?.status === 401 || error.response?.status === 403) {
                return false;
            }
            const message = this.getErrorMessage(error);
            // For other errors (network, 500), you might want to throw or log
            this.logger.error(`EasyOrder connection check failed: ${message}`);
            return false;
        }
    }


    public async syncProductsFromProvider(store: StoreEntity, slugs?: string[], manager?: any): Promise<void> {
        const adminId = store.adminId;

        if (!slugs || slugs.length === 0) {
            throw new Error("No slugs provided to sync for store.");
        }

        for (const slug of slugs) {
            try {
                // 1. Fetch one by one using our helper
                const remoteProduct = await this.fetchRemoteProductBySlug(store, slug);

                if (!remoteProduct) {
                    continue;
                }

                // 2. Map to unified payload and delegate to shared sync logic
                const unified = this.mapRemoteProductToUnified(remoteProduct);
                await this.mainStoresService.syncExternalProductPayloadToLocal(adminId, store, unified, manager);
            } catch (error) {
                const message = this.getErrorMessage(error);
                this.logger.error(`[Reverse Sync] Error syncing slug ${slug}: ${message}`);
            }
        }
    }


    public async cancelIntegration(adminId: string): Promise<boolean> {
        const store = await this.storesRepo.findOne({
            where: {
                adminId,
                provider: StoreProvider.EASYORDER,
            }
        });

        // 1. Basic Validation
        if (!store || !store?.credentials?.apiKey) {
            // If no store or no API key, just remove local record if it exists
            if (store) await this.storesRepo.remove(store);
            return false;
        }

        const apiKey = store.credentials.apiKey;
        const apiBase = process.env.BACKEND_URL;


        const webhooksToDelete = [
            `${apiBase}/stores/webhooks/${adminId}/easyorders/orders/create`,
            `${apiBase}/stores/webhooks/${adminId}/easyorders/orders/status`
        ];

        try {
            // 3. Call Easy Orders DELETE endpoint for each webhook
            await Promise.all(
                webhooksToDelete.map(url =>
                    axios.delete(`${this.baseUrl}/webhooks/delete-by-url`, {
                        headers: {
                            "Api-Key": apiKey,
                        },
                        params: { url }
                    })
                )
            );

            return true;
        } catch (error: any) {
            this.logger.error(`Failed to cancel Easy Orders integration: ${error.message}`);
            return false;
        }
    }

    public async getFullProductById(store: StoreEntity, id: string): Promise<MappedProductDto> {
        try {

            const response = await this.sendRequest(store, {
                method: 'GET',
                url: `/products/${id}`,
            }, 0, false);

            return this.mapRemoteProductToDto(response);
        } catch (error: any) {
            this.logger.error(`[Product] Failed to fetch product by id ${id}: ${error.message}`);
            throw error;
        }
    }

    private mapRemoteProductToDto(remote: any): MappedProductDto {
        const variants = (remote.variants || []).map((v: any) => ({
            price: Number(v.price) || 0,
            expense: Number(v.expense) || 0,
            quantity: Number(v.quantity) || 0,
            sku: String(v.taager_code || v.sku || ""),
            variation_props: (v.variation_props || []).map((p: any) => ({
                variation: p.variation?.trim(),
                variation_prop: String(p.variation_prop)?.trim(),
            })),
        }));

        const variations = (remote.variations || []).map((v: any) => ({
            id: v.id,
            name: v.name?.trim(),
            props: (v.props || []).map((p: any) => ({
                id: p.id,
                name: p.name?.trim(),
                value: p.value?.trim(),
            })),
        }));

        return {
            name: remote.name?.trim(),
            price: Number(remote.price) || 0,
            expense: Number(remote.expense) || 0,
            description: remote.description || "",
            slug: remote.slug,
            sku: remote.sku || "",
            thumb: remote.thumb || "",
            images: remote.images || [],
            categories: (remote.categories || []).map((c: any) => ({
                id: String(c.id),
                name: c.name,
            })),
            quantity: Number(remote.quantity) || 0,
            variations,
            variants,
        };
    }
}


