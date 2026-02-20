import { Injectable, InternalServerErrorException, forwardRef, Inject, NotFoundException, UnauthorizedException, BadRequestException } from "@nestjs/common";
import { StoreEntity, StoreProvider, SyncStatus } from "entities/stores.entity";
import { AxiosRequestConfig } from "axios";
import { BaseStoreService } from "./BaseStoreService";
import { CategoryEntity } from "entities/categories.entity";
import { InjectRepository } from "@nestjs/typeorm";
import { StoresService } from "../stores.service";
import { EncryptionService } from "common/encryption.service";
import { MoreThan, Repository } from "typeorm";
import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";
import { v4 as uuidv4 } from 'uuid'; // You might need to install uuid: npm i uuid @types/uuid
import { OrderEntity, OrderStatus, OrderStatusEntity, PaymentMethod, PaymentStatus } from "entities/order.entity";
import { OrdersService } from "src/orders/services/orders.service";
import { CreateOrderDto } from "dto/order.dto";
import { RedisService } from "common/redis/RedisService";
import { CreateProductDto, CreateSkuItemDto, UpdateProductDto, UpsertProductSkusDto } from "dto/product.dto";
import { ProductsService } from "src/products/products.service";
import { CategoriesService } from "src/category/category.service";

@Injectable()
export class EasyOrderService extends BaseStoreService {

    constructor(
        @InjectRepository(StoreEntity) protected readonly storesRepo: Repository<StoreEntity>,
        @InjectRepository(OrderStatusEntity) protected readonly statusRepo: Repository<OrderStatusEntity>,
        @InjectRepository(CategoryEntity) protected readonly categoryRepo: Repository<CategoryEntity>,
        @InjectRepository(ProductEntity) protected readonly productsRepo: Repository<ProductEntity>,
        @InjectRepository(ProductVariantEntity) protected readonly pvRepo: Repository<ProductVariantEntity>,

        protected readonly mainStoresService: StoresService,
        @Inject(forwardRef(() => OrdersService))
        protected readonly ordersService: OrdersService,
        @Inject(forwardRef(() => ProductsService)) private readonly productsService: ProductsService,
        @Inject(forwardRef(() => CategoriesService))
        private readonly categoriesService: CategoriesService,
        protected readonly redisService: RedisService,
        protected readonly encryptionService: EncryptionService,
    ) {
        super(storesRepo, categoryRepo, encryptionService, mainStoresService, process.env.EASY_ORDER_BASE_URL, 40, StoreProvider.EASYORDER)
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
        const keys = await this.mainStoresService.getDecryptedIntegrations(store);

        if (!keys.apiKey) {
            throw new InternalServerErrorException(`Missing API Key for store ${store.name}`);
        }

        const apiKey = keys.apiKey.trim(); // Applying your trim preference

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
        attempt = 0
    ): Promise<any> {
        const headers = await this.getHeaders(store); // ✅ await here
        const baseConfig: AxiosRequestConfig = {
            ...config,
            headers: { ...headers, ...config.headers },
        };
        return await super.sendRequest(store, baseConfig, attempt); // ✅ return + await
    }



    private async getStoreForSync(adminId: string): Promise<StoreEntity | null> {
        const cleanAdminId = adminId; // Remember to trim
        if (!cleanAdminId) return null;

        const store = await this.storesRepo.findOne({
            where: {
                adminId: cleanAdminId,
                provider: StoreProvider.EASYORDER,
                isActive: true, // Only sync to active stores
                autoSync: true, // Check if the user enabled automatic sync
            },
        });
        return store;
    }

    // ===========================================================================
    // SYNC CATEGORY METHODS
    // ===========================================================================
    private async createCategory(category: CategoryEntity, store: StoreEntity) {
        this.logCtx(`[Category] Creating category: ${category.name} (slug: ${category.slug})`, store);

        const payload = {
            name: category.name.trim(), // Remember to trim
            slug: category.slug,
            thumb: this.getImageUrl(category.image?.trim() || `/uploads/default-category.png`),
            show_in_header: false,
            hidden: false,
            position: 1,
            parent_id: null
        };

        try {
            const response = await this.sendRequest(store, {
                method: 'POST',
                url: '/categories',
                data: payload
            });
            this.logCtx(`[Category] ✓ Successfully created category with external ID: ${response.data?.id}`, store);
            return response.data;
        } catch (error) {
            this.logCtxError(`[Category] ✗ Failed to create category: ${error.message}`, store);
            throw error;
        }
    }

