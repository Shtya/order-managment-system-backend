import { forwardRef, Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { BaseStoreProvider, WebhookOrderPayload, WebhookOrderUpdatePayload, UnifiedProductDto, UnifiedProductVariantDto, IBundleSyncProvider, MappedProductDto } from "./BaseStoreProvider";
import { InjectRepository } from "@nestjs/typeorm";
import { CategoryEntity } from "entities/categories.entity";
import { BundleEntity, BundleItemEntity } from "entities/bundle.entity";
import { StoreEntity, StoreProvider, SyncStatus } from "entities/stores.entity";
import { ProductSyncAction, ProductSyncStateEntity, ProductSyncStatus } from "entities/product_sync_error.entity";
import { ProductEntity, ProductType, ProductVariantEntity } from "entities/sku.entity";
import { StoresService } from "../stores.service";
import { OrdersService } from "src/orders/services/orders.service";
import { ProductsService } from "src/products/products.service";
import { CategoriesService } from "src/category/category.service";
import { RedisService } from "common/redis/RedisService";
import { EncryptionService } from "common/encryption.service";
import { In, MoreThan, Repository } from "typeorm";
import { OrderEntity, OrderStatus, PaymentMethod, PaymentStatus } from "entities/order.entity";
import axios, { AxiosRequestConfig } from "axios";
import * as crypto from 'crypto';
import { AppGateway } from "common/app.gateway";
import { ProductSyncStateService } from "src/product-sync-state/product-sync-state.service";


@Injectable()
export default class WooCommerceService extends BaseStoreProvider {


    maxBundleItems?: number;
    supportBundle: boolean = false;
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
        @InjectRepository(ProductSyncStateEntity) protected readonly productSyncStateRepo: Repository<ProductSyncStateEntity>,
        @Inject(forwardRef(() => CategoriesService))
        private readonly categoriesService: CategoriesService,
        private readonly productSyncStateService: ProductSyncStateService,
        protected readonly redisService: RedisService,
        protected readonly encryptionService: EncryptionService,
        private readonly appGateway: AppGateway,
    ) {
        super(storesRepo, categoryRepo, productSyncStateRepo, encryptionService, mainStoresService, 400, StoreProvider.WOOCOMMERCE)

    }

    public async getFullProductById(
        store: StoreEntity,
        id: string
    ): Promise<MappedProductDto> {
        try {
            if (!id) return null;

            // 🔥 run both requests in parallel
            const [productResp, variationsResp] = await Promise.all([
                this.sendRequest(store, {
                    method: 'GET',
                    url: `/products/${id}`,
                }),
                this.sendRequest(store, {
                    method: 'GET',
                    url: `/products/${id}/variations`,
                }),
            ]);

            const product = productResp?.data ?? productResp;
            const variations = variationsResp?.data ?? variationsResp ?? [];

            return this.mapWooCommerceProductToDto(product, variations, store);

        } catch (error: any) {
            this.logger.error(
                `[Product] Failed to fetch product by id ${id}: ${error.message}`
            );
            throw error;
        }
    }
    public async getProduct(store: StoreEntity, id: string) {
        try {
            if (!id) return null;
            const status = 'any';
            const response = await this.sendRequest(store, {
                method: 'GET',
                url: `/products/${id}`,
            });

            const product = response?.data ?? response;
            return product;

        } catch (error: any) {
            return
        }
    }

    private async mapWooCommerceProductToDto(remote: any, remoteVariations: any, store: StoreEntity): Promise<MappedProductDto> {

        const variations = (remote.attributes || [])
            .filter((attr: any) => attr.variation === true) // نأخذ فقط الخصائص التي تستخدم كمتغيرات
            .map((attr: any) => ({
                id: attr.id || 0,
                name: attr.name?.trim(),
                props: (attr.options || []).map((option: any, index: number) => ({
                    id: index, // ووكمرس يعطي الخيارات كمصفوفة نصوص غالباً
                    name: attr.name?.trim(),
                    value: option?.trim(),
                })),
            }));


        const variants = (remoteVariations || []).map((v: any) => ({
            price: Number(v.regular_price || v.price) || 0,
            expense: 0,
            quantity: Number(v.stock_quantity) || 0,
            sku: String(v.sku || ""),
            variation_props: (v.attributes || []).map((attr: any) => ({
                variation: attr.name?.trim(),
                variation_prop: String(attr.option)?.trim(),
            })),
        }));

        // 3. إذا كان المنتج بسيط (Simple) ولا يوجد به Variants، ننشئ Variant افتراضي
        if (variants.length === 0 && remote.type === 'simple') {
            variants.push({
                price: Number(remote.price) || 0,
                expense: 0,
                quantity: Number(remote.stock_quantity) || 0,
                sku: String(remote.sku || ""),
                variation_props: [],
            });
        }
        // let upsellings: { id, name, mainImage, }[] = [];
        // const upsellRemoteIds = remote.upsell_ids || [];

        // if (upsellRemoteIds.length > 0) {
        //     const remoteIds = upsellRemoteIds.map(id => String(id));

        //     const syncStates = await this.productSyncStateRepo.find({
        //         where: {
        //             adminId: store.adminId,
        //             storeId: store.id,
        //             externalStoreId: store.externalStoreId,
        //             remoteProductId: In(remoteIds)
        //         },
        //         relations: ["product"]
        //     });

        //     upsellings = syncStates.map(s => ({ id: `#${s.productId}`, name: s.product?.name, mainImage: s.product.mainImage, }));
        // }

        return {
            name: remote.name?.trim(),
            price: Number(remote.price) || 0,
            type: remote.type === 'simple' ? ProductType.SINGLE : ProductType.VARIABLE,
            expense: 0,
            description: remote.description,
            slug: remote.slug?.replaceAll('_', '-'),
            sku: remote.sku || "",
            thumb: remote.images?.[0]?.src || "",
            images: (remote.images || []).map((img: any) => img.src),
            categories: (remote.categories || []).map((c: any) => ({
                id: String(c.id),
                name: c.name,
            })),
            upsellings: [],
            quantity: Number(remote.stock_quantity) || 0,
            variations,
            variants,
        };
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
                `Missing WooCommerce integration keys for store ${store?.name}`
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
        attempt = 0,
        retry = true
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
        return await super.sendRequest(store, baseConfig, attempt, retry);
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

        const payload: any = {
            name: category.name.trim(),
            slug: category.slug,
        };

        // add image if exists
        const imageUrl = category.image?.trim();
        if (imageUrl) {
            payload.image = { src: this.getImageUrl(imageUrl) };
        }

        const response = await this.sendRequest(store, {
            method: 'POST',
            url: '/products/categories',
            data: payload,
        });

        // response.data is the created category object
        const created = response?.data ?? response;
        return created;

    }

    private async updateCategory(category: CategoryEntity, store: StoreEntity, externalId: string) {
        if (!externalId) {
            throw new Error(`No externalId provided for category ${category?.name}`)
        }

        const payload: any = {
            name: category.name.trim(),
            slug: category.slug,
        };

        const imageUrl = category.image?.trim();
        if (imageUrl) payload.image = { src: this.getImageUrl(imageUrl) };

        const response = await this.sendRequest(store, {
            method: 'PUT', // WooCommerce accepts PUT for update
            url: `/products/categories/${externalId}`,
            data: payload,
        });

        const updated = response?.data ?? response;
        return updated;

    }

    /**
     * Get categories list. Accepts params object (slug, per_page, page, search, parent)
     * If slug provided, WooCommerce returns an array (possibly one item).
     */
    private async getAllCategories(store: StoreEntity, params: { slug?: string; per_page?: number; page?: number; search?: string } = {}) {
        const filterDesc = params.slug ? ` slug=${params.slug}` : params.search ? ` search=${params.search}` : '';

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
        return categories;

    }

    private async syncWooVariations(
        productId: string,
        variants: ProductVariantEntity[],
        store: StoreEntity,
        attrMap?: Map<string, string>
    ) {

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


        } else {

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
                return;
            }
            if (!sku) {
                continue;
            }

            const localVariant = localMap.get(sku);

            if (!localVariant) {
                continue;
            }

            // 3️⃣ Update external ID
            localVariant.externalId = remote.id;

            variantsToSave.push(localVariant);
        }

        // 4️⃣ Save in ONE DB call
        if (variantsToSave.length) {
            await this.pvRepo.save(variantsToSave);
        }
    }
    private generateWooSlug(name: string, prefex = 'attr'): string {
        // 1) Normalize
        let slug = name
            ?.toLowerCase()
            .replace(/\s+/g, '-')       // استبدال المسافات بواصلات
            .replace(/[^\w-]+/g, '')    // إزالة أي رموز غير مسموحة
            .substring(0, 28)           // قص النص عند 28 حرف
            .replace(/-+$/, '');

        // 2) limit length
        slug = slug.substring(0, 28);

        // 3) fallback if empty or invalid
        if (!slug || slug === '-') {
            const random = Math.random().toString(36).substring(2, 8);
            slug = `${prefex}-${random}`; // fallback safe slug
        }

        return slug;
    } s
    // Ensure attribute exists globally and return its ID (create if missing)
    private async getOrCreateWooAttribute(store: StoreEntity, attributeName: string): Promise<string> {
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
                slug: this.generateWooSlug(attributeName),
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
    private async ensureAttributesForVariants(store: StoreEntity, variants: ProductVariantEntity[]): Promise<Map<string, string>> {
        const attrMap = new Map<string, string>();
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
    private async syncAttributeTermsInBatch(store: StoreEntity, attributeId: string, neededOptions: string[]) {
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
        const status = 'any';
        const response = await this.sendRequest(store, {
            method: 'GET',
            url: '/products',
            params: { slug: slug.trim(), status: status, per_page: 100 },
        });

        const products = response?.data ?? response;
        return products?.length > 0 ? products[0] : null;
    }

    private async createProduct(product: ProductEntity, variants: ProductVariantEntity[], store: StoreEntity, externalCategoryId: string) {
        const activeVariants = variants.filter(v => v.isActive);
        const attrMap = await this.ensureAttributesForVariants(store, activeVariants);

        const payload = await this.mapWooProductPayload(product, activeVariants, externalCategoryId, attrMap, store);

        const response = await this.sendRequest(store, {
            method: 'POST',
            url: '/products',
            data: payload
        });

        const created = response?.data ?? response;
        await this.syncWooVariations(created?.id, activeVariants, store, attrMap);

        return created;


    }


    private async updateProduct(product: ProductEntity, variants: ProductVariantEntity[], store: StoreEntity, externalId: string, externalCategoryId: string) {
        if (!externalId)
            throw new Error(`No externalId provided for product ${product?.name}`)

        const activeVariants = variants.filter(v => v.isActive);
        const attrMap = await this.ensureAttributesForVariants(store, activeVariants);

        const payload = await this.mapWooProductPayload(product, activeVariants, externalCategoryId, attrMap, store);


        const response = await this.sendRequest(store, {
            method: 'PUT',
            url: `/products/${externalId}`,
            data: payload
        });

        const updated = response?.data ?? response;
        await this.syncWooVariations(updated?.id || externalId, activeVariants, store, attrMap);

        return response?.data ?? response;


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
        return products;
    }

    protected async mapWooProductPayload(
        product: ProductEntity,
        variants: ProductVariantEntity[],
        externalCategoryId?: string,
        attrMap?: Map<string, string>,
        store?: StoreEntity,
        bundledItemsData?: any[]
    ) {
        const isVariable = variants.length > 1;
        const isBundle = bundledItemsData && bundledItemsData.length > 0;

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

        // const upsellIds = await this.getUpsellIds(product, store);
        const upsellIds = [];

        return {
            name: product.name.trim(),
            slug: product.slug?.trim(),
            type: isBundle ? "bundle" : (isVariable ? "variable" : "simple"),
            description: product.description || "",
            short_description: product.description || "",
            // [2025-12-24] Generate clean unique SKU for WooCommerce
            sku: `SKU-${product.slug?.toUpperCase().replace(/-/g, '').substring(0, 8)}-${product.id}${isBundle ? '-BUNDLE' : ''}`.trim(),

            // STOCK LOGIC: 
            // If variable or bundle, we don't manage stock at parent level (variants handle it)
            manage_stock: !isVariable && !isBundle,
            stock_quantity: (!isVariable && !isBundle)
                ? Math.max(0, (variants[0]?.stockOnHand || 0) - (variants[0]?.reserved || 0))
                : undefined,

            regular_price: String(product.salePrice || 0),
            categories: externalCategoryId ? [{ id: externalCategoryId }] : [],
            attributes: attributes,
            upsell_ids: upsellIds,
            bundled_items: isBundle ? bundledItemsData : undefined,
            images: [
                ...(product.mainImage ? [{ src: this.getImageUrl(product.mainImage) }] : []),
                ...(product.images?.map(img => ({ src: this.getImageUrl(img.url) })) || [])
            ]
        };
    }

    protected async getUpsellIds(product: ProductEntity, store: StoreEntity): Promise<string[]> {
        if (!product.upsellingProducts?.length) return [];

        const upsellIds: string[] = [];

        for (const upsell of product.upsellingProducts) {
            if (!upsell.productId) continue;

            const localProduct = await this.productsRepo.findOne({
                where: { id: upsell.productId },
            });

            if (!localProduct) continue;

            const syncedProduct = await this.syncProduct({ productId: localProduct.id });

            if (syncedProduct) {
                upsellIds.push(syncedProduct.id);
            }
        }

        return upsellIds;
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
            [OrderStatus.PRINTED]: "processing",

            // Preparing / shipping
            [OrderStatus.PREPARING]: "processing",
            [OrderStatus.READY]: "processing",
            [OrderStatus.PACKED]: "processing",
            [OrderStatus.SHIPPED]: "processing",
            [OrderStatus.DISTRIBUTED]: "processing",

            // Delivered
            [OrderStatus.DELIVERED]: "completed",

            // Cancel states
            [OrderStatus.FAILED_DELIVERY]: "cancelled",
            [OrderStatus.WRONG_NUMBER]: "cancelled",
            [OrderStatus.OUT_OF_DELIVERY_AREA]: "cancelled",
            [OrderStatus.DUPLICATE]: "cancelled",
            [OrderStatus.CANCELLED]: "cancelled",
            [OrderStatus.REJECTED]: "cancelled",

            // Return states
            [OrderStatus.RETURNED]: "refunded",
            [OrderStatus.RETURN_PREPARING]: "refunded",
        };

        return map[internalStatus] || null;
    }



    public async updateOrderStatus(order: OrderEntity, store: StoreEntity, newStatusId: string) {

        if (!order.externalId)
            return;

        const status = await this.ordersService.findStatusById(newStatusId, order.adminId);
        if (!status) {
            throw new Error(`No status found for order (${order.id}) `)
        }

        const remoteStatus = this.mapInternalStatusToWoo(status.code as OrderStatus);

        if (!remoteStatus) {
            return;
        }


        const batchPayload = {
            update: [
                {
                    id: order.externalId,
                    status: remoteStatus
                }
            ]
        };

        return await this.sendRequest(store, {
            method: 'POST',
            url: `/orders/batch`,
            data: batchPayload
        });


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
            throw new Error("Store not found or inactive")
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


    public async syncProduct({ productId }: { productId: string }) {
        const product = await this.productsRepo.findOne({
            where: { id: productId },
            relations: ['category']
        });
        const activeStore = await this.getStoreForSync(product.adminId);
        if (!product) {
            throw new Error(`Product with ID ${productId} not found`);
        }

        // 2️⃣ جلب الـ Variants الخاصة بالمنتج
        const variants = await this.pvRepo.find({
            where: { productId: product.id }
        });

        const productSyncState = await this.productSyncStateRepo.findOne({
            where: {
                productId: productId,
                storeId: activeStore.id,
                adminId: product.adminId,
                externalStoreId: activeStore?.externalStoreId
            }
        });

        let externalId = productSyncState?.remoteProductId;
        const action = externalId ? ProductSyncAction.UPDATE : ProductSyncAction.CREATE;

        try {

            if (!activeStore) {
                throw new Error("store not found or inactive")
            }



            // 2️⃣ ⚡ RESOLVE CATEGORY FIRST ⚡
            let wooCategory = null;

            if (product.category) {

                wooCategory = await this.syncCategory({
                    category: product.category,
                    slug: product.category.slug,
                    relatedAdminId: product.adminId
                });
            }


            let result;
            if (externalId) {
                const remoteProduct = await this.getProduct(activeStore, externalId);
                if (remoteProduct) {
                    result = await this.updateProduct(
                        product,
                        variants,
                        activeStore,
                        remoteProduct.id,
                        wooCategory?.id
                    );
                } else {
                    result = await this.createProduct(
                        product,
                        variants,
                        activeStore,
                        wooCategory?.id
                    );
                }
            } else {
                result = await this.createProduct(
                    product,
                    variants,
                    activeStore,
                    wooCategory?.id
                );
            }
            externalId = result?.id;

            // SUCCESS STATE UPDATE
            await this.productSyncStateService.upsertSyncState(
                { adminId: activeStore.adminId, productId: product.id, storeId: activeStore.id, externalStoreId: activeStore.externalStoreId },
                {
                    remoteProductId: externalId,
                    status: ProductSyncStatus.SYNCED,
                    lastError: null,
                    lastSynced_at: new Date(),
                },
            );

            return result.response || result;

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

    public async syncBundle(bundle: BundleEntity) {
        this.logCtx(`[Sync] Starting bundle sync | Bundle: ${bundle.name} | SKU: ${bundle.sku}`, null, bundle.adminId);

        const activeStore = await this.getStoreForSync(bundle.adminId);
        if (!activeStore) {
            this.logCtxWarn(`[Sync] Skipping bundle sync: No active WooCommerce store enabled`, null, bundle.adminId);
            throw new Error("Store not found or inactive")
        }

        try {
            // 1. Ensure all items are synced first
            const bundledItemsData = [];
            const activeItems = bundle.items.filter(v => v.isActive);
            for (const item of activeItems) {
                const itemVariant = await this.pvRepo.findOne({
                    where: { id: item.variantId },
                    relations: ['product', 'product.store']
                });

                if (!itemVariant || !itemVariant.product) {
                    this.logCtxWarn(`[Sync] Skipping item variant ${item.variantId}: Not found or no product associated`, activeStore);
                    continue;
                }

                // Sync the item product first to ensure it exists on WooCommerce
                const remoteItemProduct = await this.syncProduct({
                    productId: itemVariant.productId
                });

                // Get remote details for this item

                const bundledItem: any = {
                    product_id: remoteItemProduct.id,
                    quantity_min: item.qty,
                    quantity_max: item.qty,
                    priced_individually: false,
                    shipped_individually: false,
                    optional: false
                };

                // If it's a variation, WooCommerce Product Bundles might need the variation_id
                // Note: remoteItemProduct.variations contains variation IDs
                if (remoteItemProduct.type === 'variable' || remoteItemProduct.variations?.length > 0) {
                    // Find the remote variation ID matching our local variant
                    const remoteVariation = remoteItemProduct.variations?.find(v => v.sku === itemVariant.sku);
                    if (remoteVariation) {
                        bundledItem.variation_id = remoteVariation.id;
                    } else {
                        // If not found in variations nodes, we might need to fetch them
                        // But syncProduct already sets externalId
                        if (itemVariant.externalId) {
                            bundledItem.variation_id = itemVariant.externalId;
                        }
                    }
                }

                bundledItemsData.push(bundledItem);
            }

            // 2. Resolve the main product variant
            const mainVariant = await this.pvRepo.findOne({
                where: { id: bundle.variantId },
                relations: ['product', 'product.store', 'product.category']
            });

            if (!mainVariant || !mainVariant.product) {
                throw new Error(`Bundle main variant ${bundle.variantId} or its product not found`);
            }

            // 3. Sync the main product as a bundle
            let wooCategory = null;
            if (mainVariant.product.category) {
                wooCategory = await this.syncCategory({
                    category: mainVariant.product.category,
                    slug: mainVariant.product.category.slug,
                    relatedAdminId: mainVariant.product.adminId
                });
            }

            // [2025-12-24] Ensure unique slug for bundles to avoid collision with individual products
            const bundleSlug = `${mainVariant.product.slug}-bundle`;

            const remoteProduct = await this.getProductBySlug(activeStore, bundleSlug);

            const attrMap = await this.ensureAttributesForVariants(activeStore, [mainVariant]);
            const payload = await this.mapWooProductPayload(
                { ...mainVariant.product, slug: bundleSlug } as ProductEntity,
                [mainVariant],
                wooCategory?.id,
                attrMap,
                activeStore,
                bundledItemsData
            );

            if (remoteProduct) {
                this.logCtx(`[Sync] Updating bundle product (ID: ${remoteProduct.id})`, activeStore);
                await this.sendRequest(activeStore, {
                    method: 'PUT',
                    url: `/products/${remoteProduct.id}`,
                    data: payload
                });
            } else {
                this.logCtx(`[Sync] Creating new bundle product`, activeStore);
                await this.sendRequest(activeStore, {
                    method: 'POST',
                    url: '/products',
                    data: payload
                });
            }

            this.logCtx(`[Sync] ✓ Bundle sync completed successfully`, activeStore);

        } catch (error) {
            const message = this.getErrorMessage(error);
            this.logCtxError(`[Sync] ✗ Bundle sync failed: ${message}`, activeStore, bundle.adminId);
            throw error;
        }
    }

    public async syncOrderStatus(order: OrderEntity, newStatusId: string) {

        const store = await this.getStoreForSync(order.adminId);
        if (!store) {
            throw new Error("Store not found or inactive")
        }

        await this.updateOrderStatus(order, store, newStatusId);
    }

    private async syncCategoriesCursor(store: StoreEntity): Promise<Map<string, string>> {

        const categoryMap = new Map<string, string>();
        let lastId = "";
        let hasMore = true;
        let stats = { processed: 0, created: 0, updated: 0 };

        while (hasMore) {
            // 1. Fetch local batch using cursor pagination
            const localBatch = await this.categoryRepo.find({
                where: { adminId: store.adminId, ...(lastId ? { id: MoreThan(lastId) } : {}) },
                order: { id: 'ASC' } as any,
                take: 30 // Smaller batch size recommended for individual API calls
            });

            if (localBatch.length === 0) {
                hasMore = false;
                break;
            }


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
                    const message = this.getErrorMessage(error);
                    this.logCtxError(`[Sync] Error processing category ${cat.name} (ID: ${cat.id}): ${message}`, store);
                }
                stats.processed++;
            }

            // Update the cursor for the next iteration
            lastId = localBatch[localBatch.length - 1].id;
        }

        this.logCtx(`[Sync] ✓ Category sync completed | Total: ${stats.processed} | Created: ${stats.created} | Updated: ${stats.updated}`, store);
        return categoryMap;
    }


    private async syncProductsCursor(store: StoreEntity, categoryMap: Map<string, string>) {
        this.logCtx(`[Sync] Starting product synchronization (Individual API calls)`, store);

        let lastId = "";
        let hasMore = true;
        let totalProcessed = 0;
        let totalCreated = 0;
        let totalUpdated = 0;
        let totalErrors = 0;

        while (hasMore) {
            // 1. Fetch local batch using cursor pagination
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
                .andWhere("product.isActive = :isActive", { isActive: true })
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

            for (const product of localBatch) {
                try {
                    // 2. Fetch variants for this specific product
                    const variants = await this.pvRepo.find({
                        where: { productId: product.id }
                    });
                    const remoteId = product?.syncState?.remoteProductId;
                    // 3. Check if product exists by slug using your helper
                    let remoteProduct = null;
                    if (remoteId)
                        remoteProduct = await this.getProduct(store, remoteId);

                    // 4. Resolve the external category ID from the map created in Phase 1
                    let extCatId = product.categoryId ? categoryMap.get(product.categoryId) : null;

                    if (!extCatId && product.category) {
                        const remoteCategory = await this.syncCategory({ relatedAdminId: product.adminId, category: product.category });
                        extCatId = remoteCategory?.id;
                    }
                    let syncedProduct;
                    // 5. Use individual methods for update or create
                    if (remoteProduct) {
                        {
                            syncedProduct = await this.updateProduct(
                                product,
                                variants,
                                store,
                                remoteProduct.id,
                                extCatId
                            );
                            totalUpdated++;
                        }
                    } else {
                        syncedProduct = await this.createProduct(
                            product,
                            variants,
                            store,
                            extCatId
                        );

                        totalCreated++;
                    }

                    await this.productSyncStateService.upsertSyncState(
                        { adminId: store.adminId, productId: product.id, storeId: store.id, externalStoreId: store.externalStoreId },
                        {
                            remoteProductId: syncedProduct?.externalId ?? remoteId ?? null,
                            status: ProductSyncStatus.SYNCED,
                            lastError: null,
                            lastSynced_at: new Date(),
                        },
                    );
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

            // Update the cursor to the last processed ID
            lastId = localBatch[localBatch.length - 1].id;
        }

        this.logCtx(`[Sync] ✓ Product sync completed | Total: ${totalProcessed} | Errors: ${totalErrors}`, store);
    }

    public async syncFullStore(store: StoreEntity) {
        if (!store || !store.isActive) {
            throw new Error("Store not found or inactive")
        }

        if (store.syncStatus === SyncStatus.SYNCING) {
            return;
        }

        try {
            const syncStartTime = Date.now();

            await this.storesRepo.update(store.id, {
                syncStatus: SyncStatus.SYNCING,
                lastSyncAttemptAt: new Date()
            });

            const categoryMap = await this.syncCategoriesCursor(store);

            await this.syncProductsCursor(store, categoryMap);

            const syncDuration = Date.now() - syncStartTime;
            await this.storesRepo.update(store.id, {
                syncStatus: SyncStatus.SYNCED,
            });


            if (store.adminId) {
                this.appGateway.emitStoreSyncStatus(String(store.adminId), {
                    storeId: store.id,
                    provider: store.provider,
                    status: SyncStatus.SYNCED,
                });
            }
        } catch (error) {
            const message = this.getErrorMessage(error);

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

    private mapExternalStatusToInternal(body, localStatus: OrderStatus) {
        const externalStatus = body.status
        if (localStatus) {
            const syncedRemoteStatus = this.mapInternalStatusToExternal(localStatus);
            if (syncedRemoteStatus === externalStatus) {
                return { orderStatus: null, paymentStatus: null };
            }
        }

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

        return {
            orderStatus: map[body.status] || OrderStatus.NEW,
            paymentStatus: body.set_paid ? PaymentStatus.PAID : PaymentStatus.PENDING
        }
    }

    public verifyWebhookAuth(headers: Record<string, any>, body: any, store: StoreEntity, req?: any, action?: "create" | "update"): boolean {
        const signature = headers['x-wc-webhook-signature'];
        const type = headers['x-wc-webhook-topic'];
        const savedSecret = type === 'order.update' ? store?.credentials?.webhookUpdateStatusSecret : type === 'order.created' ? store?.credentials?.webhookCreateOrderSecret : null;

        if (!savedSecret) {
            return true;
        }

        if (!signature) return false;

        // body must be the raw string for the HMAC to match
        const rawBody = req.rawBody;

        const expected = crypto
            .createHmac('sha256', savedSecret)
            .update(rawBody, 'utf8')
            .digest('base64');

        return expected === signature;
    }

    private mapInternalStatusToExternal(internalStatus: OrderStatus): string | null {
        const map: Record<OrderStatus, string> = {

            [OrderStatus.NEW]: "pending",
            [OrderStatus.UNDER_REVIEW]: "on-hold",
            [OrderStatus.POSTPONED]: "on-hold",
            [OrderStatus.NO_ANSWER]: "on-hold",

            [OrderStatus.CONFIRMED]: "on-hold",


            [OrderStatus.WRONG_NUMBER]: "cancelled",
            [OrderStatus.OUT_OF_DELIVERY_AREA]: "cancelled",
            [OrderStatus.DUPLICATE]: "cancelled",


            [OrderStatus.PREPARING]: "processing",
            [OrderStatus.PRINTED]: "processing",
            [OrderStatus.DISTRIBUTED]: "processing",
            [OrderStatus.READY]: "processing",
            [OrderStatus.PACKED]: "processing",
            [OrderStatus.SHIPPED]: "processing",


            [OrderStatus.DELIVERED]: "completed",


            [OrderStatus.FAILED_DELIVERY]: "failed",
            [OrderStatus.CANCELLED]: "cancelled",
            [OrderStatus.REJECTED]: "cancelled",


            [OrderStatus.RETURNED]: "refunded",
            [OrderStatus.RETURN_PREPARING]: "refunded",
        };

        return map[internalStatus] || null;
    }


    public mapWebhookUpdate(body: any, localOrderStatus: OrderStatus): WebhookOrderUpdatePayload {
        const externalStatus = body.status;

        const { orderStatus, paymentStatus } = this.mapExternalStatusToInternal(body, localOrderStatus);

        return {
            externalId: String(body.id),
            remoteStatus: externalStatus,
            mappedStatus: orderStatus,
            mappedPaymentStatus: paymentStatus
        };
    }
    public async mapWebhookCreate(body: any, store: StoreEntity): Promise<WebhookOrderPayload> {
        const paymentMethod = body.paymentMethod ? this.mapPaymentMethod(body.payment_method) : PaymentMethod.CASH_ON_DELIVERY;
        const lineItems = body.line_items || [];
        const uniqueIds = [...new Set(lineItems.map((item: any) => String(item.product_id)))];

        const remoteProducts = await this.fetchRemoteProducts(store, uniqueIds as string[]);
        const { orderStatus, paymentStatus } = this.mapExternalStatusToInternal(body, null);

        const idToSlugMap = new Map<string, string>();
        remoteProducts.forEach(p => idToSlugMap.set(p.id?.toString(), p.slug));////

        return {
            externalOrderId: String(body.id),
            fullName: `${body.billing?.first_name} ${body.billing?.last_name}`.trim(),
            phone: body.billing?.phone || "",
            address: `${body.billing?.address_1} ${body.billing?.address_2}`.trim(),
            government: body.billing?.city || "Unknown",
            paymentMethod: paymentMethod,
            paymentStatus: paymentStatus,
            status: orderStatus,
            shippingCost: Number(body.shipping_total || 0),

            cartItems: await Promise.all(
                lineItems.map(async (item: any) => {
                    const productId = String(item.product_id);
                    const productSlug = idToSlugMap.get(productId) || productId;

                    let variationProps: { name: string; value: string }[] = [];
                    let key: string | undefined;

                    if (item.variation_id) {
                        // ✅ Fetch real variation from WooCommerce
                        const variation = await this.sendRequest(store, {
                            method: "GET",
                            url: `/products/${productId}/variations/${item.variation_id}`,
                        });

                        const v = variation?.data ?? variation;

                        // ✅ Extract attributes properly
                        variationProps = (v.attributes || []).map((attr: any) => ({
                            name: attr.name,
                            value: String(attr.option).trim(),
                        }));

                        const attrs = variationProps.reduce(
                            (acc: Record<string, string>, prop) => {
                                const k = this.productsService.slugifyKey(prop.name);
                                const v = this.productsService.slugifyKey(prop.value);
                                acc[k] = v;
                                return acc;
                            },
                            {}
                        );

                        key = this.productsService.canonicalKey(attrs);
                    }

                    return {
                        name: String(item.name),
                        productSlug,
                        quantity: Number(item.quantity),

                        // ✅ IMPORTANT: use total / quantity fallback
                        price:
                            Number(item.total) && Number(item.quantity)
                                ? Number(item.total) / Number(item.quantity)
                                : Number(item.price) || 0,

                        remoteProductId: productId,

                        variant: item.variation_id
                            ? {
                                key: key || "default",
                                variation_props: variationProps,
                            }
                            : undefined,
                    };
                })
            )
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
        } catch (error: any) {
            const status = error.response?.status;

            if (status === 401) {
                this.logger.warn(`[WooCommerce] 401 Unauthorized: Invalid Key or Secret for ${storeUrl}`);
            } else if (status === 404) {
                this.logger.warn(`[WooCommerce] 404 Not Found: Check if WooCommerce is installed at ${storeUrl}`);
            } else {
                const message = this.getErrorMessage(error);
                this.logger.error(`[WooCommerce] Connection error: ${message}`);
            }

            return false;
        }
    }
}
