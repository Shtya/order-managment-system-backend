import { forwardRef, Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { BaseStoreProvider, WebhookOrderPayload, WebhookOrderUpdatePayload, UnifiedProductDto, UnifiedProductVariantDto } from "./BaseStoreProvider";
import { InjectRepository } from "@nestjs/typeorm";
import { CategoryEntity } from "entities/categories.entity";
import { StoreEntity, StoreProvider, SyncStatus } from "entities/stores.entity";
import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";
import { StoresService } from "../stores.service";
import { OrdersService } from "src/orders/services/orders.service";
import { ProductsService } from "src/products/products.service";
import { CategoriesService } from "src/category/category.service";
import { RedisService } from "common/redis/RedisService";
import { EncryptionService } from "common/encryption.service";
import { MoreThan, Repository } from "typeorm";
import { OrderEntity, OrderStatus, PaymentMethod, PaymentStatus } from "entities/order.entity";
import axios, { AxiosRequestConfig } from "axios";
import * as crypto from 'crypto';
import { AppGateway } from "common/app.gateway";


@Injectable()
export class WooCommerceService extends BaseStoreProvider {
    code: StoreProvider = StoreProvider.WOOCOMMERCE;
    displayName: string = "WooCommerce";
    baseUrl: string = process.env.WOOCOMMERCE_BASE_URL || "https://api.easy-orders.net/api/v1";

    constructor(
        @InjectRepository(StoreEntity) protected readonly storesRepo: Repository<StoreEntity>,
        @InjectRepository(CategoryEntity) protected readonly categoryRepo: Repository<CategoryEntity>,
        @InjectRepository(ProductEntity) protected readonly productsRepo: Repository<ProductEntity>,
        @InjectRepository(ProductVariantEntity) protected readonly pvRepo: Repository<ProductVariantEntity>,
        @Inject(forwardRef(() => StoresService))
        protected readonly mainStoresService: StoresService,
        @Inject(forwardRef(() => OrdersService))
        protected readonly ordersService: OrdersService,
        @Inject(forwardRef(() => ProductsService)) private readonly productsService: ProductsService,
        @Inject(forwardRef(() => CategoriesService))
        private readonly categoriesService: CategoriesService,

        protected readonly redisService: RedisService,
        protected readonly encryptionService: EncryptionService,
        private readonly appGateway: AppGateway,
    ) {
        super(storesRepo, categoryRepo, encryptionService, mainStoresService, 400, StoreProvider.WOOCOMMERCE)

    }
    /**
 * Read keys (clientKey / clientSecret / baseUrl) from your DB via mainStoresService
 */
    private getWooCommerceURL(storeUrl: string, path: string = ''): string {
        let cleanUrl = storeUrl.trim();

        // 1. Add https:// if no protocol is present
        if (!/^https?:\/\//i.test(cleanUrl)) {
            cleanUrl = `https://${cleanUrl}`;
        }

        // 2. Remove trailing slash to prevent double slashes in the final path
        cleanUrl = cleanUrl.replace(/\/$/, "");

        // 3. Ensure path starts with a slash if provided
        const cleanPath = path.startsWith('/') ? path : `/${path}`;

        return `${cleanUrl}/wp-json/wc/v3${cleanPath}`;
    }

    private async getAuthParams(store: StoreEntity) {
        const keys = store?.credentials;

        const clientKey = keys?.apiKey?.trim();
        const clientSecret = keys?.clientSecret?.trim();
        const baseUrl = store?.storeUrl?.trim();
        const url = this.getWooCommerceURL(baseUrl);
        if (!clientKey || !clientSecret || !baseUrl) {
            throw new InternalServerErrorException(
                `Missing WooCommerce integration keys for store ${store?.name || store?.id}`
            );
        }

        return {
            clientKey,
            clientSecret,
            baseUrl: url, // remove trailing slash
        };
    }

    private buildBasicAuthHeader(clientKey: string, clientSecret: string) {
        // Node environment: Buffer available
        const token = Buffer.from(`${clientKey}:${clientSecret}`).toString('base64');
        return `Basic ${token}`;
    }

    protected async sendRequest(
        store: StoreEntity,
        config: AxiosRequestConfig,
        attempt = 0
    ): Promise<any> {
        // read decrypted keys (clientKey, clientSecret, baseUrl)
        const keys = await this.getAuthParams(store); // reuses getAuthParams from earlier

        const baseApiUrl = `${keys.baseUrl}`;

        // build Authorization header
        const authHeader = this.buildBasicAuthHeader(keys.clientKey, keys.clientSecret);

        const baseConfig: AxiosRequestConfig = {
            ...config,
            baseURL: baseApiUrl,
            headers: {
                // keep any headers caller passed, but ensure Authorization present
                ...(config.headers || {}),
                Authorization: authHeader,
                'Content-Type': 'application/json',
            },
            // DO NOT add consumer_key/consumer_secret to params here when using Basic Auth
            params: {
                ...(config.params || {}),
            },
        };

        // call parent implementation (keeps your existing behavior: logging, retries, etc.)
        return await super.sendRequest(store, baseConfig, attempt);
    }
    private async getStoreForSync(adminId: string): Promise<StoreEntity | null> {
        const cleanAdminId = adminId?.trim?.() ?? adminId;
        if (!cleanAdminId) return null;

        const store = await this.storesRepo.findOne({
            where: {
                adminId: cleanAdminId,
                provider: StoreProvider.WOOCOMMERCE,
                isActive: true
            },
        });
        return store;
    }

    private async createCategory(category: CategoryEntity, store: StoreEntity) {
        this.logCtx(`[Category] Creating category: ${category.name} (slug: ${category.slug})`, store);

        const payload: any = {
            name: category.name.trim(),
            slug: category.slug,
        };

        // add image if exists
        const imageUrl = category.image?.trim();
        if (imageUrl) {
            payload.image = { src: this.getImageUrl(imageUrl) };
        }

        try {
            const response = await this.sendRequest(store, {
                method: 'POST',
                url: '/products/categories',
                data: payload,
            });

            // response.data is the created category object
            const created = response?.data ?? response;
            this.logCtx(`[Category] ✓ Successfully created category with external ID: ${created?.id}`, store);
            return created;
        } catch (error) {
            this.logCtxError(`[Category] ✗ Failed to create category: ${error?.message || error}`, store);
            throw error;
        }
    }

    private async updateCategory(category: CategoryEntity, store: StoreEntity, externalId: number) {
        if (!externalId) {
            this.logCtxWarn(`[Category] Skipping update: No external ID provided for category ${category.name}`, store);
            return;
        }

        this.logCtx(`[Category] Updating category: ${category.name} (external ID: ${externalId})`, store);

        const payload: any = {
            name: category.name.trim(),
            slug: category.slug,
        };

        const imageUrl = category.image?.trim();
        if (imageUrl) payload.image = { src: this.getImageUrl(imageUrl) };

        try {
            const response = await this.sendRequest(store, {
                method: 'PUT', // WooCommerce accepts PUT for update
                url: `/products/categories/${externalId}`,
                data: payload,
            });

            const updated = response?.data ?? response;
            this.logCtx(`[Category] ✓ Successfully updated category ${externalId}`, store);
            return updated;
        } catch (error) {
            this.logCtxError(`[Category] ✗ Failed to update category ${externalId}: ${error?.message || error}`, store);
            throw error;
        }
    }

    /**
     * Get categories list. Accepts params object (slug, per_page, page, search, parent)
     * If slug provided, WooCommerce returns an array (possibly one item).
     */
    private async getAllCategories(store: StoreEntity, params: { slug?: string; per_page?: number; page?: number; search?: string } = {}) {
        const filterDesc = params.slug ? ` slug=${params.slug}` : params.search ? ` search=${params.search}` : '';
        this.logCtxDebug(`[Category] Fetching categories${filterDesc}`, store);

        try {
            const response = await this.sendRequest(store, {
                method: 'GET',
                url: '/products/categories',
                params: {
                    per_page: params.per_page ?? 100,
                    page: params.page ?? 1,
                    ...(params.slug ? { slug: params.slug } : {}),
                    ...(params.search ? { search: params.search } : {}),
                },
            });

            // Depending on your BaseStoreProvider, response could be response.data or response directly
            const categories = response?.data ?? response;
            const count = Array.isArray(categories) ? categories.length : 0;
            this.logCtxDebug(`[Category] ✓ Retrieved ${count} categories`, store);
            return categories;
        } catch (error) {
            this.logCtxError(`[Category] ✗ Failed to fetch categories: ${error?.message || error}`, store);
            throw error;
        }
    }

    private async syncWooVariations(
        productId: number,
        variants: ProductVariantEntity[],
        store: StoreEntity,
        attrMap?: Map<string, number>
    ) {
        this.logCtx(`[Variation] Sync started for product ${productId}`, store);

        // 1️⃣ Get existing Woo variations
        const existingResponse = await this.sendRequest(store, {
            method: 'GET',
            url: `/products/${productId}/variations`
        });

        const existingVariations = existingResponse?.data ?? existingResponse ?? [];

        // Map existing by SKU
        const existingMap = new Map<string, any>();
        existingVariations.forEach(v => {
            if (v.sku) existingMap.set(v.sku, v);
        });

        // 2️⃣ Map local variations
        const mappedVariants = this.mapWooVariationsPayload(variants, attrMap || new Map());

        const createVariant: any[] = [];
        const updateVariant: any[] = [];
        const deleteVariant: number[] = [];

        const localSkus = new Set<string>();

        for (const local of mappedVariants) {
            localSkus.add(local.sku);

            const existing = existingMap.get(local.sku);

            if (existing) {
                // Update
                updateVariant.push({
                    id: existing.id,
                    ...local
                });
            } else {
                // Create
                createVariant.push(local);
            }
        }

        // 3️⃣ Detect deleted variations
        for (const existing of existingVariations) {
            if (existing.sku && !localSkus.has(existing.sku)) {
                deleteVariant.push(existing.id);
            }
        }

        // 4️⃣ Batch request
        if (createVariant.length || updateVariant.length || deleteVariant.length) {
            const batchPayload = { create: createVariant, update: updateVariant, delete: deleteVariant };

            const batchResponse = await this.sendRequest(store, {
                method: 'POST',
                url: `/products/${productId}/variations/batch`,
                data: batchPayload
            });
            const responseData = batchResponse?.data ?? batchResponse;

            await this.syncWooVariantsBySku(
                variants,
                responseData,
                store
            );


            this.logCtx(`[Variation] ✓ Synced variations for product ${productId}`, store);
        } else {
            this.logCtx(`[Variation] No variation changes detected`, store);
        }
    }

    private async syncWooVariantsBySku(
        localVariants: ProductVariantEntity[],
        batchResponse: any,
        store: StoreEntity
    ): Promise<void> {

        if (!batchResponse) return;

        const created = batchResponse.create ?? [];
        const updated = batchResponse.update ?? [];

        const allSynced = [...created, ...updated];

        if (!allSynced.length) return;

        // 1️⃣ Build local map by SKU
        const localMap = new Map<string, ProductVariantEntity>();

        for (const local of localVariants) {
            if (!local.sku) continue;
            localMap.set(local.sku.trim(), local);
        }

        const variantsToSave: ProductVariantEntity[] = [];

        // 2️⃣ Match remote → local
        for (const remote of allSynced) {

            const sku = remote?.sku?.trim();

            if (remote?.error) {
                this.logCtxError("[Woo Variations Sync] Error syncing variation: " + remote.error?.message);
                return;
            }
            if (!sku) {
                this.logCtxError(
                    `[Woo Variants Sync] Remote variation missing SKU`,
                    store
                );
                continue;
            }

            const localVariant = localMap.get(sku);

            if (!localVariant) {
                this.logCtxError(
                    `[Woo Variants Sync] No local variant found for SKU ${sku}`,
                    store
                );
                continue;
            }

            // 3️⃣ Update external ID
            localVariant.externalId = remote.id;

            variantsToSave.push(localVariant);
        }

        // 4️⃣ Save in ONE DB call
        if (variantsToSave.length) {
            await this.pvRepo.save(variantsToSave);

            this.logCtx(
                `[Woo Variants Sync] ✓ Synced ${variantsToSave.length} variation(s) external IDs`,
                store
            );
        }
    }
    // Ensure attribute exists globally and return its ID (create if missing)
    private async getOrCreateWooAttribute(store: StoreEntity, attributeName: string): Promise<number> {
        // 1) Try to find attribute by name (or slug)
        const searchResp = await this.sendRequest(store, {
            method: 'GET',
            url: '/products/attributes',
            params: { search: attributeName }
        });

        const attributes = searchResp?.data ?? searchResp ?? [];
        const match = attributes.find((a: any) => a.name.toLowerCase() === attributeName.toLowerCase());
        if (match) return match.id;

        // 2) Create global attribute
        const createResp = await this.sendRequest(store, {
            method: 'POST',
            url: '/products/attributes',
            data: {
                name: attributeName,
                slug: attributeName.toLowerCase().replace(/\s+/g, '-'),
                type: 'select',
                order_by: 'menu_order',
                has_archives: false
            }
        });

        const created = createResp?.data ?? createResp;
        return created.id;
    }

    /**
    * Efficiently ensures all attributes and terms exist globally.
    * Returns a Map of Attribute Name -> Attribute ID.
    */
    private async ensureAttributesForVariants(store: StoreEntity, variants: ProductVariantEntity[]): Promise<Map<string, number>> {
        const attrMap = new Map<string, number>();
        const attrOptionsMap = new Map<string, Set<string>>();

        // 1. Collect all names and values from local variants
        for (const v of variants) {
            for (const [name, val] of Object.entries(v.attributes || {})) {
                const n = name.trim();
                const value = String(val).trim();
                if (!attrOptionsMap.has(n)) attrOptionsMap.set(n, new Set());
                attrOptionsMap.get(n)!.add(value);
            }
        }

        // 2. Process each attribute name
        for (const [attrName, options] of attrOptionsMap.entries()) {
            const attrId = await this.getOrCreateWooAttribute(store, attrName);

            // 3. Optimized: Sync all terms (options) for this attribute in one batch
            await this.syncAttributeTermsInBatch(store, attrId, Array.from(options));

            attrMap.set(attrName, attrId);
        }

        return attrMap;
    }

    /**
     * Fetches all existing terms for an attribute and creates only the missing ones.
     */
    private async syncAttributeTermsInBatch(store: StoreEntity, attributeId: number, neededOptions: string[]) {
        // Fetch existing terms (limit 100 for performance)
        const response = await this.sendRequest(store, {
            method: 'GET',
            url: `/products/attributes/${attributeId}/terms`,
            params: { per_page: 100 }
        });

        const existingTerms = response?.data ?? response ?? [];
        const existingNames = new Set(existingTerms.map((t: any) => t.name.toLowerCase().trim()));

        // Find options that don't exist yet
        const missingOptions = neededOptions.filter(opt => !existingNames.has(opt.toLowerCase().trim()));

        // Create missing terms one by one (WooCommerce doesn't have a batch endpoint for terms)
        for (const option of missingOptions) {
            await this.sendRequest(store, {
                method: 'POST',
                url: `/products/attributes/${attributeId}/terms`,
                data: {
                    name: option.trim(),
                    slug: option.toLowerCase().trim().replace(/\s+/g, '-')
                }
            });
        }
    }
    /**
     * Search single category by slug (returns the first match or null)
     */
    private async getCategoryBySlug(store: StoreEntity, slug: string) {
        if (!slug) return null;
        const categories = await this.getAllCategories(store, { slug: slug.trim(), per_page: 100 });
        return categories?.length > 0 ? categories[0] : null;
    }

    private async getProductBySlug(store: StoreEntity, slug: string) {
        if (!slug) return null;

        const response = await this.sendRequest(store, {
            method: 'GET',
            url: '/products',
            params: { slug: slug.trim(), status: 'publish,draft,private', per_page: 100 },
        });

        const products = response?.data ?? response;
        return products?.length > 0 ? products[0] : null;
    }

    private async createProduct(product: ProductEntity, variants: ProductVariantEntity[], store: StoreEntity, externalCategoryId: string) {
        this.logCtx(`[Product] Creating product: ${product.name}`, store);
        const attrMap = await this.ensureAttributesForVariants(store, variants);

        const payload = await this.mapWooProductPayload(product, variants, externalCategoryId, attrMap);

        try {
            const response = await this.sendRequest(store, {
                method: 'POST',
                url: '/products',
                data: payload
            });

            const created = response?.data ?? response;
            if (variants.length > 1) {
                await this.syncWooVariations(created?.id, variants, store, attrMap);
            }
            this.logCtx(`[Product] ✓ Created with external ID: ${created?.id}`, store);
            return created;

        } catch (error) {
            this.logCtxError(`[Product] ✗ Failed to create: ${error?.response?.data?.message || error?.message}`, store);
            throw error;
        }
    }


    private async updateProduct(product: ProductEntity, variants: ProductVariantEntity[], store: StoreEntity, externalId: string, externalCategoryId: string) {
        if (!externalId) return;

        this.logCtx(`[Product] Updating product ${externalId}`, store);
        const attrMap = await this.ensureAttributesForVariants(store, variants);

        const payload = this.mapWooProductPayload(product, variants, externalCategoryId, attrMap);

        try {
            const response = await this.sendRequest(store, {
                method: 'PUT',
                url: `/products/${externalId}`,
                data: payload
            });

            const updated = response?.data ?? response;
            if (variants.length > 1) {
                await this.syncWooVariations(updated?.id || externalId, variants, store, attrMap);
            }

            this.logCtx(`[Product] ✓ Updated product ${externalId}`, store);
            return response?.data ?? response;

        } catch (error) {
            this.logCtxError(`[Product] ✗ Failed to update ${externalId}: ${error?.message}`, store);
            throw error;
        }
    }


    public async fetchRemoteProducts(store: StoreEntity, ids: string[]): Promise<any[]> {
        if (!ids || ids.length === 0) return [];
        const response = await this.sendRequest(store, {
            method: 'GET',
            url: '/products',
            params: {
                include: ids.join(','), // result set limited to specific IDs
                per_page: 100
            },
        });

        const products = response?.data ?? response;
        if (!Array.isArray(products)) return [];

        // Map WC format to our standardized RemoteProduct structure
        return products.map(p => ({
            slug: p.slug, // The actual text slug from WC
            externalId: String(p.id), // Keep track of ID
            name: p.name,
            variants: (p.variations || []).length > 0 ? [] : [{
                sku: p.sku,
                price: Number(p.price),
                variation_props: [] // Simple product
            }]
        }));
    }

    private async mapWooProductPayload(
        product: ProductEntity,
        variants: ProductVariantEntity[],
        externalCategoryId?: string,
        attrMap?: Map<string, number>
    ) {
        const isVariable = variants.length > 1;

        // 1. Map WooCommerce Attributes Definition
        // We use the attrMap provided by ensureAttributesForVariants
        const attributes = [];
        if (attrMap) {
            let index = 0;
            for (const [name, attrId] of attrMap.entries()) {
                // Collect unique options for this specific attribute from all variants
                const options = new Set<string>();
                variants.forEach(v => {
                    if (v.attributes && v.attributes[name]) {
                        options.add(String(v.attributes[name]).trim());
                    }
                });

                attributes.push({
                    id: attrId, // Links to Global Attribute
                    name: name.trim(),
                    position: index++,
                    visible: true,
                    variation: isVariable, // Only TRUE if it's a Variable product
                    options: Array.from(options)
                });
            }
        }

        return {
            name: product.name.trim(),
            slug: product.slug?.trim(),
            type: isVariable ? "variable" : "simple",
            description: product.description || "",
            short_description: product.description || "",
            // [2025-12-24] Generate clean SKU
            sku: `SKU-${product.slug?.toUpperCase().replace(/-/g, '').substring(0, 8)}-${product.id}`.trim(),

            // STOCK LOGIC: 
            // If variable, we don't manage stock at parent level (variants handle it)
            manage_stock: !isVariable,
            stock_quantity: !isVariable
                ? Math.max(0, (variants[0]?.stockOnHand || 0) - (variants[0]?.reserved || 0))
                : undefined,

            regular_price: String(product.wholesalePrice || 0),
            categories: externalCategoryId ? [{ id: externalCategoryId }] : [],
            attributes: attributes,
            images: [
                ...(product.mainImage ? [{ src: this.getImageUrl(product.mainImage) }] : []),
                ...(product.images?.map(img => ({ src: this.getImageUrl(img.url) })) || [])
            ]
        };
    }

    private mapWooVariationsPayload(
        variants: ProductVariantEntity[],
        attrMap: Map<string, number>
    ) {
        return variants.map(v => ({
            regular_price: String(v.price || 0),
            sale_price: String(v.price || 0),
            sku: String(v.sku ?? ''),
            manage_stock: true,
            stock_quantity: v.stockOnHand - v.reserved,
            attributes: Object.entries(v.attributes || {}).map(([key, value]) => {
                const name = key.trim();
                const option = String(value).trim();
                const id = attrMap.get(name);
                if (id) {
                    return { id, option };
                } else {
                    // Fall back to using name if attribute is not global (rare)
                    return { name, option };
                }
            })
        }));
    }

    private mapInternalStatusToWoo(internalStatus: OrderStatus): string | null {
        const map: Record<OrderStatus, string> = {

            // Pending stage
            [OrderStatus.NEW]: "pending",
            [OrderStatus.UNDER_REVIEW]: "pending",
            [OrderStatus.POSTPONED]: "on-hold",
            [OrderStatus.NO_ANSWER]: "on-hold",

            // Confirmed
            [OrderStatus.CONFIRMED]: "processing",

            // Preparing / shipping
            [OrderStatus.PREPARING]: "processing",
            [OrderStatus.READY]: "processing",
            [OrderStatus.SHIPPED]: "processing",

            // Delivered
            [OrderStatus.DELIVERED]: "completed",

            // Cancel states
            [OrderStatus.WRONG_NUMBER]: "cancelled",
            [OrderStatus.OUT_OF_DELIVERY_AREA]: "cancelled",
            [OrderStatus.DUPLICATE]: "cancelled",
            [OrderStatus.CANCELLED]: "cancelled",

            // Return states
            [OrderStatus.RETURNED]: "refunded",
        };

        return map[internalStatus] || null;
    }



    public async updateOrderStatus(order: OrderEntity, store: StoreEntity) {

        if (!order.externalId) return;

        const remoteStatus = this.mapInternalStatusToWoo(order.status.code as OrderStatus);

        if (!remoteStatus) {
            this.logger.warn(
                `No Woo status mapping found for order (${order.id}) | local status: ${order.status.code}`
            );
            return;
        }

        try {
            const batchPayload = {
                update: [
                    {
                        id: Number(order.externalId),
                        status: remoteStatus
                    }
                ]
            };

            return await this.sendRequest(store, {
                method: 'POST',
                url: `/orders/batch`,
                data: batchPayload
            });

        } catch (error) {
            this.handleError(error, "updateOrderStatus");
        }
    }

    // ========================================================================
    // PUBLIC SYNC methods
    // ========================================================================
    public async syncCategory({
        category,
        relatedAdminId,
        slug,
    }: {
        category: CategoryEntity;
        relatedAdminId?: string;
        slug?: string;
    }) {
        const { adminId } = category;
        const finalAdmin = relatedAdminId ? relatedAdminId : adminId;

        const activeStore = await this.getStoreForSync(finalAdmin);
        if (!activeStore) {
            this.logger.debug(`[WooCommerce Sync] Skipping: No active WooCommerce store for admin ${finalAdmin}`);
            return;
        }

        const checkSlug = slug ? slug : category.slug;
        const remoteCategory = await this.getCategoryBySlug(activeStore, checkSlug);

        if (remoteCategory) {
            // update using remoteCategory.id
            return await this.updateCategory(category, activeStore, remoteCategory.id);
        } else {
            // create new
            return await this.createCategory(category, activeStore);
        }
    }


    public async syncProduct({
        product,
        variants,
        slug
    }: {
        product: ProductEntity,
        variants: ProductVariantEntity[],
        slug?: string
    }) {

        this.logCtx(
            `[Sync] Starting single product sync | Product: ${product.name} | Variant Count: ${variants.length}`,
            null,
            product.adminId
        );

        // 1️⃣ Validate Store
        if (!product.store || product.store.provider !== StoreProvider.WOOCOMMERCE) {
            this.logCtxWarn(
                `[Sync] Skipping sync: Store not found or provider is not WOOCOMMERCE`,
                null,
                product.adminId
            );
            return;
        }

        const activeStore = await this.getStoreForSync(product.adminId);

        if (!activeStore) {
            this.logCtxWarn(
                `[Sync] Skipping sync: No active WooCommerce store enabled`,
                activeStore,
                product.adminId
            );
            return;
        }

        try {

            // 2️⃣ ⚡ RESOLVE CATEGORY FIRST ⚡
            let wooCategory = null;

            if (product.category) {
                this.logCtx(
                    `[Sync] Syncing category: ${product.category.name}`,
                    activeStore
                );

                wooCategory = await this.syncCategory({
                    category: product.category,
                    slug: product.category.slug,
                    relatedAdminId: product.adminId
                });
            }

            // 3️⃣ Check existence by SLUG (WooCommerce way)
            const checkSlug = slug ? slug : product.slug;

            this.logCtx(
                `[Sync] Checking if product exists with slug: ${checkSlug}`,
                activeStore
            );
            this.logCtx(`[Sync] Checking if product exists with slug: ${checkSlug}`, activeStore);

            const remoteProduct = await this.getProductBySlug(activeStore, checkSlug);

            if (remoteProduct) {

                this.logCtx(
                    `[Sync] Product already exists externally (ID: ${remoteProduct.id}), updating...`,
                    activeStore
                );

                return await this.updateProduct(
                    product,
                    variants,
                    activeStore,
                    remoteProduct.id,
                    wooCategory?.id
                );

            } else {

                this.logCtx(
                    `[Sync] Product does not exist externally, creating...`,
                    activeStore
                );

                return await this.createProduct(
                    product,
                    variants,
                    activeStore,
                    wooCategory?.id
                );
            }

        } catch (error) {

            this.logCtxError(
                `[Sync] ✗ Failed to sync product ${product.name}: ${error.message}`,
                activeStore,
                product.adminId
            );

            throw error;
        }
    }

    public async syncOrderStatus(order: OrderEntity) {
        this.logCtx(`[Sync] Starting order status sync | Order: ${order.orderNumber} | Status: ${order.status}`, null, order.adminId);

        try {
            const store = await this.getStoreForSync(order.adminId);
            if (!store) {
                this.logCtxWarn(`[Sync] Skipping order status sync: No active store enabled`, null, order.adminId);
                return;
            }

            await this.updateOrderStatus(order, store);
            this.logCtx(`[Sync] ✓ Order status synced successfully`, store);
        } catch (error) {
            this.logCtxError(`[Sync] ✗ Failed to sync order status for ${order.orderNumber}: ${error.message}`, null, order.adminId);
        }
    }

    private async syncCategoriesCursor(store: StoreEntity): Promise<Map<number, string>> {
        this.logCtx(`[Sync] Starting category synchronization (Individual API calls)`, store);

        const categoryMap = new Map<number, string>();
        let lastId = 0;
        let hasMore = true;
        let stats = { processed: 0, created: 0, updated: 0 };

        while (hasMore) {
            // 1. Fetch local batch using cursor pagination
            const localBatch = await this.categoryRepo.find({
                where: { adminId: store.adminId, id: MoreThan(lastId) },
                order: { id: 'ASC' } as any,
                take: 30 // Smaller batch size recommended for individual API calls
            });

            if (localBatch.length === 0) {
                hasMore = false;
                this.logCtx(`[Sync] No more local categories to process`, store);
                break;
            }

            this.logCtx(`[Sync] Processing batch of ${localBatch.length} categories`, store);

            for (const cat of localBatch) {
                try {
                    const cleanSlug = cat.slug.trim();

                    // 2. Check existence by slug using your helper
                    const existingCategory = await this.getCategoryBySlug(store, cleanSlug);

                    const extId = existingCategory?.id;

                    // 3. Use your requested logic: Update if exists, otherwise create
                    const response = extId
                        ? await this.updateCategory(cat, store, extId)
                        : await this.createCategory(cat, store);

                    // 4. Update the map and stats
                    const finalId = extId ? String(extId) : String(response.id);
                    categoryMap.set(cat.id, finalId);

                    if (extId) {
                        stats.updated++;
                    } else {
                        stats.created++;
                    }
                } catch (error) {
                    this.logCtxError(`[Sync] Error processing category ${cat.name} (ID: ${cat.id}): ${error.message}`, store);
                }
                stats.processed++;
            }

            // Update the cursor for the next iteration
            lastId = localBatch[localBatch.length - 1].id;
        }

        this.logCtx(`[Sync] ✓ Category sync completed | Total: ${stats.processed} | Created: ${stats.created} | Updated: ${stats.updated}`, store);
        return categoryMap;
    }


    private async syncProductsCursor(store: StoreEntity, categoryMap: Map<number, string>) {
        this.logCtx(`[Sync] Starting product synchronization (Individual API calls)`, store);

        let lastId = 0;
        let hasMore = true;
        let totalProcessed = 0;
        let totalCreated = 0;
        let totalUpdated = 0;
        let totalErrors = 0;

        while (hasMore) {
            // 1. Fetch local batch using cursor pagination
            const localBatch = await this.productsRepo.find({
                where: { storeId: store.id, adminId: store.adminId, id: MoreThan(lastId) },
                relations: ['variants', 'category'], // Load category to get the local ID for mapping
                order: { id: 'ASC' } as any,
                take: 20 // Smaller batch size because products have variants and images
            });

            if (localBatch.length === 0) {
                hasMore = false;
                this.logCtx(`[Sync] No more products to process`, store);
                break;
            }

            this.logCtx(`[Sync] Processing batch of ${localBatch.length} products (IDs: ${localBatch[0].id}-${localBatch[localBatch.length - 1].id})`, store);

            for (const product of localBatch) {
                try {
                    // 2. Fetch variants for this specific product
                    const variants = await this.pvRepo.find({
                        where: { productId: product.id }
                    });

                    // 3. Check if product exists by slug using your helper
                    const remoteProduct = await this.getProductBySlug(store, product.slug);

                    // 4. Resolve the external category ID from the map created in Phase 1
                    const externalCategoryId = product.category
                        ? categoryMap.get(product.category.id)
                        : undefined;

                    // 5. Use individual methods for update or create
                    if (remoteProduct) {
                        {

                            await this.updateProduct(
                                product,
                                variants,
                                store,
                                remoteProduct.id,
                                externalCategoryId
                            );
                            totalUpdated++;
                        }
                    } else {
                        await this.createProduct(
                            product,
                            variants,
                            store,
                            externalCategoryId
                        );

                        totalCreated++;
                    }

                    totalProcessed++;
                } catch (error) {
                    this.logCtxError(`[Sync] Error processing product ${product.name} (ID: ${product.id}): ${error.message}`, store);
                    totalErrors++;
                }
            }

            // Update the cursor to the last processed ID
            lastId = localBatch[localBatch.length - 1].id;
        }

        this.logCtx(`[Sync] ✓ Product sync completed | Total: ${totalProcessed} | Errors: ${totalErrors}`, store);
    }

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

            if (store.adminId) {
                this.appGateway.emitStoreSyncStatus(String(store.adminId), {
                    storeId: store.id,
                    provider: store.provider,
                    status: SyncStatus.SYNCED,
                });
            }
        } catch (error) {
            this.logCtxError(`[Sync] ========================================`, store);
            this.logCtxError(`[Sync] ✗ FULL STORE SYNC FAILED`, store);
            this.logCtxError(`[Sync] Error: ${error.message}`, store);
            this.logCtxError(`[Sync] ========================================`, store);

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
        }
    }

    private mapExternalStatusToInternal(externalStatus: string): OrderStatus | null {
        const map: Record<string, OrderStatus> = {
            "pending": OrderStatus.NEW,
            "on-hold": OrderStatus.UNDER_REVIEW,
            "processing": OrderStatus.PREPARING,
            "completed": OrderStatus.DELIVERED,
            "cancelled": OrderStatus.CANCELLED,
            "failed": OrderStatus.CANCELLED,
            "refunded": OrderStatus.RETURNED,
            "trash": OrderStatus.CANCELLED,
        };

        return map[externalStatus] || null;
    }

    public verifyWebhookAuth(headers: Record<string, any>, body: any, store: StoreEntity, req?: any, action?: "create" | "update"): boolean {
        const signature = headers['x-wc-webhook-signature'];
        const type = headers['x-wc-webhook-topic'];
        const savedSecret = type === 'order.update' ? store?.credentials?.webhookUpdateStatusSecret : type === 'order.created' ? store?.credentials?.webhookCreateOrderSecret : null;

        if (!signature || !savedSecret) return false;

        // body must be the raw string for the HMAC to match
        const rawBody = req.rawBody;

        const expected = crypto
            .createHmac('sha256', savedSecret)
            .update(rawBody, 'utf8')
            .digest('base64');

        return expected === signature;
    }
    public mapWebhookUpdate(body: any): WebhookOrderUpdatePayload {
        const externalStatus = body.status; // WooCommerce uses 'status'
        const internalStatus = this.mapExternalStatusToInternal(externalStatus);

        if (!internalStatus) return null;

        return {
            externalId: String(body.id),
            remoteStatus: externalStatus,
            mappedStatus: internalStatus
        };
    }

    public async mapWebhookCreate(body: any, store: StoreEntity): Promise<WebhookOrderPayload> {
        const paymentMethod = this.mapPaymentMethod(body.payment_method);
        const lineItems = body.line_items || [];
        const uniqueIds = [...new Set(lineItems.map((item: any) => String(item.product_id)))];

        const remoteProducts = await this.fetchRemoteProducts(store, uniqueIds as string[]);

        // 3. Create a lookup map: { "123": "actual-product-slug" }
        const idToSlugMap = new Map<string, string>();
        remoteProducts.forEach(p => idToSlugMap.set(p.externalId, p.slug));
        return {
            externalId: String(body.id),
            full_name: `${body.billing?.first_name} ${body.billing?.last_name}`.trim(),
            phone: body.billing?.phone || "",
            address: `${body.billing?.address_1} ${body.billing?.address_2}`.trim(),
            government: body.billing?.city || "Unknown",
            payment_method: paymentMethod,
            status: ['processing', 'completed'].includes(body.status) && paymentMethod !== PaymentMethod.CASH_ON_DELIVERY
                ? PaymentStatus.PAID
                : PaymentStatus.PENDING,
            shipping_cost: Number(body.shipping_total || 0),

            cart_items: lineItems.map((item: any) => {
                const productId = String(item.product_id);
                const realSlug = idToSlugMap.get(productId) || productId;

                return {
                    product_slug: realSlug,
                    quantity: item.quantity,
                    price: Number(item.price),
                    variant: item.variation_id ? {
                        variation_props: (item.meta_data || [])
                            .filter((meta: any) => meta.key.startsWith('pa_'))
                            .map((meta: any) => ({
                                name: meta.key.replace('pa_', ''),
                                value: meta.value
                            }))
                    } : undefined
                };
            })
        };
    }
    private mapPaymentMethod(method: string): PaymentMethod {
        switch (method?.toLowerCase()) {
            case 'cod': return PaymentMethod.CASH_ON_DELIVERY;
            case 'bacs': return PaymentMethod.BANK_TRANSFER;
            case 'paypal': return PaymentMethod.WALLET;
            case 'ppcp-gateway': return PaymentMethod.CARD;
            case 'stripe': return PaymentMethod.CARD;
            case 'woocommerce_payments': return PaymentMethod.CARD;
            // add more gateways as needed
            default: return PaymentMethod.UNKNOWN;
        }
    }

    public async syncProductsFromProvider(store: StoreEntity, slugs?: string[], manager?: any): Promise<void> {
        const adminId = store.adminId;
        if (!slugs || slugs.length === 0) {
            this.logger.warn(`[Reverse Sync] No slugs provided to sync for store: ${store.storeUrl}`);
            return;
        }

        for (const slug of slugs) {
            try {
                // 1. Fetch remote product by slug
                const remoteProduct = await this.getProductBySlug(store, slug);
                if (!remoteProduct) {
                    this.logger.warn(`[Reverse Sync] Product with slug ${slug} not found on provider.`);
                    continue;
                }

                // 2. Fetch all variations for this product
                let remoteVariants: any[] = [];
                if (remoteProduct.variations && remoteProduct.variations.length > 0) {
                    const response = await this.sendRequest(store, {
                        method: 'GET',
                        url: `/products/${remoteProduct.id}/variations`,
                        params: { per_page: 100 }
                    });
                    remoteVariants = response?.data ?? response ?? [];
                }

                // 3. Map to unified payload and delegate to shared sync logic
                const unified = this.mapRemoteProductToUnified(remoteProduct, remoteVariants);
                await this.mainStoresService.syncExternalProductPayloadToLocal(adminId, store, unified, manager);

                this.logger.log(`[Reverse Sync] Successfully processed: ${slug.trim()}`);
            } catch (error) {
                this.logger.error(`[Reverse Sync] Error syncing slug ${slug}: ${error.message}`);
            }
        }
    }

    /**
     * Sync a remote WooCommerce product and its variations to local DB using manager
     */
    private async syncExternalProductToLocal(adminId: string, store: StoreEntity, remoteProduct: any, remoteVariants: any[], manager: any): Promise<ProductEntity> {
        // Map remote product and variations to local DTOs
        const userContext = {
            id: store.adminId,
            adminId: store.adminId,
            role: { name: 'admin' }
        };

        // Map category: use first category if available
        let localCategoryId: number | null = null;
        if (remoteProduct.categories && remoteProduct.categories.length > 0) {
            const remoteCat = remoteProduct.categories[0];
            // Try to find or create local category by slug
            const categoryRepo = manager.getRepository(CategoryEntity);
            let category = await categoryRepo.findOne({ where: { adminId: userContext.adminId, slug: remoteCat.slug } });
            if (!category) {
                // Create local category if not exists
                category = categoryRepo.create({
                    adminId: userContext.adminId,
                    name: remoteCat.name,
                    slug: remoteCat.slug
                });
                category = await categoryRepo.save(category);
            }
            localCategoryId = category.id;
        }

        // Map images
        const images = (remoteProduct.images || []).map((img: any) => ({ url: img.src }));

        // Map variants
        let combinations: any[] = [];
        if (remoteVariants && remoteVariants.length > 0) {
            combinations = remoteVariants.map((v: any) => {
                // Map attributes to { [name]: value }
                const atts = (v.attributes || []).reduce((acc: any, attr: any) => {
                    acc[attr.name] = attr.option;
                    return acc;
                }, {});
                return {
                    sku: v.sku || null,
                    price: parseFloat(v.price) || 0,
                    stockOnHand: v.stock_quantity ?? 0,
                    attributes: atts,
                    key: v.sku || `variant_${remoteProduct.id}_${v.id}`
                };
            });
        } else {
            // Simple product (no variations)
            combinations = [{
                sku: remoteProduct.sku || null,
                price: parseFloat(remoteProduct.price) || 0,
                stockOnHand: remoteProduct.stock_quantity ?? 0,
                attributes: {},
                key: remoteProduct.sku || `simple_${remoteProduct.id}`
            }];
        }

        // Build product DTO
        const productDto = {
            name: remoteProduct.name,
            slug: remoteProduct.slug,
            description: remoteProduct.description,
            wholesalePrice: parseFloat(remoteProduct.price) || 0,
            lowestPrice: parseFloat(remoteProduct.price) || 0,
            storeId: store.id,
            categoryId: localCategoryId,
            mainImage: images[0]?.url || '',
            images,
            combinations,
            upsellingEnabled: false,
        };

        // Upsert product
        const productsRepository = manager.getRepository(ProductEntity);
        let existingProduct = await productsRepository.findOne({ where: { adminId, slug: productDto.slug } });
        let savedProduct: ProductEntity;
        if (existingProduct) {
            manager.merge(ProductEntity, existingProduct, {
                name: productDto.name,
                slug: productDto.slug,
                description: productDto.description,
                wholesalePrice: productDto.wholesalePrice,
                lowestPrice: productDto.lowestPrice,
                storeId: productDto.storeId,
                categoryId: productDto.categoryId,
                mainImage: productDto.mainImage
            });
            savedProduct = await productsRepository.save(existingProduct);
        } else {
            const newProduct = manager.create(ProductEntity, {
                name: productDto.name,
                slug: productDto.slug,
                description: productDto.description,
                wholesalePrice: productDto.wholesalePrice,
                lowestPrice: productDto.lowestPrice,
                storeId: productDto.storeId,
                categoryId: productDto.categoryId,
                mainImage: productDto.mainImage,
                adminId: adminId
            });
            savedProduct = await productsRepository.save(newProduct);
        }
        // Note: You may want to upsert variants/SKUs as well, similar to EasyOrder, if you have a service for that.
        return savedProduct;
    }

    private mapRemoteProductToUnified(remoteProduct: any, remoteVariants: any[]): UnifiedProductDto {
        let variants: UnifiedProductVariantDto[] = [];

        if (remoteVariants && remoteVariants.length > 0) {
            variants = remoteVariants.map((v: any, index: number) => {
                const attributes = (v.attributes || []).reduce((acc: Record<string, string>, attr: any) => {
                    acc[attr.name] = attr.option;
                    return acc;
                }, {} as Record<string, string>);

                const sku = v.sku || null;
                const price = parseFloat(v.price) || 0;
                const stockOnHand = v.stock_quantity ?? 0;
                const key = sku || `variant_${remoteProduct.id}_${v.id || index}`;

                return {
                    sku,
                    price,
                    stockOnHand,
                    attributes,
                    key,
                };
            });
        } else {
            const sku = remoteProduct.sku || null;
            const price = parseFloat(remoteProduct.price) || 0;
            const stockOnHand = remoteProduct.stock_quantity ?? 0;
            const key = sku || `simple_${remoteProduct.id}`;

            variants = [
                {
                    sku,
                    price,
                    stockOnHand,
                    attributes: {},
                    key,
                },
            ];
        }

        const images: string[] = (remoteProduct.images || []).map((img: any) => img.src);

        const category = remoteProduct.categories && remoteProduct.categories.length > 0
            ? {
                slug: remoteProduct.categories[0].slug,
                name: remoteProduct.categories[0].name || remoteProduct.categories[0].slug,
                thumb: remoteProduct.categories[0].image?.src ?? null,
            }
            : null;

        return {
            externalId: remoteProduct.id ? String(remoteProduct.id) : undefined,
            name: remoteProduct.name,
            slug: remoteProduct.slug,
            description: remoteProduct.description,
            basePrice: parseFloat(remoteProduct.price) || 0,
            mainImage: images[0] || "",
            images,
            category,
            variants,
        };
    }

    async validateProviderConnection(store: StoreEntity): Promise<boolean> {
        const { storeUrl, credentials } = store;

        // WooCommerce requires both Key and Secret
        const consumerKey = credentials?.apiKey;
        const consumerSecret = credentials?.clientSecret;

        if (!storeUrl || !consumerKey || !consumerSecret) {
            this.logger.error(`[WooCommerce] Validation failed: Missing credentials or URL`);
            return false;
        }

        // We try to fetch 1 order to verify 'Read' permissions
        const url = this.getWooCommerceURL(storeUrl, '/orders');

        try {
            const response = await axios.get(url, {
                params: { per_page: 1 },
                auth: {
                    username: consumerKey.trim(),    // Consumer Key
                    password: consumerSecret.trim(), // Consumer Secret
                },
                timeout: 5000,
            });

            // If we get a 200, the connection is solid
            return response.status >= 200 && response.status < 300;
        } catch (error) {
            const status = error.response?.status;

            if (status === 401) {
                this.logger.warn(`[WooCommerce] 401 Unauthorized: Invalid Key or Secret for ${storeUrl}`);
            } else if (status === 404) {
                this.logger.warn(`[WooCommerce] 404 Not Found: Check if WooCommerce is installed at ${storeUrl}`);
            } else {
                this.logger.error(`[WooCommerce] Connection error: ${error.message}`);
            }

            return false;
        }
    }
}
