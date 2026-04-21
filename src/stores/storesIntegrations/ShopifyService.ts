/**
 * Fetch a Shopify product by slug (handle) with all details needed for local sync
 */

import { forwardRef, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { BaseStoreProvider, WebhookOrderPayload, WebhookOrderUpdatePayload, UnifiedProductDto, UnifiedProductVariantDto, IBundleSyncProvider, MappedProductDto, ShopifyAction } from "./BaseStoreProvider";
import { InjectRepository } from "@nestjs/typeorm";
import { CategoryEntity } from "entities/categories.entity";
import { BundleEntity } from "entities/bundle.entity";
import { StoreEntity, StoreProvider, SyncStatus } from "entities/stores.entity";
import { ProductSyncAction, ProductSyncStateEntity, ProductSyncStatus } from "entities/product_sync_error.entity";
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
import { ProductSyncStateService } from "src/product-sync-state/product-sync-state.service";


@Injectable()
export class ShopifyService extends BaseStoreProvider implements IBundleSyncProvider {

    maxBundleItems?: number = 30;
    supportBundle: boolean = true;
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
        @Inject(forwardRef(() => CategoriesService)) private readonly categoriesService: CategoriesService,
        @InjectRepository(ProductSyncStateEntity) protected readonly productSyncStateRepo: Repository<ProductSyncStateEntity>,
        private readonly productSyncStateService: ProductSyncStateService,
        protected readonly redisService: RedisService,
        protected readonly encryptionService: EncryptionService,
        private readonly appGateway: AppGateway,
    ) {
        super(storesRepo, categoryRepo, productSyncStateRepo, encryptionService, mainStoresService, 400, StoreProvider.SHOPIFY)

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

        return store;

    }

    public async Init(query: Record<string, any>, adminId: string) {
        // 1. Extract hmac from the query
        const { hmac, ...params } = query;
        const rawShop = query.shop as string | undefined;
        const shop = rawShop?.split('/')[0].trim();
        const frontendBaseUrl = process.env.FRONTEND_URL?.trim();

        if (!shop || !hmac || !adminId) {
            return { url: `${frontendBaseUrl}/store-integration?error=shopify_invalid_session` };
        }

        const store = await this.getStoreForSync(adminId);
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
        store.externalStoreId = rawShop;

        await this.storesRepo.save(store);

        const redirectUrl = `${frontendBaseUrl}/store-integration`;

        return { url: redirectUrl };
    }



    private async getAccessToken(store: StoreEntity): Promise<string> {
        const apiKey = store?.credentials?.apiKey;

        const halfLength = apiKey ? Math.floor(apiKey.length / 2) : 0;

        const keyPart = apiKey?.slice(0, halfLength) || 'na';
        const cacheKey = `stores:${store.storeUrl}:${keyPart}:token`;
        let accessToken = await this.redisService.get(cacheKey);
        if (accessToken) return accessToken;

        this.logCtx(`[Shopify] No access token found. Generating new one...`, store);

        const keys = store?.credentials;

        // 1. [2025-12-24] Trim and Clean the URL
        // Remove any existing "https://" or "http://" to prevent the "ENOTFOUND https" error
        let cleanStoreUrl = store.storeUrl.trim().replace(/^https?:\/\//, '');

        // Ensure it doesn't end with a slash before building the path
        cleanStoreUrl = cleanStoreUrl.replace(/\/$/, '');

        const tokenUrl = `https://${cleanStoreUrl}/admin/oauth/access_token`;

        const body = new URLSearchParams({
            grant_type: 'client_credentials', // Note: Shopify typically uses this for specific flows
            client_id: keys.apiKey.trim(),
            client_secret: keys.clientSecret.trim()
        }).toString();

        try {
            // [2025-12-24] Use super.sendRequest but ensure the URL is handled correctly
            const response = await super.sendRequest(store, {
                method: 'POST',
                url: tokenUrl, // Full URL provided here
                data: body,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            // Some implementations of sendRequest return the data object directly
            const data = response?.data ?? response;
            const expiresIn = data?.expires_in ? Number(data.expires_in) : 82800;

            if (!data.access_token) {
                throw new Error('Access token missing in Shopify response');
            }

            // Cache the token (82800 seconds = 23 hours)
            await this.redisService.set(cacheKey, data.access_token, expiresIn);

            return data.access_token;
        } catch (error) {
            const message = this.getErrorMessage(error);
            this.logCtxError(`[Shopify] Token Generation Failed: ${message}`, store);
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

    protected async runGraphQL(store: StoreEntity, isMutation = false, query: string, variables?: Record<string, any>, attempt = 0, retry = true): Promise<any> {
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
                const message = this.getErrorMessage(error);
                this.logCtxError(`Apollo Request Failed: ${message}`, store);
                throw error;
            }
        }, attempt, 2000, 'Shopify GraphQL (Apollo)', retry);
    }

    // ===========================================================================
    // SYNC CATEGORY METHODS
    // ===========================================================================
    /**
     * Finds a collection by its handle (slug)
     */
    private async getCollectionByHandle(store: StoreEntity, handle: string) {
        const cleanHandle = handle?.trim();

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

        const response = await this.runGraphQL(
            store,
            false, // Use false here because this is a Query, not a Mutation
            query,
            { handle: `handle:${cleanHandle}` }
        );

        const collection = response?.collections?.nodes?.[0] || null;

        return collection;

    }

    private async getCollectionsByHandles(
        store: StoreEntity,
        handles: string[],
    ): Promise<any[]> {
        const cleanHandles = handles
            .map((h) => h?.trim())
            .filter((h): h is string => !!h);

        if (cleanHandles.length === 0) {
            return [];
        }

        // Build a search query like:
        // (handle:one OR handle:two OR handle:three)
        const queryParts = cleanHandles.map((handle) => `handle:${handle}`);
        const searchQuery =
            queryParts.length === 1
                ? queryParts[0]
                : `(${queryParts.join(" OR ")})`;

        const gql = `
            query getCollectionsByHandles($query: String!, $first: Int!) {
            collections(first: $first, query: $query) {
                nodes {
                id
                handle
                title
                }
            }
            }
        `;

        const variables = {
            query: searchQuery,
            first: cleanHandles.length, // up to number of handles
        };

        const response = await this.runGraphQL(
            store,
            false, // Query
            gql,
            variables,
        );

        // Adjust this line depending on what runGraphQL returns (data-unwrapped or not)
        const collections = response?.collections?.nodes
            ?? response?.data?.collections?.nodes
            ?? [];

        return collections;
    }


    /**
     * Creates a new Custom Collection
     */
    private async createCollection(store: StoreEntity, category: CategoryEntity) {

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


        const response = await this.runGraphQL(store, true, query, variables);

        // Handle Shopify-specific UserErrors
        const userErrors = response?.collectionCreate?.userErrors;
        if (userErrors && userErrors.length > 0) {
            throw new Error(`Shopify Error: ${userErrors[0].message}`);
        }
        const newCollection = response?.collectionCreate?.collection;

        return newCollection;

    }

    /**
     * Updates an existing Collection
     */
    private async updateCollection(store: StoreEntity, shopifyId: string, category: CategoryEntity) {
        if (!shopifyId) {
            return;
        }

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


        const response = await this.runGraphQL(store, true, mutation, variables);
        const userErrors = response?.collectionUpdate?.userErrors;
        if (userErrors && userErrors.length > 0) {
            throw new Error(`Shopify Error: ${userErrors[0].message}`);
        }
        return response.collectionUpdate.collection;

    }

    // ===========================================================================
    // SYNC PRODUCT METHODS
    // ===========================================================================
    private async getProductBySlug(store: StoreEntity, slug: string) {
        const cleanSlug = slug?.trim();

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


        const response = await this.runGraphQL(store, false, query, { handle: cleanSlug });
        const product = response?.productByHandle || null;

        return product;

    }

    private async buildProductSetInput(
        product: ProductEntity,
        variants: ProductVariantEntity[],
        locationId: string,
        store: StoreEntity,
    ) {
        const optionsMap = new Map<string, Set<string>>();
        const activeVariants = variants.filter(v => v.isActive);
        // Map variant attributes to options
        activeVariants.forEach((v) => {
            let attrs = {};
            try {
                attrs = typeof v.attributes === "string" ? JSON.parse(v.attributes) : v.attributes || {};
            } catch (e) {

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

        const variantsInput = activeVariants.map((v) => {
            let attributesObj: Record<string, any> = {};
            try {
                attributesObj =
                    typeof v.attributes === "string"
                        ? JSON.parse(v.attributes)
                        : (v.attributes || {});
            } catch (e: any) {
                const message = this.getErrorMessage(e);

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
                price: (v.price || product.salePrice || 0).toString(),
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

        const upsellMetafield = await this.getShopifyUpsellMetafield(product, store);

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
            metafields: upsellMetafield ? [upsellMetafield] : [],
            // You can also include tags, collectionsToJoin, metafields, etc. here if needed.
        };

        return input;
    }

    private async getShopifyUpsellMetafield(product: ProductEntity, store: StoreEntity): Promise<any> {
        if (!product.upsellingProducts?.length) return null;

        const upsellGids: string[] = [];

        for (const upsell of product.upsellingProducts) {
            if (!upsell.productId) continue;

            const localProduct = await this.productsRepo.findOne({
                where: { id: upsell.productId },
            });

            if (!localProduct) continue;

            let remoteProduct = await this.getProductBySlug(store, localProduct.slug);

            if (!remoteProduct) {
                await this.syncProduct({ productId: localProduct.id });
                remoteProduct = await this.getProductBySlug(store, localProduct.slug);
            }

            if (remoteProduct) {
                upsellGids.push(remoteProduct.id);
            }
        }

        if (upsellGids.length === 0) return null;

        return {
            namespace: "shopify--discovery--product_recommendation.complementary_products",
            key: "complementary_products",
            type: "list.product_reference",
            value: JSON.stringify(upsellGids),
        };
    }


    private async removeProductFromCategoryCollection(store: StoreEntity, previousCollectionId: string, productId: string) {
        const oldCid = previousCollectionId.trim();

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


        const removeResponse = await this.runGraphQL(
            store,
            true,
            removeMutation,
            removeVariables,
        );

        // const removeErrors =
        //     removeResponse?.collectionRemoveProducts?.userErrors;

    }

    private async setProductCategoryCollection(
        store: StoreEntity,
        newCollectionId: string,
        productId: string,
    ) {
        const cid = newCollectionId?.trim();
        const pid = productId?.trim();

        if (!cid || !pid) {
            return;
        }



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


        const addResponse = await this.runGraphQL(
            store,
            true,
            addMutation,
            addVariables,
        );

        const userErrors = addResponse?.collectionAddProducts?.userErrors;
        if (userErrors && userErrors.length > 0) {
            throw new Error(`Shopify Error: ${userErrors[0].message}`);
        }

        const collection = addResponse?.collectionAddProducts?.collection;


        return collection;
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
            throw new Error('ShopifyError: no locations found for store');
        }

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
                continue;
            }

            localVariant.externalId = shopifyVariant.id;
        }

        await this.pvRepo.save(localVariants);
    }

    private async updateProductWithProductSet(
        store: StoreEntity,
        product: ProductEntity,
        variants: ProductVariantEntity[],
        remoteProductId?: string,
    ): Promise<any> {
        const mode = remoteProductId ? "update" : "create";
        const identifier =
            remoteProductId
                ? { id: remoteProductId } // update existing product
                : undefined;
        const mutation = `
    mutation SetProduct(
      $identifier: ProductSetIdentifiers,
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

        const input = await this.buildProductSetInput(
            product,
            variants,
            locationId,
            store,
        );
        let variables: any = {
            input,
            synchronous: true,
        };
        if (identifier) {
            variables.identifier = identifier;
        }

        const response = await this.runGraphQL(store, true, mutation, variables);
        const payload = response?.productSet;

        const userErrors = payload?.userErrors;
        if (userErrors && userErrors.length > 0) {
            throw new Error(`Shopify productSet Error: ${userErrors[0].message}`);
        }

        const updatedProduct = payload?.product;
        const shopifyVariants = updatedProduct?.variants?.nodes || [];
        await this.syncLocalVariantIdsFromProductSet(variants, shopifyVariants);

        return updatedProduct;
    }

    private async getOnlineStorePublicationId(store: StoreEntity): Promise<string> {
        // If you already cached it for this store, return cached value


        const query = `
          query OnlineStorePublication {
            publications(first: 20) {
              nodes {
                id
                name
                supportsFuturePublishing
                autoPublish
              }
            }
          }
        `;

        const response = await this.runGraphQL(store, false, query, {});
        const publications = response?.publications?.nodes ?? [];

        const futurePub = publications.filter(p => p.supportsFuturePublishing);

        if (futurePub.length === 1) {
            return futurePub[0]?.id;
        }

        if (!futurePub) {
            return null;
        }

        const publicationId = futurePub.id;

        return publicationId;
    }
    private async publishProductToOnlineStore(
        store: StoreEntity,
        productGid: string,

    ): Promise<any> {
        const publicationId = await this.getOnlineStorePublicationId(store);
        if (!publicationId) {
            return null;
        }
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
            return null;
        }

        const publishedProduct = payload?.publishable;

        return !!publishedProduct;
    }


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
                    ...(lastId ? { id: MoreThan(lastId) } : {}),
                },
                order: { id: "ASC" } as any,
                take: 30,
            });

            if (localBatch.length === 0) {
                hasMore = false;
                break;
            }

            // Build handles array from slugs
            const handles = localBatch
                .map((c) => c.slug?.trim())
                .filter((h): h is string => !!h);

            // Bulk fetch collections by handle from Shopify
            const remoteCollections = await this.getCollectionsByHandles(store, handles);

            // Map<handle, collectionId>
            const remoteMap = new Map<string, string>(
                remoteCollections.map((col: any) => [col.handle?.trim(), col.id]),
            );

            for (const cat of localBatch) {
                const localHandle = cat.slug?.trim();

                // Existing remote collection for this handle?
                let extId = remoteMap.get(localHandle);

                try {
                    const response = extId
                        ? await this.updateCollection(store, extId, cat) // update existing collection
                        : await this.createCollection(store, cat);       // create new collection

                    const finalId = extId ? String(extId) : String(response.id);

                    // Key is now string (local category id as string)
                    categoryMap.set(String(cat.id), finalId);

                    if (extId) {
                        totalUpdated++;
                    } else {
                        totalCreated++;
                    }
                } catch (error) {
                    const message = this.getErrorMessage(error);
                    this.logCtxError(
                        `[Sync] Error processing category ${cat.name} (ID: ${cat.id}): ${message}`,
                        store,
                    );
                }

                totalProcessed++;
            }

            lastId = localBatch[localBatch.length - 1].id;
        }

        this.logCtx(
            `[Sync] ✓ Category sync completed | Total: ${totalProcessed} | Created: ${totalCreated} | Updated: ${totalUpdated}`,
            store,
        );

        return categoryMap;
    }


    private async syncProductsCursor(
        store: StoreEntity,
        categoryMap: Map<string, string>, // Map<localCategoryIdAsString, externalCollectionId>
    ) {
        let lastId = "";
        let hasMore = true;
        let totalProcessed = 0;
        let totalCreated = 0;
        let totalUpdated = 0;
        let totalErrors = 0;

        while (hasMore) {
            const qb = this.storesRepo.manager
                .createQueryBuilder(ProductEntity, "product")
                .leftJoinAndSelect("product.variants", "variants")
                .leftJoinAndSelect("product.category", "category")
                .leftJoinAndMapOne(
                    "product.syncState",
                    ProductSyncStateEntity,
                    "syncState",
                    "syncState.productId = product.id " +
                    "AND syncState.storeId = :storeId " +
                    "AND syncState.adminId = :adminId " +
                    "AND syncState.externalStoreId = :externalStoreId",
                    {
                        storeId: store.id,
                        adminId: store.adminId,
                        externalStoreId: store.externalStoreId,
                    },
                )
                .where("product.storeId = :storeId", { storeId: store.id })
                .andWhere("product.adminId = :adminId", { adminId: store.adminId })
                .andWhere("product.isActive = :isActive", { isActive: true })
                .orderBy("product.id", "ASC")
                .take(20);

            if (lastId) {
                qb.andWhere("product.id > :lastId", { lastId });
            }

            const localBatch = (await qb.getMany()) as any[];

            if (localBatch.length === 0) {
                hasMore = false;
                break;
            }

            const remoteIds = localBatch
                .map((p) => p.syncState?.remoteProductId as string | undefined)
                .filter((id): id is string => !!id);

            // 2) Bulk fetch remote products from Shopify by IDs
            const remoteItems =
                remoteIds.length > 0 ? await this.getProductsByIds(store, remoteIds) : [];
            const remoteMap = new Map<string, any>(
                remoteItems.map((r: any) => [String(r.id), r]),
            );

            // 3) Per-product sync logic (similar to syncProduct)
            for (const product of localBatch) {
                const productId = String(product.id);
                const syncState = product.syncState;
                let externalId: string | null = syncState?.remoteProductId || null;
                const action = externalId
                    ? ProductSyncAction.UPDATE
                    : ProductSyncAction.CREATE;

                try {
                    // 3.1 Resolve category / external collection
                    let externalCategory: { id: string } | null = null;


                    if (product.categoryId) {
                        const extCatId = categoryMap.get(String(product.categoryId));
                        if (extCatId) {
                            externalCategory = { id: extCatId };
                        }
                    }

                    // Fallback: sync category on the fly if not found in map
                    if (!externalCategory && product.category) {
                        const remoteCategory = await this.syncCategory({
                            category: product.category,
                            slug: product.category.slug,
                            relatedAdminId: product.adminId,
                        });
                        if (remoteCategory?.id) {
                            externalCategory = { id: remoteCategory.id };
                            // Optionally update categoryMap for future runs
                            categoryMap.set(String(product.category.id), remoteCategory.id);
                        }
                    }

                    // 3.2 Get variants (already joined by leftJoinAndSelect)
                    const variants = product.variants || [];

                    // 3.3 Decide if we are updating an existing remote product
                    const remote = externalId ? remoteMap.get(String(externalId)) : null;

                    let syncedProduct: any;
                    if (remote) {
                        syncedProduct = await this.updateProductWithProductSet(
                            store,
                            product,
                            variants,
                            externalId,
                        );
                    } else {
                        // No remoteId yet -> create
                        syncedProduct = await this.updateProductWithProductSet(
                            store,
                            product,
                            variants,
                        );
                    }

                    externalId = syncedProduct?.id;
                    if (externalId) {
                        // 3.4 Publish to Online Store
                        await this.publishProductToOnlineStore(store, syncedProduct.id);

                        // 3.5 Handle collections (category collection logic)
                        const collectionsConnection = syncedProduct.collections;
                        const collectionNodes = collectionsConnection?.nodes || [];

                        // Previous category collection (any collection different from the current one)
                        const previousCategoryCollection = collectionNodes.find(
                            (c: any) => c.id !== externalCategory?.id,
                        );
                        const previousCategoryCollectionId =
                            previousCategoryCollection?.id ?? null;

                        if (
                            previousCategoryCollectionId &&
                            previousCategoryCollectionId !== externalCategory?.id
                        ) {
                            await this.removeProductFromCategoryCollection(
                                store,
                                previousCategoryCollectionId,
                                syncedProduct.id,
                            );
                        }

                        // Ensure product is in the current category collection
                        if (externalCategory?.id) {
                            const alreadyAdded = collectionNodes.find(
                                (c: any) => c.id === externalCategory.id,
                            );
                            if (!alreadyAdded) {
                                await this.setProductCategoryCollection(
                                    store,
                                    externalCategory.id,
                                    syncedProduct.id,
                                );
                            }
                        }
                    }

                    // 3.6 SUCCESS STATE UPDATE
                    await this.productSyncStateService.upsertSyncState(
                        {
                            adminId: store.adminId,
                            productId: productId,
                            storeId: store.id,
                            externalStoreId: store.externalStoreId,
                        },
                        {
                            // Follow syncProduct: remoteProductId comes from syncedProduct.externalId
                            remoteProductId: externalId ?? externalId ?? null,
                            status: ProductSyncStatus.SYNCED,
                            lastError: null,
                            lastSynced_at: new Date(),
                        },
                    );

                    // Update counters
                    if (action === ProductSyncAction.UPDATE) {
                        totalUpdated++;
                    } else {
                        totalCreated++;
                    }

                    totalProcessed++;
                } catch (error: any) {
                    const errorMessage = this.getErrorMessage(error);
                    const remoteId = externalId;

                    // FAILURE STATE UPDATE
                    await this.productSyncStateService.upsertSyncState(
                        {
                            adminId: store.adminId,
                            productId: productId,
                            storeId: store.id,
                            externalStoreId: store.externalStoreId,
                        },
                        {
                            remoteProductId: externalId || null,
                            status: ProductSyncStatus.FAILED,
                            lastError: errorMessage,
                            lastSynced_at: new Date(),
                        },
                    );

                    // LOG THE ERROR
                    await this.productSyncStateService.upsertSyncErrorLog(
                        {
                            adminId: store.adminId,
                            productId: productId,
                            storeId: store.id,
                        },
                        {
                            remoteProductId: externalId || null,
                            action,
                            errorMessage,
                            userMessage: `Failed to sync product "${product.name}" to ${store.name}: ${errorMessage}`,
                            responseStatus: error?.response?.status,
                            requestPayload: error?.config?.data
                                ? JSON.parse(error.config.data)
                                : null,
                        },
                    );

                    this.logCtxError(
                        `[Sync] Error processing product ${product.name} (ID: ${product.id}): ${errorMessage}`,
                        store,
                    );

                    totalErrors++;
                }
            }

            lastId = localBatch[localBatch.length - 1].id;
        }

        this.logCtx(
            `[Sync] ✓ Product sync completed | Total: ${totalProcessed} | Created: ${totalCreated} | Updated: ${totalUpdated} | Errors: ${totalErrors}`,
            store,
        );
    }
    // ===========================================================================
    // MAIN ENTRY POINTS FOR SYNC
    // ===========================================================================

    public async syncCategory({ category, relatedAdminId, slug }: { category: CategoryEntity, relatedAdminId?: string, slug?: string }) {
        const adminId = relatedAdminId || category.adminId;
        const store = await this.getStoreForSync(adminId);

        if (!store) {
            throw new Error(`No active store enabled for admin (${adminId})`);
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
    public async syncBundle(bundle: BundleEntity) {

        // 1. Validate Store
        const store = await this.getStoreForSync(bundle.adminId);
        if (!store) {
            return;
        }

        try {
            // 1. Sync products (main product variant and items product variants)
            // Sync main product variant
            if (bundle.variant && bundle.variant.product) {
                await this.syncProduct({
                    productId: bundle.variant.productId
                });
            }

            // Sync item product variants
            for (const item of bundle.items) {
                if (item.variant && item.variant.product) {
                    await this.syncProduct({
                        productId: item.variant.productId
                    });
                }
            }

            // 2. Get remote bundle details by legacyResourceId and main variant sku
            const handle = bundle.variant?.product?.slug;
            if (!handle) throw new Error("Bundle variant product slug is missing");

            const getProductLegacyIdQuery = `
                query GetProductLegacyIdByHandle($handle: String!) {
                    productByHandle(handle: $handle) {
                        id
                        legacyResourceId
                        handle
                        title
                    }
                }
            `;
            const productLegacyIdData = await this.runGraphQL(store, false, getProductLegacyIdQuery, { handle });
            const remoteProduct = productLegacyIdData.productByHandle;
            if (!remoteProduct) throw new Error(`Product with handle ${handle} not found on Shopify`);

            const legacyResourceId = remoteProduct.legacyResourceId;

            const bundleDetailsQuery = `
                query BundleByProductAndVariantSku($query: String!) {
                    productVariants(first: 10, query: $query) {
                        nodes {
                            id
                            sku
                            title
                            requiresComponents
                            productVariantComponents(first: 30) {
                                nodes {
                                    id
                                    quantity
                                    productVariant {
                                        id
                                        sku
                                        title
                                        product {
                                            id
                                            title
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            `;
            const bundleQueryString = `product_id:${legacyResourceId} AND sku:${bundle.variant.sku} AND requires_components:true`;
            const bundleDetailsData = await this.runGraphQL(store, false, bundleDetailsQuery, { query: bundleQueryString });

            const remoteBundleVariant = bundleDetailsData.productVariants.nodes[0];
            if (!remoteBundleVariant) throw new Error(`Bundle variant with SKU ${bundle.variant.sku} not found on Shopify or doesn't require components`);

            const parentProductVariantId = remoteBundleVariant.id;
            const remoteComponents = remoteBundleVariant.productVariantComponents.nodes;

            // 3. Determine components to create, update, or remove
            const localItems = bundle.items;
            const productVariantRelationshipsToCreate = [];
            const productVariantRelationshipsToUpdate = [];
            const productVariantRelationshipsToRemove = [];
            const productVariantsCache: Map<string, Map<string, string>> = new Map();
            const findRemoteVariantIdBySku = async (handle: string, sku: string) => {
                if (!productVariantsCache.has(handle)) {
                    productVariantsCache.set(handle, new Map());
                    let cursor = null;
                    let hasNextPage = true;

                    const query = `
                        query VariantsByProductHandle($handle: String!, $cursor: String) {
                            productByHandle(handle: $handle) {
                                id
                                handle
                                variants(first: 250, after: $cursor) {
                                    nodes {
                                        id
                                        sku
                                        title
                                    }
                                    pageInfo {
                                        hasNextPage
                                        endCursor
                                    }
                                }
                            }
                        }
                    `;

                    while (hasNextPage) {
                        const variables = { handle, cursor };
                        const data = await this.runGraphQL(store, false, query, variables);
                        const product = data.productByHandle;

                        if (!product) {
                            break;
                        }

                        for (const variant of product.variants.nodes) {
                            productVariantsCache.get(handle).set(variant.sku, variant.id);
                        }

                        hasNextPage = product.variants.pageInfo.hasNextPage;
                        cursor = product.variants.pageInfo.endCursor;
                    }
                }

                return productVariantsCache.get(handle).get(sku);
            };

            const remoteComponentsMap = new Map();
            for (const comp of remoteComponents) {
                remoteComponentsMap.set(comp.productVariant.sku, comp);
            }

            for (const localItem of localItems) {
                const sku = localItem.variant.sku;
                const remoteComp = remoteComponentsMap.get(sku);

                if (remoteComp) {
                    if (remoteComp.quantity !== localItem.qty) {
                        productVariantRelationshipsToUpdate.push({
                            id: remoteComp.productVariant.id,
                            quantity: localItem.qty
                        });
                    }
                    remoteComponentsMap.delete(sku);
                } else {
                    const itemHandle = localItem.variant.product?.slug;
                    if (!itemHandle) {

                        continue;
                    }
                    const remoteVariantId = await findRemoteVariantIdBySku(itemHandle, sku);
                    if (remoteVariantId) {
                        productVariantRelationshipsToCreate.push({
                            id: remoteVariantId,
                            quantity: localItem.qty
                        });
                    } else {

                    }
                }
            }

            for (const remoteComp of remoteComponentsMap.values()) {
                productVariantRelationshipsToRemove.push(remoteComp.productVariant.id);
            }

            // Call mutation
            if (productVariantRelationshipsToCreate.length > 0 || productVariantRelationshipsToUpdate.length > 0 || productVariantRelationshipsToRemove.length > 0) {
                const updateMutation = `
                    mutation UpdateBundleComponents($input: [ProductVariantRelationshipUpdateInput!]!) {
                        productVariantRelationshipBulkUpdate(input: $input) {
                            parentProductVariants {
                                id
                                productVariantComponents(first: 10) {
                                    nodes {
                                        id
                                        quantity
                                        productVariant {
                                            id
                                            displayName
                                        }
                                    }
                                }
                            }
                            userErrors {
                                code
                                field
                                message
                            }
                        }
                    }
                `;

                const variables = {
                    input: [{
                        parentProductVariantId,
                        productVariantRelationshipsToCreate,
                        productVariantRelationshipsToUpdate,
                        productVariantRelationshipsToRemove
                    }]
                };

                const mutationResult = await this.runGraphQL(store, true, updateMutation, variables);
                const errors = mutationResult.productVariantRelationshipBulkUpdate.userErrors;
                if (errors && errors.length > 0) {
                    throw new Error(`Shopify mutation errors: ${JSON.stringify(errors)}`);
                }
            }
        } catch (error) {
            const message = this.getErrorMessage(error);
            throw error;
        }
    }

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

        const productSyncState = await this.productSyncStateRepo.findOne({
            where: {
                productId: productId,
                storeId: product.store.id,
                adminId: product.adminId,
                externalStoreId: product?.store?.externalStoreId
            }
        });
        let externalId = productSyncState?.remoteProductId;
        const action = externalId ? ProductSyncAction.UPDATE : ProductSyncAction.CREATE;
        const activeStore = await this.getStoreForSync(product.adminId);

        if (!activeStore) {
            throw new Error(`No active store enabled for admin (${product.adminId})`);
        }

        try {
            // 2. ⚡ RESOLVE COLLECTION ID (Category) ⚡
            let externalCategory = null;
            if (product.category) {
                externalCategory = await this.syncCategory({ category: product.category, slug: product.category.slug, relatedAdminId: product.adminId });
            }

            let syncedProduct;
            if (externalId) {
                const remoteProduct = await this.getProduct(activeStore, externalId);
                if (remoteProduct) {
                    syncedProduct = await this.updateProductWithProductSet(activeStore, product, variants, externalId)
                } else {
                    syncedProduct = await this.updateProductWithProductSet(activeStore, product, variants, externalId)
                }
            } else {
                syncedProduct = await this.updateProductWithProductSet(activeStore, product, variants)
            }

            externalId = syncedProduct?.id;

            if (externalId) {

                const isPublished = await this.publishProductToOnlineStore(activeStore, syncedProduct.id);

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
                        externalId,

                    );
            }

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

    public async syncOrderStatus(order: OrderEntity, newStatusId: string): Promise<void> {
        const store = await this.getStoreForSync(order.adminId);
        if (!store) {
            throw new Error(`No active store enabled for admin (${order.adminId})`);
        }

        await this.updateOrderStatus(order, store, newStatusId);
    }

    public async updateOrderStatus(
        order: OrderEntity,
        store: StoreEntity,
        newStatusId: string,
    ): Promise<void> {

        if (!order.externalId) return;

        // 1) Resolve internal status record
        const status = await this.ordersService.findStatusById(
            newStatusId,
            order.adminId,
        );

        if (!status) {
            this.logger.warn(
                `No status found for order (${order.id}) | admin (${order.adminId}) | local status: ${order.status}`,
            );
            return;
        }

        const internalStatus = status.code as OrderStatus;
        const action = this.mapStatusToShopifyAction(internalStatus);

        switch (action) {
            case "FULFILL":
                await this.createFulfillment(order, store);
                break;

            // case "PARTIAL_FULFILL":
            //     await this.createPartialFulfillment(order, store);
            //     break;

            case "CANCEL":
                await this.cancelFulfillment(order, store);
                break;

            case "HOLD":
                await this.holdFulfillment(order, store);
                break;

            case "NONE":
            default:
                // 🔥 Do nothing for states that don't map to a Shopify fulfillment/cancellation action
                return;
        }
    }

    private async createFulfillment(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<void> {
        const orderGid = order.externalId; // Shopify Order GID

        // 1) Fetch fulfillment orders for this order
        const foQuery = `
    query GetFulfillmentOrders($orderId: ID!) {
      order(id: $orderId) {
        id
        fulfillmentOrders(first: 10) {
          nodes {
            id
            status
          }
        }
      }
    }
  `;


        const foResponse = await this.runGraphQL(store, false, foQuery, {
            orderId: orderGid,
        });

        const orderNode =
            foResponse?.order ?? foResponse?.data?.order ?? null;
        const fulfillmentOrders =
            orderNode?.fulfillmentOrders?.nodes ?? [];

        if (!fulfillmentOrders.length) {
            this.logger.warn(
                `[Shopify] No fulfillment orders found for order ${order.id} (${order.externalId})`,
            );
            return;
        }

        // Pick the first "OPEN" (or similar) fulfillment order
        const targetFO = fulfillmentOrders.find(
            (fo: any) => fo.status === "open" || fo.status === "in_progress",
        ) || fulfillmentOrders[0];

        const fulfillmentOrderId = targetFO.id;

        // 2) Create fulfillment for all remaining items in this fulfillment order
        const mutation = `
      mutation FulfillAllRemainingItems($fulfillmentOrderId: ID!) {
        fulfillmentCreateV2(
          fulfillment: {
            notifyCustomer: true
            lineItemsByFulfillmentOrder: [
              {
                fulfillmentOrderId: $fulfillmentOrderId
                fulfillmentOrderLineItems: []
              }
            ]
          }
        ) {
          fulfillment {
            id
            status
            trackingInfo {
              company
              number
              url
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
            fulfillmentOrderId,
        };

        const fulfillResponse = await this.runGraphQL(
            store,
            true,
            mutation,
            variables,
        );

        const payload =
            fulfillResponse?.fulfillmentCreateV2 ??
            fulfillResponse?.data?.fulfillmentCreateV2 ??
            null;

        if (!payload) {
            this.logger.error(
                `[Shopify] fulfillmentCreateV2 returned empty payload for order ${order.id} (${order.externalId})`,
            );
            return;
        }

        const userErrors = payload.userErrors;
        if (userErrors && userErrors.length > 0) {
            this.logger.error(
                `[Shopify] fulfillmentCreateV2 errors for order ${order.id} (${order.externalId}): ${userErrors[0].message}`,
            );
        } else {
            this.logger.log(
                `[Shopify] Successfully fulfilled all remaining items for fulfillmentOrder ${fulfillmentOrderId} (order ${order.id})`,
            );
        }

    }
    private async createPartialFulfillment(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<void> {
        const orderGid = order.externalId;

        const mutation = `
    mutation PartialFulfillOrder($orderId: ID!) {
      # Placeholder – implement logic using fulfillmentOrders
      order(id: $orderId) {
        id
      }
    }
  `;

        const variables = { orderId: orderGid };


        await this.runGraphQL(store, true, mutation, variables);

    }

    private async cancelFulfillment(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<void> {
        const orderGid = order.externalId; // should be a Shopify Order GID

        const mutation = `
    mutation CancelOrder($orderId: ID!) {
      orderCancel(
        orderId: $orderId
        refund: false
        restock: true
        notifyCustomer: true
        reason: INVENTORY
        staffNote: "Cancelled via integration"
      ) {
        job {
          id
          done
        }
        orderCancelUserErrors {
          field
          message
          code
        }
      }
    }
  `;

        const variables = { orderId: orderGid };


        const response = await this.runGraphQL(store, true, mutation, variables);

        const payload =
            response?.orderCancel ?? response?.data?.orderCancel ?? null;

        if (!payload) {
            this.logger.error(
                `[Shopify] orderCancel returned empty payload for order ${order.id} (${order.externalId})`,
            );
            return;
        }

        const errors = payload.orderCancelUserErrors;
        if (errors && errors.length > 0) {
            this.logger.error(
                `[Shopify] Failed to cancel order ${order.id} (${order.externalId}): ${errors[0].message} (code: ${errors[0].code})`,
            );
            return;
        }

        const job = payload.job;
        if (job) {
            this.logger.log(
                `[Shopify] orderCancel job created for order ${order.id} (${order.externalId}) | jobId: ${job.id} | done: ${job.done}`,
            );
            // If you want, you can poll the job until done using the Job API
        }

    }

    private async holdFulfillment(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<void> {
        const orderGid = order.externalId;

        // 1) Fetch current tags for the order
        const fetchQuery = `
    query GetOrderTags($id: ID!) {
      order(id: $id) {
        id
        tags
      }
    }
  `;

        const fetchResponse = await this.runGraphQL(store, false, fetchQuery, {
            id: orderGid,
        });

        const orderNode =
            fetchResponse?.order ?? fetchResponse?.data?.order ?? null;

        if (!orderNode) {
            this.logger.error(
                `[Shopify] Could not load order ${order.id} (${order.externalId}) to put on hold`,
            );
            return;
        }

        const existingTags: string[] = orderNode.tags || [];
        const newTags = new Set(existingTags.map((t) => t.trim()).filter(Boolean));
        newTags.add("on_hold");

        const tagsArray = Array.from(newTags);

        // 2) Update tags using orderUpdate
        const mutation = `
      mutation HoldOrder($id: ID!, $tags: [String!]) {
        orderUpdate(input: { id: $id, tags: $tags }) {
          order {
            id
            tags
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

        const variables = {
            id: orderGid,
            tags: tagsArray,
        };

        const response = await this.runGraphQL(store, true, mutation, variables);
        const payload =
            response?.orderUpdate ?? response?.data?.orderUpdate ?? null;

        if (!payload) {
            this.logger.error(
                `[Shopify] orderUpdate returned empty payload for hold on order ${order.id} (${order.externalId})`,
            );
            return;
        }

        const userErrors = payload.userErrors;
        if (userErrors && userErrors.length > 0) {
            this.logger.error(
                `[Shopify] Failed to put order ${order.id} (${order.externalId}) on hold: ${userErrors[0].message}`,
            );
            return;
        }

        this.logger.log(
            `[Shopify] Order ${order.id} (${order.externalId}) tagged as on_hold`,
        );

    }


    public mapStatusToShopifyAction(status: OrderStatus): ShopifyAction {
        switch (status) {
            case OrderStatus.DELIVERED:
                return "FULFILL";

            // case OrderStatus.SHIPPED:
            //     return "PARTIAL_FULFILL";

            case OrderStatus.CANCELLED:
            case OrderStatus.REJECTED:
            case OrderStatus.FAILED_DELIVERY:
                return "CANCEL";

            case OrderStatus.POSTPONED:
                return "HOLD";

            default:
                return "NONE";
        }
    }


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

            const categoryMap = await this.syncCategoriesCursor(store);

            await this.syncProductsCursor(store, categoryMap);

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

    // ===========================================================================
    // WEBHOOK
    // ===========================================================================



    public verifyWebhookAuth(
        headers: Record<string, any>,
        body: any,
        store: StoreEntity,
        req?: any,
        action?: "create" | "update"
    ): boolean {

        const savedSecret = store?.credentials?.webhookSecret;
        if (!savedSecret) {
            return true;
        }

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
    public mapWebhookUpdate(body: any, localOrderStatus: OrderStatus): WebhookOrderUpdatePayload | null {
        const financialStatus = body.financial_status; // e.g., 'paid', 'pending'
        const fulfillmentStatus = body.fulfillment_status; // e.g., 'fulfilled', null

        const { orderStatus, paymentStatus } = this.mapShopifyWebhookStatusToInternal(body)

        return {
            externalId: body.order_id,
            remoteStatus: orderStatus,
            mappedStatus: orderStatus,
            mappedPaymentStatus: paymentStatus
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
            const message = this.getErrorMessage(error);
            this.logger.error(`[Shopify] Batch fetch failed: ${message}`);
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

    private mapShopifyFinancialStatusToPaymentStatus(
        financialStatus?: string | null,
    ): PaymentStatus | null {
        switch (financialStatus) {
            case "paid":
            case "authorized":
                return PaymentStatus.PAID;
            case "partially_paid":
                return PaymentStatus.PARTIAL;

            case "refunded":
                return PaymentStatus.REFUNDED;
            case "partially_refunded":
                return PaymentStatus.PARTIALLY_REFUNDED;
            case "partially_refunded":

            case "pending":
            case "voided":
            case "expired":
            default:
                return PaymentStatus.PENDING;
        }
    }

    private mapShopifyStatusesToOrderStatus(
        fulfillmentStatus: string | null | undefined,
        cancelledAt: string | null | undefined,
    ): OrderStatus {

        // 1) Cancellation always overrides
        if (cancelledAt) {
            return OrderStatus.CANCELLED;
        }

        // 🔥 normalize to lowercase once
        const status = fulfillmentStatus?.toLowerCase();

        switch (status) {
            case "fulfilled":
                return OrderStatus.DELIVERED;

            case "partially_fulfilled":
                return OrderStatus.SHIPPED;

            case "in_progress":
            case "pending_fulfillment":
            case "scheduled":
                return OrderStatus.PREPARING;

            case "on_hold":
                return OrderStatus.POSTPONED;

            case "request_declined":
                return OrderStatus.REJECTED;

            case "restocked":
                return OrderStatus.RETURNED;

            case "open":
            case "unfulfilled":
            case null:
            case undefined:
            default:
                return OrderStatus.NEW;
        }
    }

    private mapShopifyWebhookStatusToInternal(body: any): {
        orderStatus: OrderStatus | null;
        paymentStatus: PaymentStatus | null;
    } {
        const financialStatus = body.financial_status as string | null;
        const fulfillmentStatus = body.fulfillment_status as string | null;
        const cancelledAt = body.cancelled_at as string | null;

        const paymentStatus = this.mapShopifyFinancialStatusToPaymentStatus(
            financialStatus,
        );
        const orderStatus = this.mapShopifyStatusesToOrderStatus(
            fulfillmentStatus,
            cancelledAt,
        );

        return { orderStatus, paymentStatus };
    }

    public async mapWebhookCreate(body: any, store: StoreEntity): Promise<WebhookOrderPayload> {
        const paymentMethod = this.mapPaymentMethod(body.payment_gateway_names?.[0] || "");
        const { orderStatus, paymentStatus } = this.mapShopifyWebhookStatusToInternal(body)
        // 1. Group unique Product IDs (Filter out nulls for custom items)
        const lineItems = body.line_items || [];
        const uniqueIds = [...new Set(
            lineItems
                .filter((item) => item.product_id)
                .map((item) => String(item.product_id))
        )];

        // 2. Fetch actual handles (slugs) from Shopify
        const remoteProducts = await this.getProductsByIds(store, uniqueIds as string[]);
        const idToSlugMap = new Map<string, string>();
        remoteProducts.forEach(p => idToSlugMap.set(p.externalId, p.slug));

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

        const billing = body.billing_address || {};
        const fullName = `${billing.first_name || ""} ${billing.last_name || ""}`.trim();
        const address = `${billing.address1 || ""} ${billing.address2 || ""}`.trim();
        return {
            externalOrderId: String(body.id),
            fullName: fullName || "Guest Customer",
            email: billing.email || body.customer?.email || "",
            phone: billing.phone || body.customer?.phone || "",
            address: address || "No Address Provided",
            government: billing.city || "Unknown",
            paymentMethod: paymentMethod,
            paymentStatus: paymentStatus || PaymentStatus.PENDING,
            status: orderStatus || OrderStatus.NEW,

            shippingCost: Number(body.total_shipping_price_set?.shop_money?.amount || 0),
            totalCost: Number(body.total_price_set?.shop_money?.amount || 0),
            cartItems: lineItems.map((item: any) => {
                const prodId = String(item.product_id);
                const varId = item.variant_id ? String(item.variant_id) : null;

                // Get the real properties from our map
                const realProps = varId ? variantIdToOptionsMap.get(varId) || [] : [];

                const variationProps = realProps.filter(p => p.value).map(p => ({
                    name: p.name,
                    value: p.value
                }));

                const payloadAttrs: Record<string, string> = {};
                variationProps.forEach(prop => {
                    payloadAttrs[prop.name] = prop.value;
                });

                return {
                    name: String(item.product?.name || item.product?.title),
                    productSlug: idToSlugMap.get(prodId) || item.sku || prodId,
                    remoteProductId: item.product?.id || prodId,
                    quantity: item.quantity,
                    price: Number(item.price),
                    variant: item.variant_id ? {
                        key: this.productsService.canonicalKey(payloadAttrs),
                        // Filter out Shopify's "Default Title" for simple products
                        variation_props: variationProps
                    } : undefined
                };
            })
        };
    }


    public async getFullProductById(
        store: StoreEntity,
        remoteProductId: string,
        retry = false,
    ): Promise<MappedProductDto | null> {
        const cleanId = remoteProductId?.trim();

        const query = `
    query getProductById($id: ID!) {
      product(id: $id) {
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
            inventoryItem {
            unitCost {
                amount
                currencyCode
             }   
            }
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
            const response = await this.runGraphQL(
                store,
                false,           // query, not mutation
                query,
                { id: cleanId },
                0,
                retry,
            );

            // Depends on runGraphQL shape: here assuming it returns data directly
            const product = response?.product || null;

            if (product) {
                return this.mapRemoteProductToDto(product);
            } else {
                return null;
            }
        } catch (error) {
            const message = this.getErrorMessage(error);
            // You can log the message if needed
            throw error;
        }
    }

    public async getProduct(store: StoreEntity, remoteProductId: string) {

        // 🔥 Ensure GID format

        const query = `
                query getProductById($id: ID!) {
                product(id: $id) {
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
                        inventoryItem {
                        unitCost {
                            amount
                            currencyCode
                        }
                        }
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
            const response = await this.runGraphQL(
                store,
                false,
                query,
                { id: remoteProductId },
            );

            return response?.product || null;

        } catch (error) {
            return null;
        }
    }

    public async getProductsByIds(
        store: StoreEntity,
        remoteProductIds: string[],
    ): Promise<any[]> {
        const cleanIds = remoteProductIds
            .map((id) => id?.trim())
            .filter((id): id is string => !!id);

        if (cleanIds.length === 0) {
            return [];
        }

        const query = `
    query getProductsByIds($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
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
    }
            `;

        try {
            const response = await this.runGraphQL(
                store,
                false, // query, not mutation
                query,
                { ids: cleanIds },
            );


            const nodes = response?.nodes ?? response?.data?.nodes ?? [];

            const products = nodes.filter((n: any) => n && n.__typename === "Product") || nodes;

            return products;
        } catch (error) {
            // You might want to log the error; for now just return empty
            return [];
        }
    }


    private mapRemoteProductToDto(remote: any): MappedProductDto {
        // Map variants from Shopify to EasyOrder variant DTO
        const variants = (remote.variants?.nodes || []).map((v: any) => ({
            price: Number(v.price) || 0,
            // Use Shopify unit cost as expense
            expense: v.inventoryItem?.unitCost?.amount
                ? Number(v.inventoryItem.unitCost.amount)
                : 0,
            quantity: Number(v.inventoryQuantity) || 0,
            sku: String(v.sku || ""),
            variation_props: (v.selectedOptions || []).map((o: any) => ({
                variation: o.name?.trim(),
                variation_prop: String(o.value)?.trim(),
            })),
        }));

        // Build variation map: option name -> unique values
        const variationMap = new Map<string, Set<string>>();
        (remote.variants?.nodes || []).forEach((v: any) => {
            (v.selectedOptions || []).forEach((o: any) => {
                if (!variationMap.has(o.name)) {
                    variationMap.set(o.name, new Set());
                }
                variationMap.get(o.name)!.add(String(o.value));
            });
        });

        const variations = Array.from(variationMap.entries()).map(
            ([name, values]) => ({
                id: name,
                name: name?.trim(),
                props: Array.from(values).map((val) => ({
                    id: val,
                    name: val?.trim(),
                    value: val?.trim(),
                })),
            }),
        );

        // Derive product-level fields from first variant where needed
        const firstVariant = remote.variants?.nodes?.[0];

        const productPrice =
            firstVariant && firstVariant.price ? Number(firstVariant.price) : 0;

        const productExpense =
            firstVariant?.inventoryItem?.unitCost?.amount
                ? Number(firstVariant.inventoryItem.unitCost.amount)
                : 0;

        const totalQuantity = (remote.variants?.nodes || []).reduce(
            (acc: number, v: any) => acc + (Number(v.inventoryQuantity) || 0),
            0,
        );

        return {
            name: remote.title?.trim(),
            price: productPrice,
            expense: productExpense,
            description: remote.descriptionHtml || "",
            slug: remote.handle,
            sku: firstVariant?.sku || "",
            thumb: remote.images?.nodes?.[0]?.url || "",
            images: (remote.images?.nodes || []).map((img: any) => img.url),
            categories: (remote.collections?.nodes || []).map((c: any) => ({
                id: String(c.id),
                name: c.title,
            })),
            quantity: totalQuantity,
            variations,
            variants,
        };
    }

    async validateProviderConnection(store: StoreEntity): Promise<boolean> {
        const { storeUrl, credentials } = store;
        const accessToken = await this.getAccessToken(store);
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
                        'X-Shopify-Access-Token': accessToken,
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
            const message = this.getErrorMessage(error);
            this.logger.error(`[Shopify] Connection check failed: ${message}`);
            // 401 Unauthorized or 404 Not Found (Invalid URL) returns false
            return false;
        }
    }
}