    private async updateCategory(category: CategoryEntity, store: StoreEntity, externalId) {
        if (!externalId) {
            this.logCtxWarn(`[Category] Skipping update: No external ID provided for category ${category.name}`, store);
            return;
        }

        this.logCtx(`[Category] Updating category: ${category.name} (external ID: ${externalId})`, store);

        const payload = {
            name: category.name.trim(),
            slug: category.slug,
            thumb: this.getImageUrl(category.image?.trim() || `/uploads/default-category.png`),
            show_in_header: false,
            hidden: false,
            position: 1,
            parent_id: null
        };

        try {
            const response = await this.sendRequest(store, {
                method: 'PATCH',
                url: `/categories/${externalId}`,
                data: payload
            });
            this.logCtx(`[Category] ✓ Successfully updated category ${externalId}`, store);
            return response;
        } catch (error) {
            this.logCtxError(`[Category] ✗ Failed to update category ${externalId}: ${error.message}`, store);
            throw error;
        }
    }

    private async getCategory(externalCategoryId: string, store: StoreEntity) {
        this.logCtxDebug(`[Category] Fetching category with external ID: ${externalCategoryId}`, store);

        try {
            const response = await this.sendRequest(store, {
                method: 'GET',
                url: `/categories/${externalCategoryId}`,
            });
            this.logCtxDebug(`[Category] ✓ Successfully fetched category: ${response?.name}`, store);
            return response;
        } catch (error) {
            this.logCtxError(`[Category] ✗ Failed to fetch category ${externalCategoryId}: ${error.message}`, store);
            throw error;
        }
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
        this.logCtxDebug(`[Category] Fetching categories${filterStr}`, store);

        try {
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
            this.logCtxDebug(`[Category] ✓ Retrieved ${response?.length || 0} categories`, store);
            return response;
        } catch (error) {
            this.logCtxError(`[Category] ✗ Failed to fetch categories: ${error.message}`, store);
            throw error;
        }
    }

    public async syncCategory({ category, relatedAdminId, slug }: { category: CategoryEntity, relatedAdminId?: string, slug?: string }) {
        const { adminId } = category;

        const finalAdmin = relatedAdminId ? relatedAdminId : adminId;
        // 1. Fetch only what we need
        const activeStore = await this.getStoreForSync(finalAdmin)

        if (!activeStore) {
            this.logger.debug(`[EasyOrder Sync] Skipping: No active EasyOrder store for admin ${adminId}`);
            return;
        }
        const checkSlug = slug ? slug : category.slug;
        const searchFilters = [`slug||eq||${checkSlug.trim()}`];
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
    private async syncCategoriesCursor(store: StoreEntity): Promise<Map<number, string>> {
        this.logCtx(`[Sync] Starting category synchronization (batch size: 30)`, store);

        const categoryMap = new Map<number, string>();
        let lastId = 0;
        let hasMore = true;
        let totalProcessed = 0;
        let totalCreated = 0;
        let totalUpdated = 0;

        while (hasMore) {
            const localBatch = await this.categoryRepo.find({
                where: { adminId: store.adminId, id: MoreThan(lastId) },
                order: { id: 'ASC' } as any,
                take: 30
            });

            if (localBatch.length === 0) {
                hasMore = false;
                this.logCtx(`[Sync] No more categories to process`, store);
                break;
            }

            this.logCtx(`[Sync] Processing batch of ${localBatch.length} categories (IDs: ${localBatch[0].id}-${localBatch[localBatch.length - 1].id})`, store);

            // Bulk check existence: Use names for categories as they are unique identifiers in EasyOrder
            const slugs = localBatch.map(c => c.slug).join(',');
            const remoteItems = await this.getAllCategories(store, [`slug||$in||${slugs}`]);
            const remoteMap = new Map(remoteItems.map((r: any) => [r.slug.trim(), r.id]));

            for (const cat of localBatch) {
                let extId = remoteMap.get(cat.slug.trim());

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
                    this.logCtxError(`[Sync] Error processing category ${cat.name} (ID: ${cat.id}): ${error.message}`, store);
                }

                totalProcessed++;
            }

            lastId = localBatch[localBatch.length - 1].id;
        }

        this.logCtx(`[Sync] ✓ Category sync completed | Total: ${totalProcessed} | Created: ${totalCreated} | Updated: ${totalUpdated}`, store);
        return categoryMap;
    }

