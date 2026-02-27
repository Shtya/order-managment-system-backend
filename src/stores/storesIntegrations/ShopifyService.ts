/**
 * Fetch a Shopify product by slug (handle) with all details needed for local sync
 */

import { forwardRef, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
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
import * as crypto from 'crypto';
import { ApolloClient, InMemoryCache, HttpLink, gql, ObservableQuery } from '@apollo/client/core';
import fetch from 'cross-fetch';
import axios from "axios";
import { AppGateway } from "common/app.gateway";

@Injectable()
export class ShopifyService extends BaseStoreProvider {

    code: StoreProvider = StoreProvider.SHOPIFY;
    displayName: string = "Shopify";
    baseUrl: string = process.env.SHOPIFY_BASE_URL || "https://api.easy-orders.net/api/v1";

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
        super(storesRepo, categoryRepo, encryptionService, mainStoresService, 400, StoreProvider.SHOPIFY)

    }

    private async getStoreBydomain(storeURL: string): Promise<StoreEntity | null> {

        if (!storeURL) return null;

        const store = await this.storesRepo.findOne({
            where: {
                storeUrl: storeURL,
                provider: StoreProvider.SHOPIFY,
            },
        });

        if (!store) {
            this.logger.debug(`Shopify store ${storeURL} not found.`);
            return null;
        }

        return store;
    }

    private async getStoreForSync(adminId: string): Promise<StoreEntity | null> {
        const cleanAdminId = adminId?.trim();
        if (!cleanAdminId) return null;

        const store = await this.storesRepo.findOne({
            where: {
                adminId: cleanAdminId,
                provider: StoreProvider.SHOPIFY,
                isActive: true
            },
        });
        if (!store) {
            this.logger.debug(`Skipping sync for admin ${cleanAdminId}: No active Shopify store enabled.`);
            return null;
        }

        return store;

    }

    public async Init(query: Record<string, any>) {
        // 1. Extract hmac from the query
        const { hmac, ...params } = query;
        const shop = query.shop as string | undefined;
        const frontendBaseUrl = process.env.FRONTEND_URL?.trim();

        if (!shop || !hmac) {
            return { url: `${frontendBaseUrl}/store-integration?error=shopify_invalid_session` };
        }

        const store = await this.getStoreBydomain(shop);
        if (!store) {
            return {
                url: `${frontendBaseUrl}/store-integration?error=shopify_store_not_found&shop=${encodeURIComponent(shop)}`
            };
        }
        const keys = store?.credentials;

        const message = Object.keys(params)
            .sort()
            .map((key) => `${key}=${params[key]}`)
            .join('&');

        // 3. Compute HMAC using your client secret and SHA256
        const generatedHmac = crypto
            .createHmac('sha256', keys.clientSecret)
            .update(message)
            .digest('hex');

        const isValid = hmac === generatedHmac


        if (!isValid) {
            return { url: `${frontendBaseUrl}/login?error=shopify_security_verification_failed` };
        }

        const redirectUrl = `${frontendBaseUrl}/store-integration`;

        return { url: redirectUrl };
    }

    private async getAccessToken(store: StoreEntity): Promise<string> {
        const cacheKey = `store_token:${store.id}`;
        let accessToken = await this.redisService.get(cacheKey);
        if (accessToken) return accessToken;

        if (!accessToken) {
            this.logCtx(`[Shopify] No access token found for ${store.id}. Generating new one...`, store);
        }
        const keys = store?.credentials;
        // Note: Using storeUrl as the base for the token request
        const tokenUrl = `https://${store.storeUrl}/admin/oauth/access_token`;


        const body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: keys.apiKey, // client_id
            client_secret: keys.clientSecret // client_secret
        }).toString();

        try {
            // Using super.sendRequest directly to bypass standard Shopify headers (which require a token we don't have yet)
            const response = await super.sendRequest(store, {
                method: 'POST',
                url: tokenUrl,
                data: body,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            if (!response.access_token) {
                throw new Error('Access token missing in Shopify response');
            }
            await this.redisService.set(cacheKey, response.access_token, 82800);
            this.logCtx(`[Shopify] Access token saved successfully for ${store.id}.`, store);

            return response.access_token;
        } catch (error) {
            this.logCtxError(`[Shopify] Token Generation Failed: ${error.message}`, store);
            throw new UnauthorizedException('Failed to authenticate with Shopify');
        }
    }
    /**
     * Run a Shopify GraphQL query using the official client and centralized limiter.
     */
    protected getShopifyGraphQLEndpoint(storeUrl: string): string {
        const shopHost = storeUrl
            .trim()
            .replace(/^https?:\/\//, '') // Remove http:// or https://
            .replace(/\/$/, '');         // Remove trailing slash /

        return `https://${shopHost}/admin/api/2026-01/graphql.json`;
    }

    protected async runGraphQL(store: StoreEntity, isMutation = false, query: string, variables?: Record<string, any>, attempt = 0): Promise<any> {
        if (!store) throw new Error('Store is required for runGraphQL');

        const accessToken = await this.getAccessToken(store);
        const url = this.getShopifyGraphQLEndpoint(store.storeUrl);

        // 1. Configure the Apollo Client for this specific store
        const client = new ApolloClient({
            link: new HttpLink({
                uri: url,
                headers: {
                    'X-Shopify-Access-Token': accessToken,
                    'Content-Type': 'application/json',
                },
                fetch, // Required for Node.js environments
            }),
            cache: new InMemoryCache(),
            defaultOptions: {
                watchQuery: { fetchPolicy: 'no-cache', errorPolicy: 'all' },
                query: { fetchPolicy: 'no-cache', errorPolicy: 'all' },
                mutate: { errorPolicy: 'all' },
            },
        });

        // 2. Execute with your BaseStoreProvider Limiter
        return this.executeWithLimiter(String(store.adminId), async () => {
            try {
                // Detect if this is a mutation or query

                const result = isMutation
                    ? await client.mutate({
                        mutation: gql`${query}`,
                        variables: variables || {},
                    })
                    : await client.query({
                        query: gql`${query}`,
                        variables: variables || {},
                    });

                const { data, error } = result;

                // 3. Handle GraphQL Errors (Specifically Throttling)
                if (error) {
                    const systemCode = (error as any).code || (error as any).networkError?.code;
                    const isNetworkError = ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN'].includes(systemCode);

                    if (isNetworkError) {
                        this.logCtxWarn(`[Shopify] Network Error (${systemCode}) for store: ${store.storeUrl}. Triggering retry...`, store);

                        // Throw the error with the code intact so executeWithLimiter recognizes it
                        const networkErr: any = new Error(`Network ${systemCode}: ${error.message}`);
                        networkErr.code = systemCode;
                        throw networkErr;
                    }

                    // 2. Handle GraphQL-Specific Errors (Inside the successful response but with errors array)
                    const gqlErrors = (error as any)?.graphQLErrors || (error as any)?.errors || [];

                    if (gqlErrors.length > 0) {
                        // Comprehensive check for throttling
                        const isThrottled = gqlErrors.some(e => {
                            const message = e.message?.toUpperCase() || '';
                            const code = e.extensions?.code;
                            return (
                                code === 'TOO_MANY_REQUESTS' ||
                                code === 'THROTTLED' ||
                                message.includes('THROTTLED')
                            );
                        });

                        if (isThrottled) {
                            this.logCtxWarn(`[Shopify] GraphQL Rate limit hit for store: ${store.storeUrl}`, store);
                            const throttleErr: any = new Error('GraphQL Throttled');
                            // Attach 429 status so executeWithLimiter knows to back off
                            throttleErr.response = { status: 429 };
                            throw throttleErr;
                        }

                        // Log other GraphQL errors (Syntax, missing fields, etc.) before throwing
                        this.logCtxError(`GraphQL Errors: ${JSON.stringify(gqlErrors)}`, store);
                        throw new Error(`GraphQL Error: ${gqlErrors[0].message}`);
                    }
                }
                // [2025-12-24] Remember to trim any string data returned here before further processing
                return data;

            } catch (error) {
                // Handle network or Apollo-specific errors
                this.logCtxError(`Apollo Request Failed: ${error.message}`, store);
                throw error;
            }
        }, attempt, 2000, 'Shopify GraphQL (Apollo)');
    }

    // ===========================================================================
    // SYNC CATEGORY METHODS
    // ===========================================================================
    /**
     * Finds a collection by its handle (slug)
     */
    private async getCollectionByHandle(store: StoreEntity, handle: string) {
        const cleanHandle = handle?.trim();
        this.logCtxDebug(`[Category] Fetching collection with slug: ${cleanHandle}`, store);
        const query = `
        query getCollection($handle: String!) {
            collections(first: 1, query: $handle) {
                nodes {
                    id
                    handle
                    title
                }
            }
        }
    `;

        try {
            const response = await this.runGraphQL(
                store,
                false, // Use false here because this is a Query, not a Mutation
                query,
                { handle: `handle:${cleanHandle}` }
            );

            const collection = response?.collections?.nodes?.[0] || null;

            if (collection) {
                this.logCtxDebug(`[Category] ✓ Successfully found collection: ${collection.title} (${collection.id})`, store);
            } else {
                this.logCtxDebug(`[Category] ℹ No collection found with slug: ${cleanHandle}`, store);
            }

            return collection;
        } catch (error) {
            this.logCtxError(`[Category] ✗ Failed to fetch collection by handle ${cleanHandle}: ${error.message}`, store);
            throw error;
        }
    }

    /**
     * Creates a new Custom Collection
     */
    private async createCollection(store: StoreEntity, category: CategoryEntity) {
        this.logCtx(`[Category] Creating collection: ${category.name}`, store);
        // 1. Write the query as a PLAIN STRING (no gql prefix here)
        const query = `
        mutation CollectionCreate($input: CollectionInput!) {
            collectionCreate(input: $input) {
                userErrors {
                    field
                    message
                }
                collection {
                    id
                    title
                    handle
                    image {
                        url
                        altText
                    }
                }
            }
        }
    `;

        // 2. Ensure variables exactly match the $input: CollectionInput! type
        const variables = {
            input: {
                title: category.name.trim(), // [2025-12-24] Trim
                handle: category.slug.trim(), // [2025-12-24] Trim
                image: category.image ? {
                    src: this.getImageUrl(category.image.trim()),
                    altText: category.name.trim()
                } : null
            }
        };

        try {
            const response = await this.runGraphQL(store, true, query, variables);

            // Handle Shopify-specific UserErrors
            const userErrors = response?.collectionCreate?.userErrors;
            if (userErrors && userErrors.length > 0) {
                this.logger.error(`Shopify UserErrors: ${JSON.stringify(userErrors)}`);
                throw new Error(`Shopify Error: ${userErrors[0].message}`);
            }
            const newCollection = response?.collectionCreate?.collection;

            this.logCtx(`[Category] ✓ Successfully created Shopify collection: ${newCollection?.title} (ID: ${newCollection?.id})`, store);
            return newCollection;
        } catch (err) {
            this.logCtxError(`[Category] ✗ Failed to create collection ${category.name}: ${err.message}`, store);
            throw err;
        }
    }

    /**
     * Updates an existing Collection
     */
    private async updateCollection(store: StoreEntity, shopifyId: string, category: CategoryEntity) {
        if (!shopifyId) {
            this.logCtxWarn(`[Category] Skipping update: No Shopify ID (GID) provided for category ${category.name}`, store);
            return;
        }

        this.logCtx(`[Category] Updating collection: ${category.name} (Shopify ID: ${shopifyId})`, store);
        const mutation = `
        mutation collectionUpdate($input: CollectionInput!) {
            collectionUpdate(input: $input) {
                userErrors { field message }
                collection { 
                id
                title 
                handle 
                image {
                    url
                    altText
                    }
                }
            }
        }
    `;

        const variables = {
            input: {
                id: shopifyId,
                title: category.name.trim(),
                handle: category.slug.trim(),
                image: category.image ? {
                    src: this.getImageUrl(category.image.trim()),
                    altText: category.name.trim()
                } : null
            }
        };

        try {
            const response = await this.runGraphQL(store, true, mutation, variables);
            const errors = response?.collectionUpdate?.userErrors;

            if (errors?.length > 0) {
                throw new Error(`Shopify Update Error: ${errors[0].message}`);
            }
            this.logCtx(`[Category] ✓ Successfully updated Shopify collection ${shopifyId}`, store);
            return response.collectionUpdate.collection;
        }
        catch (error) {
            this.logCtxError(`[Category] ✗ Failed to update Shopify collection ${shopifyId}: ${error.message}`, store);
            throw error;
        }
    }

    // ===========================================================================
    // SYNC PRODUCT METHODS
    // ===========================================================================
    private async getProductBySlug(store: StoreEntity, slug: string) {
        const cleanSlug = slug?.trim();
        this.logCtxDebug(`[Product] Fetching product with slug: ${cleanSlug}`, store);

        const query = `
        query getProductByHandle($handle: String!) {
            productByHandle(handle: $handle) {
                id
                handle
                title
                variants(first: 250) {
                    nodes {
                        id
                        sku
                        title
                        price
                        inventoryQuantity
                    }
                }
            }
        }
        `;

        try {
            const response = await this.runGraphQL(store, false, query, { handle: cleanSlug });
            const product = response?.productByHandle || null;

            if (product) {
                this.logCtxDebug(`[Product] ✓ Found product: ${product.title} (${product.id})`, store);
            } else {
                this.logCtxDebug(`[Product] ℹ No product found with slug: ${cleanSlug}`, store);
            }

            return product;
        } catch (error) {
            this.logCtxError(`[Product] ✗ Failed to fetch product by handle ${cleanSlug}: ${error.message}`, store);
            throw error;
        }
    }

    private buildProductSetInput(
        product: ProductEntity,
        variants: ProductVariantEntity[],
        locationId: string,
        store: StoreEntity,
    ) {
        const optionsMap = new Map<string, Set<string>>();

        // Map variant attributes to options
        variants.forEach((v) => {
            let attrs = {};
            try {
                attrs = typeof v.attributes === "string" ? JSON.parse(v.attributes) : v.attributes || {};
            } catch (e) {
                this.logCtxError(`[Product] Attributes parse error for ${v.sku}: ${e.message}`);
            }

            Object.entries(attrs).forEach(([key, val]) => {
                const optName = key.trim();
                const optVal = String(val).trim();
                if (!optionsMap.has(optName)) {
                    optionsMap.set(optName, new Set());
                }
                optionsMap.get(optName).add(optVal);
            });
        });

        const productOptions = Array.from(optionsMap.entries()).map(([name, values]) => ({
            name,
            values: Array.from(values).map((v) => ({ name: v })),
        }));

        // Build media array from product images
        const media: any[] = [];
        if (product.mainImage) {
            const src = this.getImageUrl(product.mainImage.trim());
            if (src) {
                media.push({
                    originalSource: src,
                    alt: product.name.trim(),
                    contentType: "IMAGE",
                });
            }
        }

        if (product.images?.length) {
            for (const img of product.images) {
                const src = this.getImageUrl(img.url?.trim() || "");
                if (!src) continue;

                media.push({
                    originalSource: src,
                    alt: product.name.trim(),
                    contentType: "IMAGE",
                });
            }
        }

        const variantsInput = variants.map((v) => {
            let attributesObj: Record<string, any> = {};
            try {
                attributesObj =
                    typeof v.attributes === "string"
                        ? JSON.parse(v.attributes)
                        : (v.attributes || {});
            } catch (e: any) {
                this.logCtxError(
                    `[Product] Failed to parse attributes for variant ${v.sku}: ${e.message}`,
                    store,
                );
                return null;
            }

            const optionValues = Object.entries(attributesObj).map(
                ([key, value]) => ({
                    optionName: key.trim(),
                    name: String(value).trim(),
                }),
            );
            if (optionValues.length === 0) {
                return null;
            }
            return {
                price: (v.price || product.wholesalePrice || 0).toString(),
                optionValues,
                inventoryItem: {
                    tracked: true,
                    sku: v.sku
                },
                inventoryQuantities: v.stockOnHand
                    ? [
                        v.stockOnHand && {
                            quantity: v.stockOnHand,
                            locationId,
                            name: "available",
                        },
                    ].filter(Boolean)
                    : undefined,

            };
        });

        const input: any = {
            title: product.name.trim(),
            handle: product.slug.trim(),
            descriptionHtml: (product.description || "").trim(),
            vendor: "Generic",
            productType: product.category?.name || "General",
            status: "ACTIVE",
            productOptions,
            files: media,
            variants: variantsInput,
            // You can also include tags, collectionsToJoin, metafields, etc. here if needed.
        };

        return input;
    }

    private async removeProductFromCategoryCollection(store: StoreEntity, previousCollectionId: string, productId: string) {
        const oldCid = previousCollectionId.trim();
        this.logCtxDebug(
            `[Product] Removing product ${productId} from previous category collection ${oldCid}`,
            store,
        );

        const removeMutation = `
                  mutation RemoveFromCollection($id: ID!, $productIds: [ID!]!) {
                    collectionRemoveProducts(id: $id, productIds: $productIds) {
                      userErrors {
                        field
                        message
                      }
                    }
                  }
                `;

        const removeVariables = {
            id: oldCid,
            productIds: [productId],
        };

        try {
            const removeResponse = await this.runGraphQL(
                store,
                true,
                removeMutation,
                removeVariables,
            );

            const removeErrors =
                removeResponse?.collectionRemoveProducts?.userErrors;
            if (removeErrors && removeErrors.length > 0) {
                this.logCtxError(
                    `[Product] ✗ collectionRemoveProducts userErrors: ${JSON.stringify(
                        removeErrors,
                    )}`,
                    store,
                );
                // Depending on your needs, you might throw here or just log a warning and continue
                // throw new Error(`Shopify Error: ${removeErrors[0].message}`);
            } else {
                this.logCtx(
                    `[Product] ✓ Removed product ${productId} from previous category collection ${oldCid}`,
                    store,
                );
            }
        } catch (error: any) {
            this.logCtxError(
                `[Product] ✗ Failed to remove product ${productId} from previous category collection ${oldCid}: ${error.message}`,
                store,
            );
            // Decide whether to rethrow or continue; here we continue and still add to new collection
        }
    }

    private async setProductCategoryCollection(
        store: StoreEntity,
        newCollectionId: string,
        productId: string,
    ) {
        const cid = newCollectionId?.trim();
        const pid = productId?.trim();

        if (!cid || !pid) {
            this.logCtxWarn(
                `[Product] Skipping category collection assignment: Missing collectionId or productId`,
                store,
            );
            return;
        }

        // 2. Add product to the new category collection
        this.logCtxDebug(
            `[Product] Assigning product ${pid} to new category collection ${cid}`,
            store,
        );

        const addMutation = `
    mutation AddToCollection($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) {
        collection {
          id
          title
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

        const addVariables = {
            id: cid,
            productIds: [pid],
        };

        try {
            const addResponse = await this.runGraphQL(
                store,
                true,
                addMutation,
                addVariables,
            );

            const userErrors = addResponse?.collectionAddProducts?.userErrors;
            if (userErrors && userErrors.length > 0) {
                this.logCtxError(
                    `[Product] ✗ collectionAddProducts userErrors: ${JSON.stringify(
                        userErrors,
                    )}`,
                    store,
                );
                throw new Error(`Shopify Error: ${userErrors[0].message}`);
            }

            const collection = addResponse?.collectionAddProducts?.collection;
            this.logCtx(
                `[Product] ✓ Successfully added product to category collection: ${collection?.title} (${cid})`,
                store,
            );

            return collection;
        } catch (error: any) {
            this.logCtxError(
                `[Product] ✗ Failed to add product ${pid} to category collection ${cid}: ${error.message}`,
                store,
            );
            throw error;
        }
    }

    private async getFirstLocationId(store: StoreEntity): Promise<string> {
        const query = `
    {
      locations(first: 1) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  `;

        const resp = await this.runGraphQL(store, false, query, {});
        const id = resp?.locations?.edges?.[0]?.node?.id;
        const name = resp?.locations?.edges?.[0]?.node?.name;

        if (!id) {
            this.logCtxError(`[Locations] No locations found for store — cannot set inventory quantities`, store);
            throw new Error('ShopifyError: no locations found for store');
        }

        this.logCtx(`[Locations] Using location ${name} (${id}) for inventory`, store);
        return id;
    }

    private buildAttributesFromSelectedOptions(selectedOptions: any[]) {
        const obj: Record<string, string> = {};

        for (const opt of selectedOptions) {
            obj[opt.name.trim()] = opt.value.trim();
        }

        return obj;
    }

    private async syncLocalVariantIdsFromProductSet(
        store: StoreEntity,
        product: ProductEntity,
        localVariants: ProductVariantEntity[],
        shopifyVariants: any[],
    ) {
        const localVariantsMap = new Map<string, ProductVariantEntity>();

        for (const v of localVariants) {
            // Assume you have a function that turns v.attributes into a canonical key
            const key = this.productsService.canonicalKey(v.attributes);
            localVariantsMap.set(key, v);
        }

        for (const shopifyVariant of shopifyVariants) {
            const attributesObj = this.buildAttributesFromSelectedOptions(
                shopifyVariant.selectedOptions,
            );
            const key = this.productsService.canonicalKey(attributesObj);
            const localVariant = localVariantsMap.get(key);

            if (!localVariant) {
                this.logCtxError(
                    `[ProductSet] Could not match Shopify variant with key ${key}`,
                    store,
                );
                continue;
            }

            localVariant.externalId = shopifyVariant.id;
        }

        await this.pvRepo.save(localVariants);

        this.logCtx(
            `[ProductSet] ✓ Synced ${shopifyVariants.length} variant IDs back to local DB for product ${product.name}`,
            store,
        );
    }

    private async updateProductWithProductSet(
        store: StoreEntity,
        product: ProductEntity,
        variants: ProductVariantEntity[],
        shopifyId?: string,
    ): Promise<any> {
        const mode = shopifyId ? "update" : "create";

        this.logCtx(
            `[ProductSet] ${mode === "update" ? "Updating" : "Creating"} product via productSet: ${product.name} ` +
            `${shopifyId ? `(Shopify ID: ${shopifyId}) ` : ""}with ${variants.length} variant(s)`,
            store,
        );

        this.logCtx(
            `[Product] Syncing product via productSet: ${product.name} (Shopify ID: ${shopifyId}) with ${variants.length} variant(s)`,
            store,
        );

        const mutation = `
    mutation SetProduct(
      $identifier: ProductSetIdentifiers!,
      $input: ProductSetInput!,
      $synchronous: Boolean!
    ) {
      productSet(identifier: $identifier, input: $input, synchronous: $synchronous) {
        product {
          id
          handle
          title
          options {
            name
            values
          }
          variants(first: 50) {
            nodes {
              id
              title
              price
              selectedOptions {
                name
                value
              }
            }
          }
             collections(first: 50) {
                nodes {
                id
                title
                }
            }
        }
        productSetOperation {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

        const locationId = await this.getFirstLocationId(store);

        const input = this.buildProductSetInput(
            product,
            variants,
            locationId,
            store,
        );
        const variables = {
            identifier: { handle: product.slug.trim() },
            input,
            synchronous: true,
        };

        try {
            const response = await this.runGraphQL(store, true, mutation, variables);
            const payload = response?.productSet;

            const userErrors = payload?.userErrors;
            if (userErrors && userErrors.length > 0) {
                this.logCtxError(
                    `[ProductSet] Shopify productSet userErrors: ${JSON.stringify(userErrors)}`,
                    store,
                );
                throw new Error(`Shopify productSet Error: ${userErrors[0].message}`);
            }

            const updatedProduct = payload?.product;
            this.logCtx(
                `[ProductSet] ✓ Successfully synced product via productSet: ${updatedProduct?.title} (ID: ${updatedProduct?.id})`,
                store,
            );
            const shopifyVariants = updatedProduct?.variants?.nodes || [];
            await this.syncLocalVariantIdsFromProductSet(
                store,
                product,
                variants,
                shopifyVariants,
            );

            return updatedProduct;
        } catch (error: any) {
            this.logCtxError(
                `[ProductSet] ✗ Failed to sync product via productSet ${shopifyId}: ${error.message}`,
                store,
            );
            throw error;
        }
    }

    private async getOnlineStorePublicationId(store: StoreEntity): Promise<string> {
        // If you already cached it for this store, return cached value
        if (store.onlineStorePublicationId) {
            return store.onlineStorePublicationId;
        }

        const query = `
          query OnlineStorePublication {
            publications(first: 20) {
              nodes {
                id
                name
              }
            }
          }
        `;

        const response = await this.runGraphQL(store, false, query, {});
        const publications = response?.publications?.nodes ?? [];

        const onlineStorePublication = publications.find(
            (p: any) => p.name === "Online Store",
        );

        if (!onlineStorePublication) {
            throw new Error(
                "Could not find Online Store publication. Ensure Online Store is installed and active.",
            );
        }

        const publicationId = onlineStorePublication.id;

        // Persist it in your DB for next time
        store.onlineStorePublicationId = publicationId;
        await this.storesRepo.save(store);

        return publicationId;
    }
    private async publishProductToOnlineStore(
        store: StoreEntity,
        productGid: string,

    ): Promise<any> {
        const publicationId = await this.getOnlineStorePublicationId(store);

        const mutation = `
    mutation PublishProductToOnlineStore($productId: ID!, $publicationId: ID!) {
      publishablePublish(id: $productId, input: [{ publicationId: $publicationId }]) {
        publishable {
          ... on Product {
            id
            title
            status
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

        const variables = {
            productId: productGid,
            publicationId,
        };

        const response = await this.runGraphQL(store, true, mutation, variables);
        const payload = response?.publishablePublish;

        const userErrors = payload?.userErrors;
        if (userErrors && userErrors.length > 0) {
            this.logCtxError(
                `[Publish] Shopify publishablePublish userErrors: ${JSON.stringify(
                    userErrors,
                )}`,
                store,
            );
            throw new Error(`Shopify publish Error: ${userErrors[0].message}`);
        }

        const publishedProduct = payload?.publishable;
        this.logCtx(
            `[Publish] ✓ Successfully published product: ${publishedProduct?.title} (ID: ${publishedProduct?.id})`,
            store,
        );

        return publishedProduct;
    }
    private async syncCategoriesCursor(store: StoreEntity): Promise<Map<number, string>> {
        this.logCtx(`[Sync] Starting category synchronization (batch size: 30)`, store);

        const categoryMap = new Map<number, string>();
        let lastId = 0;
        let hasMore = true;
        let totalProcessed = 0;

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

            const remoteMap = new Map();

            for (const cat of localBatch) {

                try {
                    await this.syncCategory({ category: cat, relatedAdminId: store.adminId, slug: cat.slug })

                } catch (error) {
                    this.logCtxError(`[Sync] Error processing category ${cat.name} (ID: ${cat.id}): ${error.message}`, store);
                }

                totalProcessed++;
            }

            lastId = localBatch[localBatch.length - 1].id;
        }

        this.logCtx(`[Sync] ✓ Category sync completed | Total: ${totalProcessed}`, store);
        return categoryMap;
    }


    private async syncProductsCursor(store: StoreEntity) {
        this.logCtx(`[Sync] Starting product synchronization (batch size: 20)`, store);

        let lastId = 0;
        let hasMore = true;
        let totalProcessed = 0;
        let totalErrors = 0;

        while (hasMore) {
            const localBatch = await this.storesRepo.manager.find(ProductEntity, {
                where: { storeId: store.id, adminId: store.adminId, id: MoreThan(lastId) },
                relations: ['variants', 'category', 'store'],
                order: { id: 'ASC' } as any,
                take: 20
            });

            if (localBatch.length === 0) {
                hasMore = false;
                this.logCtx(`[Sync] No more products to process`, store);
                break;
            }

            this.logCtx(`[Sync] Processing batch of ${localBatch.length} products (IDs: ${localBatch[0].id}-${localBatch[localBatch.length - 1].id})`, store);


            for (const product of localBatch) {
                try {

                    await this.syncProduct({ product, variants: product.variants, slug: product.slug })
                    totalProcessed++;
                } catch (error) {
                    this.logCtxError(`[Sync] Error processing product ${product.name} (ID: ${product.id}): ${error.message}`, store);
                    totalErrors++;
                }

            }

            lastId = localBatch[localBatch.length - 1].id;
        }

        this.logCtx(`[Sync] ✓ Product sync completed | Total: ${totalProcessed} | Errors: ${totalErrors}`, store);
    }
    // ===========================================================================
    // MAIN ENTRY POINTS FOR SYNC
    // ===========================================================================

    public async syncCategory({ category, relatedAdminId, slug }: { category: CategoryEntity, relatedAdminId?: string, slug?: string }) {
        const adminId = relatedAdminId || category.adminId;
        const store = await this.getStoreForSync(adminId);

        if (!store) {
            this.logger.debug(`[Shopify Sync] Skipping: No active Shopify store for admin ${adminId}`);
            return;
        }

        const checkHandle = (slug || category.slug || "").trim();

        // 1. Check if collection exists by handle
        const existingCollection = await this.getCollectionByHandle(store, checkHandle);

        if (existingCollection) {
            return await this.updateCollection(store, existingCollection.id, category);
        } else {
            return await this.createCollection(store, category);
        }
    }
    /**
     * Main entry point: Sync a single product to Shopify
     */
    public async syncProduct({ product, variants, slug }: { product: ProductEntity; variants: ProductVariantEntity[]; slug?: string; }) {
        this.logCtx(`[Sync] Starting single product sync | Product: ${product.name} | SKU Count: ${variants.length}`, null, product.adminId);

        // 1. Validate Store
        if (!product.store || product.store.provider !== StoreProvider.SHOPIFY) {
            this.logCtxWarn(`[Sync] Skipping sync: Store not found or provider is not SHOPIFY`, null, product.adminId);
            return;
        }

        const activeStore = await this.getStoreForSync(product.adminId);

        if (!activeStore) {
            this.logCtxWarn(`[Sync] Skipping sync: No active store enabled`, activeStore, product.adminId);
            return;
        }

        try {
            // 2. ⚡ RESOLVE COLLECTION ID (Category) ⚡
            let externalCategory = null;
            if (product.category) {
                this.logCtx(`[Sync] Syncing category: ${product.category.name}`, activeStore);
                externalCategory = await this.syncCategory({ category: product.category, slug: product.category.slug, relatedAdminId: product.adminId });
            }

            // 3. ⚡ Check existence by Slug (Handle in Shopify) ⚡
            const checkSlug = slug ? slug : product.slug;
            const existingProduct = await this.getProductBySlug(activeStore, checkSlug);
            let syncedProduct;
            if (existingProduct) {
                this.logCtx(
                    `[Sync] Product already exists on Shopify (ID: ${existingProduct.id}), updating...`,
                    activeStore,
                );
                syncedProduct = await this.updateProductWithProductSet(activeStore, product, variants, existingProduct.id)
            } else {
                this.logCtx(`[Sync] Product does not exist on Shopify, creating...`, activeStore);
                syncedProduct = await this.updateProductWithProductSet(activeStore, product, variants)
            }

            if (syncedProduct?.id) {

                await this.publishProductToOnlineStore(activeStore, syncedProduct.id);


                const collections = syncedProduct.collections;
                const collectionNodes = collections?.nodes || [];

                const previousCategoryCollection = collectionNodes.find(
                    (c) => c.id !== externalCategory?.id,
                );
                const previousCategoryCollectionId = previousCategoryCollection?.id ?? null;
                if (previousCategoryCollectionId && previousCategoryCollectionId != externalCategory?.id)
                    await this.removeProductFromCategoryCollection(activeStore, previousCategoryCollectionId, syncedProduct.id)


                const alreadyAdded = collectionNodes.find(
                    (c) => c.id === externalCategory?.id,
                );
                if (!alreadyAdded)
                    await this.setProductCategoryCollection(
                        activeStore,
                        externalCategory?.id,
                        syncedProduct.id,

                    );
            }


        } catch (error) {
            this.logCtxError(`[Sync] ✗ Failed to sync product ${product.name}: ${error.message}`, activeStore, product.adminId);
            throw error;
        }
    }

    public syncOrderStatus(order: OrderEntity) {
        throw new Error("Method not implemented.");
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
            await this.syncProductsCursor(store);
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

    // ===========================================================================
    // WEBHOOK
    // ===========================================================================

    private mapExternalStatusToInternal(financial: string, fulfillment: string | null, confirmed: boolean): OrderStatus | null {
        // Normalize null fulfillment to 'unfulfilled'
        const fulfillStatus = fulfillment || 'unfulfilled';

        // 1. Terminal / Cancellation States
        if (fulfillStatus === 'request_declined') {
            return OrderStatus.CANCELLED;
        }
        if (['refunded', 'partially_refunded'].includes(financial)) {
            return OrderStatus.RETURNED;
        }

        // 2. Fulfillment Progression (Overrides financial status)
        if (fulfillStatus === 'fulfilled') return OrderStatus.DELIVERED;
        if (fulfillStatus === 'shipped') return OrderStatus.SHIPPED;
        if (['partial', 'scheduled'].includes(fulfillStatus)) return OrderStatus.PREPARING;
        if (fulfillStatus === 'on_hold') return OrderStatus.POSTPONED;

        // 3. Initial / Financial Stages (When unfulfilled/unshipped)

        return confirmed ? OrderStatus.CONFIRMED : OrderStatus.CONFIRMED;

        if (financial === 'pending') {
            return OrderStatus.NEW;
        }

        return null;
    }

    public verifyWebhookAuth(
        headers: Record<string, any>,
        body: any,
        store: StoreEntity,
        req?: any
    ): boolean {

        const savedSecret = store?.credentials?.webhookSecret;
        if (!savedSecret) return false;

        const shopifyHmac = headers['x-shopify-hmac-sha256'];
        if (!shopifyHmac) return false;

        // MUST use raw body buffer
        const rawBody = req?.rawBody;

        if (!rawBody) return false;

        const generatedHash = crypto
            .createHmac('sha256', savedSecret)
            .update(rawBody, 'utf8')
            .digest('base64');

        return crypto.timingSafeEqual(
            Buffer.from(generatedHash),
            Buffer.from(shopifyHmac)
        );
    }
    public mapWebhookUpdate(body: any): WebhookOrderUpdatePayload | null {
        const financialStatus = body.financial_status; // e.g., 'paid', 'pending'
        const fulfillmentStatus = body.fulfillment_status; // e.g., 'fulfilled', null

        const internalStatus = this.mapExternalStatusToInternal(financialStatus, fulfillmentStatus, body?.confirmed);

        if (!internalStatus) {
            return null;
        }

        return {
            externalId: String(body.id),
            // Store both as a combined string so you know exactly what happened on Shopify's end
            remoteStatus: `${financialStatus}/${fulfillmentStatus || 'null'}`,
            mappedStatus: internalStatus
        };
    }

    public async fetchRemoteProducts(store: StoreEntity, ids: string[]): Promise<any[]> {
        if (!ids || ids.length === 0) return [];

        const gids = ids.map(id => id.startsWith('gid://') ? id : `gid://shopify/Product/${id}`);

        const query = `
        query getProductsByIds($ids: [ID!]!) {
            nodes(ids: $ids) {
                ... on Product {
                    id
                    handle
                    title
                    variants(first: 100) {
                        nodes {
                            id
                            selectedOptions {
                                name
                                value
                            }
                        }
                    }
                }
            }
        }`;

        try {
            const response = await this.runGraphQL(store, false, query, { ids: gids });
            return (response?.nodes || []).filter(n => n !== null);
        } catch (error) {
            this.logger.error(`[Shopify] Batch fetch failed: ${error.message}`);
            return [];
        }
    }

    private mapPaymentMethod(gateway: string): PaymentMethod {
        const method = gateway.toLowerCase();
        if (method.includes('cod') || method.includes('cash')) {
            return PaymentMethod.CASH_ON_DELIVERY;
        }
        if (method.includes('bogus') || method.includes('manual')) {
            return PaymentMethod.CASH_ON_DELIVERY; // Often used for testing or manual COD
        }
        if (method.includes('stripe') || method.includes('visa') || method.includes('mastercard')) {
            return PaymentMethod.CARD;
        }
        if (method.includes('paypal')) {
            return PaymentMethod.WALLET;
        }
        return PaymentMethod.UNKNOWN;
    }

    public async mapWebhookCreate(body: any, store: StoreEntity): Promise<WebhookOrderPayload> {
        const paymentMethod = this.mapPaymentMethod(body.payment_gateway_names?.[0] || "");

        // 1. Group unique Product IDs (Filter out nulls for custom items)
        const lineItems = body.line_items || [];
        const uniqueIds = [...new Set(
            lineItems
                .filter((item: any) => item.product_id)
                .map((item: any) => String(item.product_id))
        )];

        // 2. Fetch actual handles (slugs) from Shopify
        const remoteProducts = await this.fetchRemoteProducts(store, uniqueIds as string[]);
        const idToSlugMap = new Map<string, string>();
        remoteProducts.forEach(p => idToSlugMap.set(p.externalId, p.slug));

        // 3. Address & Name Formatting
        const billing = body.billing_address || {};
        const fullName = `${billing.first_name || ""} ${billing.last_name || ""}`.trim();
        const address = `${billing.address1 || ""} ${billing.address2 || ""}`.trim();

        const variantIdToOptionsMap = new Map<string, { name: string, value: string }[]>();

        remoteProducts.forEach(product => {
            const numericProdId = product.id.split('/').pop();
            idToSlugMap.set(numericProdId, product.handle);

            // Map every variant's options for this product
            product.variants?.nodes?.forEach((v: any) => {
                const numericVarId = v.id.split('/').pop();
                variantIdToOptionsMap.set(numericVarId, v.selectedOptions);
            });
        });

        return {
            externalId: String(body.id),
            full_name: fullName || "Guest Customer",
            phone: billing.phone || body.customer?.phone || "",
            address: address || "No Address Provided",
            government: billing.city || "Unknown",
            payment_method: paymentMethod,

            // Status logic: Shopify 'paid' or 'partially_paid' means PAID
            status: ['paid', 'partially_paid'].includes(body.financial_status)
                ? PaymentStatus.PAID
                : PaymentStatus.PENDING,

            shipping_cost: Number(body.total_shipping_price_set?.shop_money?.amount || 0),

            cart_items: lineItems.map((item: any) => {
                const prodId = String(item.product_id);
                const varId = item.variant_id ? String(item.variant_id) : null;

                // Get the real properties from our map
                const realProps = varId ? variantIdToOptionsMap.get(varId) || [] : [];

                return {
                    product_slug: idToSlugMap.get(prodId) || item.sku || prodId,
                    quantity: item.quantity,
                    price: Number(item.price),
                    variant: item.variant_id ? {
                        // Filter out Shopify's "Default Title" for simple products
                        variation_props: realProps.filter(p => p.value).map(p => ({
                            name: p.name,
                            value: p.value
                        }))
                    } : undefined
                };
            })
        };
    }

    public async getFullProductBySlug(store: StoreEntity, slug: string): Promise<any> {
        const cleanSlug = slug?.trim();
        this.logCtxDebug(`[Product] Fetching FULL product with slug: ${cleanSlug}`, store);
        const query = `
        query getProductByHandle($handle: String!) {
            productByHandle(handle: $handle) {
                id
                handle
                title
                descriptionHtml
                productType
                vendor
                images(first: 20) {
                    nodes {
                        id
                        url
                        altText
                    }
                }
                variants(first: 100) {
                    nodes {
                        id
                        sku
                        title
                        price
                        inventoryQuantity
                        selectedOptions {
                            name
                            value
                        }
                    }
                }
                collections(first: 5) {
                    nodes {
                        id
                        handle
                        title
                    }
                }
            }
        }
        `;
        try {
            const response = await this.runGraphQL(store, false, query, { handle: cleanSlug });
            const product = response?.productByHandle || null;
            if (product) {
                this.logCtxDebug(`[Product] ✓ Found FULL product: ${product.title} (${product.id})`, store);
            } else {
                this.logCtxDebug(`[Product] ℹ No product found with slug: ${cleanSlug}`, store);
            }
            return product;
        } catch (error) {
            this.logCtxError(`[Product] ✗ Failed to fetch FULL product by handle ${cleanSlug}: ${error.message}`, store);
            throw error;
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
                // 1. Fetch remote product by slug (handle)
                const remoteProduct = await this.getFullProductBySlug(store, slug);
                if (!remoteProduct) {
                    this.logger.warn(`[Reverse Sync] Product with slug ${slug} not found on provider.`);
                    continue;
                }

                // 2. Map to unified payload and delegate to shared sync logic
                const unified = this.mapRemoteProductToUnified(remoteProduct);
                await this.mainStoresService.syncExternalProductPayloadToLocal(adminId, store, unified, manager);

                this.logger.log(`[Reverse Sync] Successfully processed: ${slug.trim()}`);
            } catch (error) {
                this.logger.error(`[Reverse Sync] Error syncing slug ${slug}: ${error.message}`);
            }
        }
    }

    /**
     * Sync a remote Shopify product and its variants to local DB using manager
     */
    private async syncExternalProductToLocal(adminId: string, store: StoreEntity, remoteProduct: any, manager: any): Promise<ProductEntity> {
        // Map remote product and variants to local DTOs
        const userContext = {
            id: store.adminId,
            adminId: store.adminId,
            role: { name: 'admin' }
        };

        // Map category: use productType as category name if available
        let localCategoryId: number | null = null;
        const categoryName = remoteProduct.productType || 'Shopify';
        const categorySlug = remoteProduct.handle || remoteProduct.id;
        const categoryRepo = manager.getRepository(CategoryEntity);
        let category = await categoryRepo.findOne({ where: { adminId: userContext.adminId, slug: categorySlug } });
        if (!category) {
            category = categoryRepo.create({
                adminId: userContext.adminId,
                name: categoryName,
                slug: categorySlug
            });
            category = await categoryRepo.save(category);
        }
        localCategoryId = category.id;

        // Map images
        const images: { url: string }[] =
            remoteProduct.images?.nodes?.map((img: any) => ({ url: img.url })) || [];

        // Map variants
        let combinations: any[] = [];
        const variantNodes = remoteProduct.variants?.nodes || [];
        if (variantNodes.length > 0) {
            combinations = variantNodes.map((v: any) => {
                return {
                    sku: v.sku || null,
                    price: parseFloat(v.price) || 0,
                    stockOnHand: v.inventoryQuantity ?? 0,
                    attributes: {}, // You can map selectedOptions if needed
                    key: v.sku || v.id || `variant_${remoteProduct.id}_${v.id}`
                };
            });
        } else {
            // Simple product (no variants)
            combinations = [{
                sku: null,
                price: 0,
                stockOnHand: 0,
                attributes: {},
                key: `simple_${remoteProduct.id}`
            }];
        }

        // Build product DTO
        const productDto = {
            name: remoteProduct.title,
            slug: remoteProduct.handle,
            description: remoteProduct.descriptionHtml || '',
            wholesalePrice: 0,
            lowestPrice: 0,
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

    private mapRemoteProductToUnified(remoteProduct: any): UnifiedProductDto {
        const images: string[] =
            remoteProduct.images?.nodes?.map((img: any) => img.url) || [];

        const variantNodes = remoteProduct.variants?.nodes || [];
        let variants: UnifiedProductVariantDto[] = [];

        if (variantNodes.length > 0) {
            variants = variantNodes.map((v: any, index: number) => {
                const attributes = (v.selectedOptions || []).reduce(
                    (acc: Record<string, string>, opt: any) => {
                        if (opt.name && opt.value) {
                            acc[opt.name.trim()] = String(opt.value).trim();
                        }
                        return acc;
                    },
                    {} as Record<string, string>,
                );

                const sku = v.sku || null;
                const price = parseFloat(v.price) || 0;
                const stockOnHand = v.inventoryQuantity ?? 0;

                // Let shared logic finalize key if needed; provide a good candidate
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
            variants = [
                {
                    sku: null,
                    price: 0,
                    stockOnHand: 0,
                    attributes: {},
                    key: `simple_${remoteProduct.id}`,
                },
            ];
        }

        // Prefer first collection as category, otherwise fall back to productType
        let category = null;
        const collection = remoteProduct.collections?.nodes?.[0];
        if (collection) {
            category = {
                slug: collection.handle || collection.id,
                name: collection.title || collection.handle || collection.id,
                thumb: null,
            };
        } else if (remoteProduct.productType) {
            const slug = String(remoteProduct.productType)
                .toLowerCase()
                .replace(/\s+/g, '-');
            category = {
                slug,
                name: remoteProduct.productType,
                thumb: null,
            };
        }

        const firstVariantPrice =
            variants.length > 0 ? variants[0].price : 0;

        return {
            externalId: remoteProduct.id ? String(remoteProduct.id) : undefined,
            name: remoteProduct.title,
            slug: remoteProduct.handle,
            description: remoteProduct.descriptionHtml || '',
            basePrice: firstVariantPrice,
            mainImage: images[0] || '',
            images,
            category,
            variants,
        };
    }

    async validateProviderConnection(store: StoreEntity): Promise<boolean> {
        const { storeUrl, credentials } = store;
        const apiKey = credentials?.apiKey;

        if (!storeUrl || !apiKey) {
            this.logger.error(`[Shopify] Validation skipped: Missing storeUrl or apiKey`);
            return false;
        }

        // Ensure the URL is clean and formatted for the request
        const url = this.getShopifyGraphQLEndpoint(store.storeUrl);

        try {
            const response = await axios.post(
                url,
                { query: '{ shop { name } }' },
                {
                    headers: {
                        'X-Shopify-Access-Token': apiKey.trim(),
                        'Content-Type': 'application/json',
                    },
                    timeout: 5000, // Keep it fast for the transaction
                }
            );

            // Shopify returns errors inside a 200 response sometimes
            if (response.data?.errors) {
                this.logger.error(`Shopify validation error: ${JSON.stringify(response.data.errors)}`);
                return false;
            }

            return !!response.data?.data?.shop?.name;
        } catch (error) {
            this.logger.error(`[Shopify] Connection check failed: ${error.message}`);
            // 401 Unauthorized or 404 Not Found (Invalid URL) returns false
            return false;
        }
    }
}
