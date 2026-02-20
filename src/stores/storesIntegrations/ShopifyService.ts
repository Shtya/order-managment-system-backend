import { forwardRef, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { BaseStoreService } from "./BaseStoreService";
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
import { OrderEntity } from "entities/order.entity";
import * as crypto from 'crypto';
import { ApolloClient, InMemoryCache, HttpLink, gql, ObservableQuery } from '@apollo/client/core';
import fetch from 'cross-fetch';

@Injectable()
export class ShopifyService extends BaseStoreService {


    constructor(
        @InjectRepository(StoreEntity) protected readonly storesRepo: Repository<StoreEntity>,
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
        super(storesRepo, categoryRepo, encryptionService, mainStoresService, process.env.EASY_ORDER_BASE_URL, 400, StoreProvider.SHOPIFY)

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
                isActive: true,
                autoSync: true,
            },
        });
        if (!store) {
            this.logger.debug(`Skipping sync for admin ${cleanAdminId}: No active Shopify store with autoSync enabled.`);
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
        const keys = await this.mainStoresService.getDecryptedIntegrations(store);

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
        const keys = await this.mainStoresService.getDecryptedIntegrations(store);
        // Note: Using storeUrl as the base for the token request
        const tokenUrl = `https://${store.storeUrl}/admin/oauth/access_token`;


        const body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: keys.clientKey, // client_id
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
    protected async runGraphQL(store: StoreEntity, isMutation = false, query: string, variables?: Record<string, any>, attempt = 0): Promise<any> {
        if (!store) throw new Error('Store is required for runGraphQL');

        const accessToken = await this.getAccessToken(store);
        const shopHost = store.storeUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const url = `https://${shopHost}/admin/api/2026-01/graphql.json`;

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

        // 2. Execute with your BaseStoreService Limiter
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
                } catch (error) {
                    this.logCtxError(`[Sync] Error processing product ${product.name} (ID: ${product.id}): ${error.message}`, store);
                    totalErrors++;
                }

                totalProcessed++;
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
            this.logCtxWarn(`[Sync] Skipping sync: No active store with autoSync enabled`, activeStore, product.adminId);
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

}