    public async syncExternalCategory(user: any, remoteCategory: any): Promise<number | null> {
        if (!remoteCategory || !remoteCategory.slug) return null;

        // Check if category exists locally by slug
        let category = await this.categoryRepo.findOne({
            where: { adminId: user.adminId, slug: remoteCategory.slug }
        });

        if (!category) {
            this.logger.log(`[Sync] Creating new category: ${remoteCategory.name}`);
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
            categoryPayload.push({ id: String(externaCategoryId).trim() })
        }

        // 1. Extract Unique Attributes (e.g. Color: [Red, Blue], Size: [L, XL])
        const variationMap = new Map<string, Set<string>>();

        variants.forEach(v => {
            if (v.attributes) {
                Object.entries(v.attributes).forEach(([key, value]) => {
                    if (!variationMap.has(key)) variationMap.set(key, new Set());
                    variationMap.get(key)?.add(String(value));
                });
            }
        });

        // 2. Build "variations" array (The Definitions)
        const variationsDef = Array.from(variationMap.entries()).map(([name, values]) => {
            const variationId = uuidv4(); // Generate a temporary ID for the definition
            return {
                id: variationId,
                name: name.trim(),
                product_id: null, // API handles this
                type: "dropdown",
                props: Array.from(values).map(val => ({
                    id: uuidv4(),
                    name: val.trim(),
                    variation_id: variationId,
                    value: val.trim()
                }))
            };
        });

        let productQuantity = 0;
        // 3. Build "variants" array (The Actual SKUs)
        const variantsPayload = variants.map(v => {
            productQuantity += (v.stockOnHand - v.reserved);
            return {
                price: v.price || product.wholesalePrice || 0,
                sale_price: v.price || product.wholesalePrice || 0, // Default as per requirements
                quantity: v.stockOnHand - v.reserved,   // ALWAYS 0 on Create/Full Update. Sync stock separately.
                taager_code: String(v.sku),
                variation_props: Object.entries(v.attributes || {}).map(([key, val]) => ({
                    variation: key.trim(),
                    variation_prop: String(val).trim()
                }))
            };
        });

        return {
            name: product.name.trim(),
            price: product.wholesalePrice || 0,
            sale_price: product.wholesalePrice || 0,
            description: product.description || "",
            slug: product.slug,
            sku: `SKU-${product.slug.toUpperCase().replace(/-/g, '').substring(0, 8)}-${product.id}`.trim(),
            thumb: this.getImageUrl(product.mainImage?.trim() || ""),
            images: product.images?.map(img => this.getImageUrl(img.url.trim())) || [],
            categories: categoryPayload,
            quantity: productQuantity,
            track_stock: true,
            disable_orders_for_no_stock: true,
            // buy_now_text: "اضغط هنا للشراء",
            is_reviews_enabled: true,
            taager_code: String(product.id), // Link Main Product ID
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
            localMap.set(local.sku.trim(), local);
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

            this.logCtx(
                `[Variants Sync] ✓ Synced ${variantsToSave.length} variant(s) external IDs`,
                store,
            );
        }
    }


    private async createProduct(product: ProductEntity, variants: ProductVariantEntity[], store: StoreEntity, externalCategoryId: string) {
        this.logCtx(`[Product] Creating product: ${product.name} (slug: ${product.slug}) with ${variants.length} variant(s)`, store);

        try {
            const payload = await this.mapProductToPayload(product, variants, store, externalCategoryId);

            const response = await this.sendRequest(store, {
                method: 'POST',
                url: '/products',
                data: payload
            });
            const remoteVariants = response.variants;
            await this.syncVariantsBySku(
                variants,
                remoteVariants,
                store
            );
            this.logCtx(`[Product] ✓ Successfully created product with external ID: ${response?.id}`, store);
            return response;
        } catch (error) {
            this.logCtxError(`[Product] ✗ Failed to create product ${product.name}: ${error.message}`, store);
            throw error;
        }
    }

    private async updateProduct(product: ProductEntity, variants: ProductVariantEntity[], store: StoreEntity, externalId: string, externalCategoryId: string) {
        this.logCtx(`[Product] Updating product: ${product.name} (external ID: ${externalId}) with ${variants.length} variant(s)`, store);

        try {
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
            this.logCtx(`[Product] ✓ Successfully updated product ${externalId}`, store);
            return response;
        } catch (error) {
            this.logCtxError(`[Product] ✗ Failed to update product ${externalId}: ${error.message}`, store);
            throw error;
        }
    }


    // SYNC STOCK ONLY (Efficient)
    /**
     * Updates the quantity of a specific variant.
     */
    async updateVariantStock(productInternalId: string, variantInternalId: string, quantity: number, store: StoreEntity) {
        const safeQuantity = Math.max(0, quantity);
        this.logCtx(`[Stock] Updating variant stock | Product: ${productInternalId} | Variant: ${variantInternalId} | New Quantity: ${safeQuantity}`, store);

        try {
            const url = `/products/variants/${productInternalId}/${variantInternalId}/quantity`;

            await this.sendRequest(store, {
                method: 'PATCH',
                url: url,
                data: { quantity: safeQuantity } // Ensure no negative stock
            });

            this.logCtx(`[Stock] ✓ Successfully updated stock for variant ${variantInternalId} to ${safeQuantity}`, store);
        } catch (error) {
            this.logCtxError(`[Stock] ✗ Failed to update stock for variant ${variantInternalId}: ${error.message}`, store);
            throw error;
        }
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
    private async getAllProducts(store: StoreEntity, filters: string[] = []) {
        const filterStr = filters.length > 0 ? ` with filters: [${filters.join(', ')}]` : '';
        this.logCtxDebug(`[Product] Fetching products${filterStr}`, store);

        try {
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
            });
            this.logCtxDebug(`[Product] ✓ Retrieved ${response?.length || 0} products`, store);
            return response;
        } catch (error) {
            this.logCtxError(`[Product] ✗ Failed to fetch products: ${error.message}`, store);
            throw error;
        }
    }

    /**
     * Sync Products: Fetch 20 by 20 with Variants
     */
    private async syncProductsCursor(store: StoreEntity, categoryMap: Map<number, string>) {
        this.logCtx(`[Sync] Starting product synchronization (batch size: 20)`, store);

        let lastId = 0;
        let hasMore = true;
        let totalProcessed = 0;
        let totalCreated = 0;
        let totalUpdated = 0;
        let totalErrors = 0;

        while (hasMore) {
            const localBatch = await this.storesRepo.manager.find(ProductEntity, {
                where: { storeId: store.id, adminId: store.adminId, id: MoreThan(lastId) },
                relations: ['variants', 'category'],
                order: { id: 'ASC' } as any,
                take: 20
            });

            if (localBatch.length === 0) {
                hasMore = false;
                this.logCtx(`[Sync] No more products to process`, store);
                break;
            }

            this.logCtx(`[Sync] Processing batch of ${localBatch.length} products (IDs: ${localBatch[0].id}-${localBatch[localBatch.length - 1].id})`, store);

            // Bulk check existence: Use slug 
            const slugs = localBatch.map(p => p.slug).join(',');
            const remoteItems = await this.getAllProducts(store, [`slug||$in||${slugs}`]);
            const remoteMap = new Map<string, any>(remoteItems.map((r: any) => [String(r.slug), r]));

            for (const product of localBatch) {
                try {
                    const remote = remoteMap.get(String(product.slug));
                    let extCatId = product.categoryId ? categoryMap.get(product.categoryId) : null;

                    if (!extCatId && product.category) {
                        const remoteCategory = await this.syncCategory({ relatedAdminId: product.adminId, category: product.category });
                        extCatId = remoteCategory?.id;
                    }

                    if (remote) {
                        await this.updateProduct(product, product.variants, store, remote.id, extCatId);
                        totalUpdated++;
                    } else {
                        await this.createProduct(product, product.variants, store, extCatId);
                        totalCreated++;
                    }
                } catch (error) {
                    this.logCtxError(`[Sync] Error processing product ${product.name} (ID: ${product.id}): ${error.message}`, store);
                    totalErrors++;
                }

                totalProcessed++;
            }

            lastId = localBatch[localBatch.length - 1].id;
        }

        this.logCtx(`[Sync] ✓ Product sync completed | Total: ${totalProcessed} | Created: ${totalCreated} | Updated: ${totalUpdated} | Errors: ${totalErrors}`, store);
    }
    private async syncExternalProductToLocal(adminId: string, store: StoreEntity, externalProductId: string): Promise<ProductEntity> {

        // A. Fetch Full Details from External API
        let remoteProduct;

        const response = await this.sendRequest(store, {
            method: 'GET',
            url: `/products/${externalProductId}`
        });
        remoteProduct = response;

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
                key
            }];
        }

        const localCategoryId = await this.syncExternalCategory(userContext, remoteProduct.category);
        // B. Map Remote Data to DTO
        const productDto: CreateProductDto = {
            name: remoteProduct.name,
            slug: remoteProduct.slug, // Crucial for matching
            description: remoteProduct.description,
            wholesalePrice: remoteProduct.price,
            lowestPrice: remoteProduct.price || remoteProduct.price,
            storeId: store.id,
            categoryId: localCategoryId,
            mainImage: remoteProduct.thumb || remoteProduct.images?.[0] || "",
            images: (remoteProduct.images || []).map(url => ({ url })),
            combinations,
            upsellingEnabled: false,

        };

        const existingProduct = await this.productsRepo.findOne({
            where: { adminId, slug: productDto.slug }
        });

        let savedProduct: ProductEntity;

        if (existingProduct) {
            this.logger.log(`[Reverse Sync] Updating existing product: ${existingProduct.slug}`);

            const updateDto: UpdateProductDto = { ...productDto };
            savedProduct = await this.productsService.update(userContext, existingProduct.id, updateDto);


            if (productDto.combinations && productDto.combinations.length > 0) {
                const upsertDto: UpsertProductSkusDto = {
                    items: productDto.combinations.map(c => ({
                        ...c,
                        key: c.key || this.productsService.canonicalKey(c.attributes || {}) // Access private helper or rely on logic
                    })) as any
                };

                await this.productsService.upsertSkus(userContext, existingProduct.id, upsertDto);
            }

        } else {
            this.logger.log(`[Reverse Sync] Creating new product: ${productDto.slug}`);
            savedProduct = await this.productsService.create(userContext, productDto);
        }

        return await this.productsService.get(userContext, savedProduct.id);
    }

    // ===========================================================================
    // SYNC ORDER METHODS
    // ===========================================================================
    /**
    * Fetches order details from EasyOrder API
    */
    public async getOrderDetails(externalOrderId: string, store: StoreEntity) {
        try {
            return await this.sendRequest(store, {
                method: 'GET',
                url: `/orders/${externalOrderId}`,
            });
        } catch (error) {
            this.handleError(error, "getOrderDetails");
        }
    }

    /**
     * Updates the status of an order on EasyOrder
     */
    public async updateOrderStatus(order: OrderEntity, store: StoreEntity) {
        if (!order.externalId) return;

        const remoteStatus = this.mapInternalStatusToExternal[order.status.code];
        if (!remoteStatus) {
            this.logger.warn(`No status mapping found for order (${order.id}) | admin (${order.adminId}) | local status: ${order.status}`);
            return;
        }

        try {
            return await this.sendRequest(store, {
                method: 'PATCH',
                url: `/orders/${order.externalId}/status`,
                data: { status: remoteStatus }
            });
        } catch (error) {
            this.handleError(error, "updateOrderStatus");
        }
    }

    // ===========================================================================
    // MAIN ENTRY POINTS FOR SYNC
    // ===========================================================================
    public async syncProduct({ product, variants, slug }: { product: ProductEntity, variants: ProductVariantEntity[], slug?: string }) {
        this.logCtx(`[Sync] Starting single product sync | Product: ${product.name} | SKU Count: ${variants.length}`, null, product.adminId);

        // 1. Validate Store
        if (!product.store || product.store.provider !== StoreProvider.EASYORDER) {
            this.logCtxWarn(`[Sync] Skipping sync: Store not found or provider is not EASYORDER`, null, product.adminId);
            return;
        }

        const activeStore = await this.getStoreForSync(product.adminId);

        if (!activeStore) {
            this.logCtxWarn(`[Sync] Skipping sync: No active store with autoSync enabled`, activeStore, product.adminId);
            return;
        }

        try {
            // 2. ⚡ RESOLVE CATEGORY ID ⚡
            let easyOrderCategory = null;
            if (product.category) {
                this.logCtx(`[Sync] Syncing category: ${product.category.name}`, activeStore);
                easyOrderCategory = await this.syncCategory({ category: product.category, slug: product.category.slug, relatedAdminId: product.adminId });
            }

            // ⚡ REQUIREMENT 1: Check existence by Slug
            const checkSlug = slug ? slug : product.slug;
            this.logCtx(`[Sync] Checking if product exists with slug: ${checkSlug}`, activeStore);
            const searchFilters = [`slug||eq||${checkSlug.trim()}`];
            const existingProducts = await this.getAllProducts(activeStore, searchFilters);
            const remoteProduct = existingProducts?.length > 0 ? existingProducts[0] : null;

            if (remoteProduct) {
                this.logCtx(`[Sync] Product already exists externally (ID: ${remoteProduct.id}), updating...`, activeStore);
                return await this.updateProduct(product, variants, activeStore, remoteProduct.id, easyOrderCategory?.id);
            } else {
                this.logCtx(`[Sync] Product does not exist externally, creating...`, activeStore);
                return await this.createProduct(product, variants, activeStore, easyOrderCategory?.id);
            }
        } catch (error) {
            this.logCtxError(`[Sync] ✗ Failed to sync product ${product.name}: ${error.message}`, activeStore, product.adminId);
            throw error;
        }
    }


    /**
     * Main entry point for syncing order status to all applicable stores
     */
    public async syncOrderStatus(order: OrderEntity) {
        this.logCtx(`[Sync] Starting order status sync | Order: ${order.orderNumber} | Status: ${order.status}`, null, order.adminId);

        try {
            const store = await this.getStoreForSync(order.adminId);
            if (!store) {
                this.logCtxWarn(`[Sync] Skipping order status sync: No active store with autoSync enabled`, null, order.adminId);
                return;
            }

            await this.updateOrderStatus(order, store);
            this.logCtx(`[Sync] ✓ Order status synced successfully`, store);
        } catch (error) {
            this.logCtxError(`[Sync] ✗ Failed to sync order status for ${order.orderNumber}: ${error.message}`, null, order.adminId);
        }
    }

    /**
    * Main entry point for full store synchronization using Cursor Pagination
    */
    public async syncFullStore(store: StoreEntity) {
        if (!store || !store.isActive) {
            this.logCtxWarn(`[Sync] Skipping full store sync: Store is inactive or null`, store);
            return;
        }

        if (store.syncStatus === SyncStatus.SYNCING) {
            this.logCtxWarn(`[Sync] Store is already syncing. Skipping.`, store);
            return;
        }

        try {
            this.logCtx(`[Sync] ========================================`, store);
            this.logCtx(`[Sync] Starting FULL STORE SYNC`, store);
            this.logCtx(`[Sync] ========================================`, store);

            const syncStartTime = Date.now();

            await this.storesRepo.update(store.id, {
                syncStatus: SyncStatus.SYNCING,
                lastSyncAttemptAt: new Date()
            });

            // 1. Sync Categories with Cursor (Batch 30)
            this.logCtx(`[Sync] Phase 1: Synchronizing categories...`, store);
            const categoryMap = await this.syncCategoriesCursor(store);
            this.logCtx(`[Sync] Phase 1 Complete: ${categoryMap.size} categories synced`, store);

            // 2. Sync Products with Cursor (Batch 20)
            this.logCtx(`[Sync] Phase 2: Synchronizing products...`, store);
            await this.syncProductsCursor(store, categoryMap);
            this.logCtx(`[Sync] Phase 2 Complete: Products synced`, store);

            const syncDuration = Date.now() - syncStartTime;
            await this.storesRepo.update(store.id, {
                syncStatus: SyncStatus.SYNCED,
            });

            this.logCtx(`[Sync] ========================================`, store);
            this.logCtx(`[Sync] ✓ FULL STORE SYNC COMPLETED in ${(syncDuration / 1000).toFixed(2)}s`, store);
            this.logCtx(`[Sync] ========================================`, store);
        } catch (error) {
            this.logCtxError(`[Sync] ========================================`, store);
            this.logCtxError(`[Sync] ✗ FULL STORE SYNC FAILED`, store);
            this.logCtxError(`[Sync] Error: ${error.message}`, store);
            this.logCtxError(`[Sync] ========================================`, store);

            await this.storesRepo.update(store.id, {
                syncStatus: SyncStatus.FAILED,
            });
        }
    }


    // ===========================================================================
    // WEBHOOK: HANDLE NEW ORDER
    // ===========================================================================
    public async handleWebhookOrderCreate(adminId: number, secret: string, payload: any) {
        // Validate Security
        const store = await this.validateWebhookSecret(adminId, secret, "CREATE_ORDER");

        const existingOrder = await this.ordersService.findByExternalId(payload.id);
        if (existingOrder) return;
        const uniqueExternalIds = [...new Set(payload.cart_items.map((item: any) => item.product_id))];

        this.logCtx(`[Webhook] Syncing ${uniqueExternalIds.length} unique products for Order ${payload.id}...`, store);

        // We create a Map: External_ID -> Local_Product_Entity
        const productMap = new Map<string, any>();


        await Promise.all(
            uniqueExternalIds.map(async (extId) => {
                try {
                    const localProd = await this.syncExternalProductToLocal(
                        String(adminId),
                        store,
                        String(extId)
                    );
                    productMap.set(String(extId), localProd);
                } catch (error) {
                    this.logCtxError(`Failed to sync product ${extId} for order: ${error.message}`, store);
                    throw new Error(error.message)
                }
            })
        );

        const items = [];

        for (const item of payload.cart_items) {

            const localProduct = productMap.get(String(item.product_id));

            let matchedVariant = null;

            if (item.variant) {
                const payloadAttrs: Record<string, string> = {};
                if (item.variant?.variation_props) {
                    item.variant.variation_props.forEach(p => payloadAttrs[p.variation] = p.variation_prop);
                }
                const payloadKey = this.productsService.canonicalKey(payloadAttrs); // Reuse helper

                matchedVariant = localProduct.skus.find(v => v.key === payloadKey);
            }

            // Fallback: If no variant found (or simple product), take the first variant (default)
            if (!matchedVariant && localProduct.skus?.length > 0) {
                matchedVariant = localProduct.skus.find(v => v.key === 'default') || localProduct.skus[0];
            }

            if (!matchedVariant && localProduct.skus?.length === 0) {
                throw new BadRequestException(`Failed to map variant for product ${localProduct.name}`);
            }

            if (matchedVariant) {
                items.push({
                    variantId: matchedVariant.id, // Internal Database ID
                    quantity: item.quantity,
                    unitPrice: item.price,
                    unitCost: 0
                });
            } else {
                this.logCtxWarn(`Could not resolve variant for product ID: ${item.product_id}`, store);
            }
        }

        // 4. Create Order
        const createOrderDto: CreateOrderDto = {
            customerName: payload.full_name,
            phoneNumber: payload.phone,
            address: payload.address,
            city: payload.government || "Unknown",
            paymentMethod: this.mapPaymentMethod(payload.payment_method),
            paymentStatus: payload.status === 'paid' ? PaymentStatus.PAID : PaymentStatus.PENDING,
            shippingCost: payload.shipping_cost || 0,
            shippingCompanyId: null,
            discount: 0,
            items: items,
            notes: `Imported from EasyOrder (Store: ${store.name})`,
            storeId: String(store.id),

        };

        const User = { id: store.adminId, role: { name: 'admin' } };
        const newOrder = await this.ordersService.create(User, createOrderDto);
        await this.ordersService.updateExternalId(newOrder.id, payload.id);

        this.logCtx(`Successfully imported Order ${newOrder.orderNumber}`, store);
    }

    // ===========================================================================
    // WEBHOOK: HANDLE STATUS UPDATE
    // ===========================================================================
    public async handleWebhookStatusUpdate(adminId: number, secret: string, payload: any) {
        // Validate Security
        const store = await this.validateWebhookSecret(adminId, secret, "UPDATE_ORDER_STATUS");

        const externalOrderId = payload.order_id;
        const order = await this.ordersService.findByExternalId(externalOrderId);

        if (!order) {
            this.logCtxWarn(`Received status update for unknown order ${externalOrderId}`, store);
            return;
        }

        // 3. Map Status
        const newStatus = this.mapExternalStatusToInternal(payload.new_status);
        const statusEntity = await this.ordersService.findStatusByCode(newStatus, adminId.toString())
        if (order.status.code === newStatus) return;
        if (!newStatus) {
            this.logCtxWarn(`Unknown external status: ${payload.new_status}`, store);
            return;
        }

        // 4. Update Status
        const User = { id: store.adminId, role: { name: 'admin' } };

        await this.ordersService.changeStatus(User, order.id, {
            statusId: statusEntity.id,
            notes: `Status updated via Webhook from ${payload.old_status} to ${payload.new_status}`
        });
    }
    // ===========================================================================
    // HELPERS
    // ===========================================================================

    private async validateWebhookSecret(adminId: number, incomingSecret: string, action: "CREATE_ORDER" | "UPDATE_ORDER_STATUS"): Promise<StoreEntity> {
        const store = await this.storesRepo.findOne({ where: { adminId: adminId.toString(), provider: StoreProvider.EASYORDER } });

        if (!store) {
            throw new NotFoundException(`Store not found`);
        }

        const credentials = await this.mainStoresService.getDecryptedIntegrations(store);

        if (!credentials) {
            throw new NotFoundException(`Cannot find store credentials for ${store.id}`);
        }
        const storedSecret = action === 'CREATE_ORDER' ? credentials.webhookCreateOrderSecret : credentials.webhookUpdateStatusSecret;

        if (storedSecret !== incomingSecret) {
            this.logger.error(`Webhook signature mismatch for store ${store.id}`);
            throw new UnauthorizedException("Invalid Webhook Secret");
        }

        return store;
    }

    private mapPaymentMethod(method: string): PaymentMethod {
        switch (method?.toLowerCase()) {
            case 'cod': return PaymentMethod.CASH_ON_DELIVERY;
            case 'card': return PaymentMethod.CARD;
            case 'cash': return PaymentMethod.CASH;
            default: return PaymentMethod.CASH_ON_DELIVERY;
        }
    }

    private mapExternalStatusToInternal(externalStatus: string): OrderStatus | null {
        const map: Record<string, OrderStatus> = {
            "pending": OrderStatus.NEW,
            "pending_payment": OrderStatus.NEW,
            "confirmed": OrderStatus.UNDER_REVIEW,
            "paid": OrderStatus.UNDER_REVIEW,
            "processing": OrderStatus.PREPARING,
            "waiting_for_pickup": OrderStatus.READY,
            "in_delivery": OrderStatus.SHIPPED,
            "delivered": OrderStatus.DELIVERED,
            "canceled": OrderStatus.CANCELLED,
            "paid_failed": OrderStatus.CANCELLED,
            "returning_from_delivery": OrderStatus.RETURNED,
            "request_refund": OrderStatus.RETURNED,
            "refund_in_progress": OrderStatus.RETURNED,
            "refunded": OrderStatus.RETURNED,
        };

        return map[externalStatus] || null;
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
            [OrderStatus.READY]: "waiting_for_pickup",
            [OrderStatus.SHIPPED]: "in_delivery",
            [OrderStatus.DELIVERED]: "delivered",

            // حالات الإغلاق
            [OrderStatus.CANCELLED]: "canceled",
            [OrderStatus.RETURNED]: "returning_from_delivery",
        };
        return map[internalStatus] || null;
    }

}

