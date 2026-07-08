/**
 * Fetch a Shopify product by slug (handle) with all details needed for local sync
 */

import { forwardRef, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { BaseStoreProvider, WebhookOrderPayload, WebhookOrderUpdatePayload, UnifiedProductDto, UnifiedProductVariantDto, IBundleSyncProvider, MappedProductDto, ShopifyAction } from "./BaseStoreProvider";
import { InjectRepository } from "@nestjs/typeorm";
import { CategoryEntity } from "entities/categories.entity";
import { BundleEntity } from "entities/bundle.entity";
import { StoreEntity, StoreProvider, SyncStatus } from "entities/stores.entity";
import { ProductSyncAction, ProductSyncStateEntity, ProductSyncStatus, SyncEntityType } from "entities/product_sync_error.entity";
import { ProductEntity, ProductType, ProductVariantEntity } from "entities/sku.entity";
import { StoresService } from "../stores.service";
import { OrdersService } from "src/orders/services/orders.service";
import { ProductsService } from "src/products/products.service";
import { CategoriesService } from "src/category/category.service";
import { RedisService } from "common/redis/RedisService";
import { EncryptionService } from "common/encryption.service";
import { In, MoreThan, Repository } from "typeorm";
import { OrderEntity, OrderStatus, PaymentMethod, PaymentStatus, ReturnRequestEntity, ReturnRequestItemEntity } from "entities/order.entity";
import * as crypto from 'crypto';
import { ApolloClient, InMemoryCache, HttpLink, gql, ObservableQuery } from '@apollo/client/core';
import fetch from 'cross-fetch';
import { AppGateway } from "common/app.gateway";
import { ProductSyncStateService } from "src/product-sync-state/product-sync-state.service";
import { NotificationService } from "src/notifications/notification.service";
import { ProductSyncQueueService } from "src/queue/queues/product-sync.queue";

enum ShopifyTopic {
    ORDERS_CREATE = "orders/create",
    ORDERS_UPDATED = "orders/updated",
    ORDERS_CANCELLED = "orders/cancelled",
    ORDERS_PAID = "orders/paid",
    ORDERS_DELETE = "orders/delete",
    ORDERS_RISK_ASSESSMENT_CHANGED = "orders/risk_assessment_changed",

    // ORDERS_FULFILLED = "orders/fulfilled",

    // REFUNDS_CREATE = "refunds/create",

    // RETURNS_REQUEST = "returns/request",
    // RETURNS_APPROVE = "returns/approve",
    // RETURNS_PROCESS = "returns/process",
    // RETURNS_CLOSE = "returns/close",
    // RETURNS_REOPEN = "returns/reopen",
    // RETURNS_UPDATE = "returns/update",
    // RETURNS_CANCEL = "returns/cancel",

    // FULFILLMENT_ORDERS_PLACED_ON_HOLD = "fulfillment_orders/placed_on_hold",
    // FULFILLMENT_ORDERS_HOLD_RELEASED = "fulfillment_orders/hold_released",
    // FULFILLMENT_ORDERS_RESCHEDULED = "fulfillment_orders/rescheduled",
    // FULFILLMENT_ORDERS_PROGRESS_REPORTED = "fulfillment_orders/progress_reported",
    // FULFILLMENT_ORDERS_SPLIT = "fulfillment_orders/split",
    // FULFILLMENT_ORDERS_MERGED = "fulfillment_orders/merged",
    // FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE = "fulfillment_orders/order_routing_complete",

    // FULFILLMENTS_CREATE = "fulfillments/create",
    // FULFILLMENTS_UPDATE = "fulfillments/update",
}

const ShopifyTopicToGraphQL: Record<ShopifyTopic, string> = {
    [ShopifyTopic.ORDERS_CREATE]: "ORDERS_CREATE",
    [ShopifyTopic.ORDERS_UPDATED]: "ORDERS_UPDATED",
    [ShopifyTopic.ORDERS_CANCELLED]: "ORDERS_CANCELLED",
    [ShopifyTopic.ORDERS_PAID]: "ORDERS_PAID",
    [ShopifyTopic.ORDERS_DELETE]: "ORDERS_DELETE",
    [ShopifyTopic.ORDERS_RISK_ASSESSMENT_CHANGED]: "ORDERS_RISK_ASSESSMENT_CHANGED",
    
    // [ShopifyTopic.ORDERS_FULFILLED]: "ORDERS_FULFILLED",
    // [ShopifyTopic.REFUNDS_CREATE]: "REFUNDS_CREATE",

    // [ShopifyTopic.RETURNS_REQUEST]: "RETURNS_REQUEST",
    // [ShopifyTopic.RETURNS_APPROVE]: "RETURNS_APPROVE",
    // [ShopifyTopic.RETURNS_PROCESS]: "RETURNS_PROCESS",
    // [ShopifyTopic.RETURNS_CLOSE]: "RETURNS_CLOSE",
    // [ShopifyTopic.RETURNS_REOPEN]: "RETURNS_REOPEN",
    // [ShopifyTopic.RETURNS_UPDATE]: "RETURNS_UPDATE",
    // [ShopifyTopic.RETURNS_CANCEL]: "RETURNS_CANCEL",

    // [ShopifyTopic.FULFILLMENT_ORDERS_PLACED_ON_HOLD]: "FULFILLMENT_ORDERS_PLACED_ON_HOLD",
    // [ShopifyTopic.FULFILLMENT_ORDERS_HOLD_RELEASED]: "FULFILLMENT_ORDERS_HOLD_RELEASED",
    // [ShopifyTopic.FULFILLMENT_ORDERS_RESCHEDULED]: "FULFILLMENT_ORDERS_RESCHEDULED",
    // [ShopifyTopic.FULFILLMENT_ORDERS_PROGRESS_REPORTED]: "FULFILLMENT_ORDERS_PROGRESS_REPORTED",
    // [ShopifyTopic.FULFILLMENT_ORDERS_SPLIT]: "FULFILLMENT_ORDERS_SPLIT",
    // [ShopifyTopic.FULFILLMENT_ORDERS_MERGED]: "FULFILLMENT_ORDERS_MERGED",
    // [ShopifyTopic.FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE]: "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE",

    // [ShopifyTopic.FULFILLMENTS_CREATE]: "FULFILLMENTS_CREATE",
    // [ShopifyTopic.FULFILLMENTS_UPDATE]: "FULFILLMENTS_UPDATE",
};


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
        @InjectRepository(BundleEntity) private readonly bundleRepo: Repository<BundleEntity>,
        @InjectRepository(ReturnRequestEntity) private readonly returnRequestRepo: Repository<ReturnRequestEntity>,
        @Inject(forwardRef(() => StoresService))
        protected readonly mainStoresService: StoresService,
        @Inject(forwardRef(() => OrdersService))
        protected readonly ordersService: OrdersService,
        @Inject(forwardRef(() => ProductsService)) private readonly productsService: ProductsService,
        @InjectRepository(ProductSyncStateEntity) protected readonly productSyncStateRepo: Repository<ProductSyncStateEntity>,
        private readonly productSyncStateService: ProductSyncStateService,
        protected readonly redisService: RedisService,
        protected readonly encryptionService: EncryptionService,
        private readonly appGateway: AppGateway,
        protected readonly notificationService: NotificationService,
        @Inject(forwardRef(() => ProductSyncQueueService))
        protected readonly productSyncQueueService: ProductSyncQueueService,
    ) {
        super(storesRepo, categoryRepo, productSyncStateRepo, encryptionService, mainStoresService, notificationService, 400, StoreProvider.SHOPIFY)

    }


    private async getStoreForSync(adminId: string, isActive: boolean = true): Promise<StoreEntity | null> {
        const cleanAdminId = adminId?.trim();
        if (!cleanAdminId) return null;

        const store = await this.storesRepo.findOne({
            where: {
                adminId: cleanAdminId,
                provider: StoreProvider.SHOPIFY,
                isActive: isActive
            },
        });

        return store;

    }

    private async getStoreByExternalStoreId(externalStoreId: string): Promise<StoreEntity | null> {
        const cleanExternalStoreId = externalStoreId?.trim();
        if (!cleanExternalStoreId) return null;

        const store = await this.storesRepo.findOne({
            where: {
                externalStoreId: cleanExternalStoreId,
                provider: StoreProvider.SHOPIFY,
            },
        });

        return store;
    }

    private async getOrderIdFromFulfillmentOrderId(fulfillmentOrderId: string, store: StoreEntity): Promise<string | null> {
        const query = `
    query GetFulfillmentOrder($fulfillmentOrderId: ID!) {
      fulfillmentOrder(id: $fulfillmentOrderId) {
        id
        orderId
      }
    }
  `;

        const resp = await this.runGraphQL(store, false, query, { fulfillmentOrderId });
        return resp?.fulfillmentOrder?.orderId;
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

        const store = await this.storesRepo.findOne({
            where: {
                adminId: adminId,
                provider: StoreProvider.SHOPIFY,
            },
        });

        if (!store) {
            return {
                url: `${frontendBaseUrl}/store-integration?error=shopify_store_not_found&shop=${encodeURIComponent(shop)}`
            };
        }

        const keys = store.credentials;

        // 2. تجميع الرسالة للتحقق من HMAC
        const message = Object.keys(params)
            .sort()
            .map((key) => `${key}=${params[key]}`)
            .join('&');

        // 3. Compute HMAC using your client secret and SHA256
        const generatedHmac = crypto
            .createHmac('sha256', keys.clientSecret)
            .update(message)
            .digest('hex');

        const isValid = hmac === generatedHmac;

        if (!isValid) {
            return { url: `${frontendBaseUrl}/store-integration?error=shopify_security_verification_failed` };
        }

        try {

        const oldIsIntegrated = store.isIntegrated;
        if (!oldIsIntegrated) {
            await this.subscribeAllWebhooks(store);
        }

        store.isActive = true;
        store.isIntegrated = true;
        store.externalStoreId = rawShop;

        await this.storesRepo.save(store);
        const redirectUrl = `${frontendBaseUrl}/store-integration`;
        if (!oldIsIntegrated && store.syncRemoteProducts) {
            this.productSyncQueueService.enqueueFullProductSyncLocally(adminId, store.provider)
        }
        return { url: redirectUrl };
        } catch (error) {
            this.logger.error(`[Shopify] Error in Init: ${error.message}`, store);
            const errorMessage = this.getErrorMessage(error);
            return { url: `${frontendBaseUrl}/store-integration?errorMessage=${encodeURIComponent(errorMessage)}` };
        }
    }


    private getCashekey(store) {
        const apiKey = store?.credentials?.apiKey;
        const halfLength = apiKey ? Math.floor(apiKey.length / 2) : 0;
        const keyPart = apiKey?.slice(0, halfLength) || 'na';
        const cacheKey = `stores:${store.storeUrl}:${keyPart}:token`;
        return cacheKey;
    }
    private async getAccessToken(store: StoreEntity): Promise<string> {

        const cacheKey = this.getCashekey(store);
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

        return `https://${shopHost}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;
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
                        const networkErr: any = new Error(`Network ${systemCode}: ${error?.message}`);
                        networkErr.code = systemCode;
                        throw networkErr;
                    }

                    // 2. Handle GraphQL-Specific Errors (Inside the successful response but with errors array)
                    const gqlErrors = (error as any)?.graphQLErrors ? (error as any)?.graphQLErrors : (error as any)?.errors ? (error as any)?.errors : (error as any)?.bodyText ? [(error as any)?.bodyText] : [];

                    if (gqlErrors.length > 0) {
                        // Comprehensive check for throttling
                        const isThrottled = gqlErrors.some(e => {
                            const message = e?.message?.toUpperCase() || '';
                            const code = e?.extensions?.code;
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

                        const firstError = gqlErrors?.[0];

                        let errorMessage = 'Unknown GraphQL Error';

                        if (typeof firstError === 'string') {
                            try {
                                const parsed = JSON.parse(firstError);
                                errorMessage =
                                    parsed?.message ||
                                    parsed?.errors ||
                                    firstError;
                            } catch {
                                errorMessage = firstError;
                            }
                        } else {
                            errorMessage =
                                firstError?.message ||
                                firstError?.errors ||
                                JSON.stringify(firstError);
                        }

                        throw new Error(`GraphQL Error: ${JSON.stringify(errorMessage)}`);
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
    private async getCollection(
        store: StoreEntity,
        handle?: string,
        name?: string,
    ): Promise<any | null> {
        const cleanHandle = handle?.trim();
        const cleanName = name?.trim();

        if (!cleanHandle && !cleanName) return null;

        const gql = `
    query getCollections($query: String!) {
      collections(first: 5, query: $query) {
        nodes {
          id
          handle
          title
        }
      }
    }
  `;

        const tasks: Promise<any>[] = [];

        // 1. Handle query
        if (cleanHandle) {
            tasks.push(
                this.runGraphQL(store, false, gql, {
                    query: `handle:${cleanHandle}`,
                }),
            );
        } else {
            tasks.push(Promise.resolve(null));
        }

        // 2. Name query
        if (cleanName) {
            tasks.push(
                this.runGraphQL(store, false, gql, {
                    query: `title:"${cleanName}"`,
                }),
            );
        } else {
            tasks.push(Promise.resolve(null));
        }

        const [handleRes, nameRes] = await Promise.allSettled(tasks);

        const handleNodes =
            handleRes.status === 'fulfilled'
                ? handleRes.value?.collections?.nodes ??
                handleRes.value?.data?.collections?.nodes ??
                []
                : [];

        const nameNodes =
            nameRes.status === 'fulfilled'
                ? nameRes.value?.collections?.nodes ??
                nameRes.value?.data?.collections?.nodes ??
                []
                : [];

        const allNodes = [...handleNodes, ...nameNodes];

        if (allNodes.length === 0) return null;

        // 🔒 strict validation (avoid fuzzy wrong match)
        const collection = allNodes.find((c: any) => {
            if (cleanHandle && c.handle === cleanHandle) return true;
            if (
                cleanName &&
                c.title?.trim().toLowerCase() === cleanName.toLowerCase()
            ) {
                return true;
            }
            return false;
        });

        return collection ?? null;
    }

    private async getCollections(
        store: StoreEntity,
        handles: string[],
        names
    ): Promise<any[]> {
        const cleanHandles = handles
            .map((h) => h?.trim())
            .filter((h): h is string => !!h);

        const cleanNames = (names ?? [])
            .map((n) => n?.trim())
            .filter((n): n is string => !!n);

        // If we have neither handles nor names, return early
        if (cleanHandles.length === 0 && cleanNames.length === 0) {
            return [];
        }
        const queryParts: string[] = [];

        // Build handle parts: handle:one OR handle:two ...
        if (cleanHandles.length > 0) {
            queryParts.push(
                ...cleanHandles.map((handle) => `handle:${handle}`)
            );
        }

        // Build title parts: title:"Some Name" OR title:"Another Name" ...
        // We wrap in quotes to safely support spaces and special characters.
        if (cleanNames.length > 0) {
            queryParts.push(
                ...cleanNames.map((name) => `title:"${name}"`)
            );
        }

        // Combine into a single query: (handle:... OR title:"...")
        const searchQuery =
            queryParts.length === 1
                ? queryParts[0]
                : `(${queryParts.join(" OR ")})`;

        const gql = `
            query getCollectionsByHandlesAndNames($query: String!, $first: Int!) {
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

    private async ensureWebhookForTopic(
        store: StoreEntity,
        topic: ShopifyTopic,
        uri: string
    ) {
        const graphQLTopic = ShopifyTopicToGraphQL[topic];

        const query = `
                query WebhookSubscriptionsByTopic($topic: WebhookSubscriptionTopic!) {
                  webhookSubscriptions(first: 10, topics: [$topic]) {
                    edges {
                      node {
                        id
                        topic
                        format
                        uri
                      }
                    }
                  }
                }
        `;

        const variables = { topic: graphQLTopic };

        const response = await this.runGraphQL(store, false, query, variables);

        const edges = response?.webhookSubscriptions?.edges ?? [];
        const existing = edges
            .map((e: any) => e.node)
            .find((node: any) => node.uri === uri);

        return existing || null;
    }

    private async subscribeWebhook(
        store: StoreEntity,
        topic: ShopifyTopic,        // WebhookSubscriptionTopic string value, e.g. "ORDERS_UPDATED"
        uri: string           // Your webhook HTTPS endpoint
    ) {
        const graphQLTopic = ShopifyTopicToGraphQL[topic];
        const existing = await this.ensureWebhookForTopic(store, topic, uri);
        if (existing) {
            // Optionally: update format or fields here with webhookSubscriptionUpdate
            return existing;
        }

        // 1. Update the query to accept WebhookSubscriptionInput matching Shopify's target standard
        const query = `
        mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
            webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
                webhookSubscription {
                    id
                    topic
                    format
                    uri
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;

        // 2. Wrap the 'uri' inside the 'webhookSubscription' object 
        //    and define the format as a string matching the GraphQL enum.
        const variables = {
            topic: graphQLTopic,
            webhookSubscription: {
                uri: uri,
                format: "JSON" // Shopify defaults to JSON, but explicitly declaring it here replaces your inline format
            }
        };

        // 3. Run the custom GraphQL execution
        const response = await this.runGraphQL(store, true, query, variables);

        // 4. Handle response and errors
        const userErrors = response?.webhookSubscriptionCreate?.userErrors;
        if (userErrors && userErrors.length > 0) {
            throw new Error(`Shopify webhook error: ${userErrors[0].message}`);
        }

        const webhook = response?.webhookSubscriptionCreate?.webhookSubscription;
        return webhook;
    }

    private async unsubscribeWebhook(
        store: StoreEntity,
        topic: ShopifyTopic, // WebhookSubscriptionTopic string value, e.g. "ORDERS_UPDATED"
        uri: string    // Your webhook HTTPS endpoint
    ) {
        // Reuse your existing logic to locate the webhook
        const existing = await this.ensureWebhookForTopic(store, topic, uri);

        // If nothing is registered, nothing to do
        if (!existing?.id) {
            return null;
        }

        const query = `
    mutation webhookSubscriptionDelete($id: ID!) {
      webhookSubscriptionDelete(id: $id) {
        userErrors {
          field
          message
        }
        deletedWebhookSubscriptionId
      }
    }
  `;

        const variables = { id: existing.id };

        const response = await this.runGraphQL(store, true, query, variables);

        const userErrors = response?.webhookSubscriptionDelete?.userErrors;
        if (userErrors && userErrors.length > 0) {
            throw new Error(
                `Shopify webhook delete error: ${userErrors[0].message}`
            );
        }

        return response?.webhookSubscriptionDelete?.deletedWebhookSubscriptionId;
    }
//
    public async subscribeAllWebhooks(store: StoreEntity) {
        const createUrl = `${process.env.BACKEND_URL}/stores/webhooks/${store.adminId}/shopify/orders/create`;
        const topics: { topic: ShopifyTopic, url?: string }[] = [
            { topic: ShopifyTopic.ORDERS_CREATE, url: createUrl }, 
            { topic: ShopifyTopic.ORDERS_CANCELLED }, { topic: ShopifyTopic.ORDERS_DELETE }, 
            { topic: ShopifyTopic.ORDERS_UPDATED }, { topic: ShopifyTopic.ORDERS_PAID },  { topic: ShopifyTopic.ORDERS_RISK_ASSESSMENT_CHANGED }
            // { topic: ShopifyTopic.FULFILLMENT_ORDERS_PLACED_ON_HOLD }, { topic: ShopifyTopic.FULFILLMENT_ORDERS_HOLD_RELEASED },
            // { topic: ShopifyTopic.FULFILLMENT_ORDERS_RESCHEDULED }, { topic: ShopifyTopic.FULFILLMENT_ORDERS_PROGRESS_REPORTED }, { topic: ShopifyTopic.FULFILLMENT_ORDERS_SPLIT }, { topic: ShopifyTopic.FULFILLMENT_ORDERS_MERGED },
            // { topic: ShopifyTopic.FULFILLMENTS_CREATE }, { topic: ShopifyTopic.FULFILLMENTS_UPDATE }, { topic: ShopifyTopic.ORDERS_FULFILLED },  { topic: ShopifyTopic.FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE },
            //  { topic: ShopifyTopic.RETURNS_REQUEST }, { topic: ShopifyTopic.REFUNDS_CREATE }, { topic: ShopifyTopic.RETURNS_APPROVE }, { topic: ShopifyTopic.RETURNS_PROCESS },
            // { topic: ShopifyTopic.RETURNS_CLOSE }, { topic: ShopifyTopic.RETURNS_REOPEN }, { topic: ShopifyTopic.RETURNS_UPDATE }, { topic: ShopifyTopic.RETURNS_CANCEL }, 
        ];

        const statusUrl = `${process.env.BACKEND_URL}/stores/webhooks/${store.adminId}/shopify/orders/status`;

        // Process in chunks of 5 to avoid triggering Shopify's 429 rate limits
        const chunkSize = 5;

        for (let i = 0; i < topics.length; i += chunkSize) {
            const chunk = topics.slice(i, i + chunkSize);

            // Execute the current chunk in parallel
            await Promise.all(
                chunk.map(({ topic, url }) => this.subscribeWebhook(store, topic, url || statusUrl))
            );
        }
    }

    public async unsubscribeAllWebhooks(store: StoreEntity) {
        const createUrl = `${process.env.BACKEND_URL}/stores/webhooks/${store.adminId}/shopify/orders/create`;
        const topics: { topic: ShopifyTopic, url?: string }[] = [
            { topic: ShopifyTopic.ORDERS_CREATE, url: createUrl }, 
            { topic: ShopifyTopic.ORDERS_CANCELLED }, { topic: ShopifyTopic.ORDERS_DELETE }, 
            { topic: ShopifyTopic.ORDERS_UPDATED }, { topic: ShopifyTopic.ORDERS_PAID },  { topic: ShopifyTopic.ORDERS_RISK_ASSESSMENT_CHANGED }
        ];

        const statusUrl = `${process.env.BACKEND_URL}/stores/webhooks/${store.adminId}/shopify/orders/status`;

        const chunkSize = 5;

        for (let i = 0; i < topics.length; i += chunkSize) {
            const chunk = topics.slice(i, i + chunkSize);

            await Promise.all(
                chunk.map(({ topic, url }) =>
                    this.unsubscribeWebhook(store, topic, url || statusUrl)
                )
            );
        }
    }

    public mapWebhookUpdate(body: any, localOrderStatus: OrderStatus, headers: Record<string, any>): WebhookOrderUpdatePayload | null {
        const topic = headers['x-shopify-topic'];
        if (!topic) return null;

        let mappedStatus: OrderStatus | null = null;
        let mappedPaymentStatus: PaymentStatus | null = null;
        let note: string | null = null;
        let postponedDate: string | null = null;
        switch (topic) {
            // case ShopifyTopic.FULFILLMENT_ORDERS_PLACED_ON_HOLD:
            //     mappedStatus = OrderStatus.POSTPONED;
            //     note = body?.created_fulfillment_hold?.reason || "";
            //     break;

            // case ShopifyTopic.FULFILLMENT_ORDERS_HOLD_RELEASED:
            //     if (localOrderStatus !== OrderStatus.POSTPONED) {
            //         return null;
            //     }
            //     mappedStatus = OrderStatus.CONFIRMED;
            //     break;
            // case ShopifyTopic.FULFILLMENT_ORDERS_PROGRESS_REPORTED:
            //     mappedStatus = OrderStatus.PREPARING;
            //     note = body?.progress_report?.reason_notes || null;
            //     break;
            // case ShopifyTopic.FULFILLMENT_ORDERS_RESCHEDULED:

            //     mappedStatus = OrderStatus.POSTPONED;
            //     mappedPaymentStatus = null;
            //     postponedDate = body?.fulfillment_order?.fulfill_at ?? null;
            //     break;
            // case ShopifyTopic.FULFILLMENTS_CREATE:
            // case ShopifyTopic.FULFILLMENTS_UPDATE:
            //     switch (body.status) {
            //         case "SUCCESS":
            //             mappedStatus = OrderStatus.SHIPPED;
            //             break;

            //         case "OPEN": // deprecated
            //             mappedStatus = OrderStatus.PREPARING;
            //             break;

            //         case "PENDING": // deprecated
            //             mappedStatus = OrderStatus.CONFIRMED;
            //             break;

            //         case "ERROR":
            //         case "CANCELLED":
            //         case "FAILURE":
            //         default:
            //             return null;
            //     }
            //     break;
            // case ShopifyTopic.ORDERS_FULFILLED:
            //     mappedStatus = OrderStatus.SHIPPED;
            //     note = "Order fully fulfilled";
            //     break;
            case ShopifyTopic.ORDERS_CANCELLED:
            case ShopifyTopic.ORDERS_DELETE:
                mappedStatus = OrderStatus.CANCELLED;
                note = "Order cancelled";
                break;
            case ShopifyTopic.ORDERS_UPDATED:
                const { orderStatus, paymentStatus } = this.mapShopifyWebhookStatusToInternal(body);
                if (orderStatus) {
                    mappedStatus = orderStatus;
                }
                if (paymentStatus) {
                    mappedPaymentStatus = paymentStatus;
                }
                break;
            case ShopifyTopic.ORDERS_PAID:
                mappedStatus = null;
                mappedPaymentStatus = PaymentStatus.PAID;
                note = "Order paid";
                break;
            // case ShopifyTopic.REFUNDS_CREATE:
            //     mappedPaymentStatus = PaymentStatus.REFUNDED; // or PARTIAL_REFUND if you support it
            //     break;
            // case ShopifyTopic.RETURNS_APPROVE:
            // case ShopifyTopic.RETURNS_PROCESS:
            // case ShopifyTopic.RETURNS_REOPEN:
            //     mappedStatus = OrderStatus.RETURN_PREPARING;
            //     note = "Order return preparing";
            //     break;
            // case ShopifyTopic.RETURNS_CLOSE:
            //     mappedStatus = OrderStatus.RETURNED;
            //     note = "Order returned";
            //     break;
            case ShopifyTopic.ORDERS_RISK_ASSESSMENT_CHANGED:
                mappedStatus = OrderStatus.UNDER_REVIEW;
                break;
            default:
                return null;
        }

        if(mappedStatus === OrderStatus.CANCELLED && [OrderStatus.CANCELLED,OrderStatus.REJECTED,OrderStatus.FAILED_DELIVERY,OrderStatus.OUT_OF_DELIVERY_AREA].includes(localOrderStatus)) {
            mappedStatus = null;
        }
        return {
            mappedStatus,
            mappedPaymentStatus,
            note,
            postponedDate
        };
    }


    public async appUninstall(store: StoreEntity): Promise<void> {
        const mutation = `
    mutation appUninstall {
      appUninstall {
        app {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

        try {
            const response = await this.runGraphQL(store, true, mutation, {});

            const userErrors = response?.appUninstall?.userErrors;
            if (userErrors && userErrors.length > 0) {
                this.logger.error(`[Shopify] appUninstall failed: ${JSON.stringify(userErrors)}`);
            }

            // Mark store as inactive/uninstalled locally
            store.isActive = false;
            store.isIntegrated = false;
            await this.storesRepo.save(store);
        } catch (error) {
            const message = this.getErrorMessage(error);
            this.logger.error(`[Shopify] appUninstall failed: ${message}`);

            // Still try to mark store as inactive locally even if Shopify mutation fails
            try {
                store.isActive = false;
                store.isIntegrated = false;
                await this.storesRepo.save(store);
            } catch (saveErr) {
                const saveErrMsg = this.getErrorMessage(saveErr);
                this.logger.error(`[Shopify] Failed to mark store as inactive after appUninstall: ${saveErrMsg}`);
            }
        }
    }

    public async cancelIntegration(adminId: string): Promise<boolean> {
        const store = await this.storesRepo.findOne({
            where: {
                adminId,
                provider: StoreProvider.SHOPIFY,
            }
        });

        // 1. Basic Validation
        if (!store) {
            return false;
        }

        try {
            // 2. Unsubscribe all webhooks
            await this.unsubscribeAllWebhooks(store);
            // 3. Uninstall app from Shopify
            await this.appUninstall(store);
            //remove access token
            const cacheKey = this.getCashekey(store);
            await this.redisService.del(cacheKey);

            return true;
        } catch (error: any) {
            const message = this.getErrorMessage(error);
            this.logger.error(`Failed to cancel Shopify integration: ${message}`);
            return false;
        }
    }

    private mapShopifyWebhookStatusToInternal(body: any): {
        orderStatus: OrderStatus | null;
        paymentStatus: PaymentStatus | null;
    } {
        const financialStatus = body.financial_status as string | null;
        const fulfillmentStatus = body.displayFulfillmentStatus as string | null;

        const paymentStatus = this.mapShopifyFinancialStatusToPaymentStatus(
            financialStatus,
        );
        const orderStatus = this.mapShopifyStatusesToOrderStatus(
            fulfillmentStatus,
        );

        return { orderStatus, paymentStatus };
    }
    private mapShopifyStatusesToOrderStatus(
        displayFulfillmentStatus: string | null | undefined
    ): OrderStatus | null {

        const status = displayFulfillmentStatus?.toUpperCase();
        if (!status) return null;

        switch (status) {

            // case "UNFULFILLED":
            // case "OPEN":
            //     return OrderStatus.CONFIRMED;

            case "SCHEDULED":
                return OrderStatus.POSTPONED;

            case "ON_HOLD":
                return OrderStatus.POSTPONED;

            // case "PENDING_FULFILLMENT":
            // case "IN_PROGRESS":
            //     return OrderStatus.PREPARING;

            // case "FULFILLED":
            //     return OrderStatus.SHIPPED;

            // case "RESTOCKED":
            //     return OrderStatus.RETURNED;

            default:
                return null;
        }
    }

    private mapShopifyFinancialStatusToPaymentStatus(
        financialStatus?: string | null,
    ): PaymentStatus | null {
        if (!financialStatus) return null;
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
                return null;
        }
    }

    /**
     * Updates an existing Collection
     */
    private async updateCollection(store: StoreEntity, shopifyId: string, category: CategoryEntity) {
        if (!shopifyId) {
            throw new Error(`No external ID provided for category ${category.name}`)
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
    public async getProductBySlug(store: StoreEntity, slug: string, retry: boolean = true) {
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


        const response = await this.runGraphQL(store, false, query, { handle: cleanSlug }, 0, retry);
        const product = response?.productByHandle || null;

        return product;

    }

    private async buildProductSetInput(
        product: ProductEntity,
        variants: ProductVariantEntity[],
        locationId: string,
        store: StoreEntity,
        remoteProduct: any
    ) {
        const hasOnlyDefaultVariant = product.type === ProductType.SINGLE;
        const remoteVariants = remoteProduct?.variants?.nodes || [];
        const bundleParentSkus = new Set<string>();
        if (remoteVariants?.length > 0) {
            for (const remote of remoteVariants) {
                if (remote.requiresComponents) {
                    if (remote.sku) {
                        bundleParentSkus.add(remote.sku);
                    }
                }
            }
        }
        const optionsMap = new Map<string, Set<string>>();
        const activeVariants = variants.filter(v => v.isActive);

        let productOptions: any[] = [];
        if (hasOnlyDefaultVariant) {
            // Handle single product mode
            productOptions = [
                {
                    name: "Title",
                    values: [{ name: "Default Title" }]
                }
            ];
        } else {
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

            productOptions = Array.from(optionsMap.entries()).map(([name, values]) => ({
                name,
                values: Array.from(values).map((v) => ({ name: v })),
            }));
        }

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

        let variantsInput: any[] = [];
        if (hasOnlyDefaultVariant) {
            // Handle single product variant
            if (activeVariants.length > 0) {
                const v = activeVariants[0];
                const base: any = {
                    price: (v.price || product.salePrice || 0).toString(),
                    inventoryPolicy: "DENY",
                    optionValues: [{ optionName: "Title", name: "Default Title" }],
                };

                const isBundleParent = !!v.sku && bundleParentSkus.has(v.sku.trim());
                if (!isBundleParent) {
                    base.inventoryItem = {
                        tracked: true,
                        sku: v.sku,
                        cost: v.unitCost || 0
                    };

                    base.inventoryQuantities = v.stockOnHand
                        ? [
                            {
                                quantity: v.stockOnHand,
                                locationId,
                                name: "available",
                            },
                        ]
                        : undefined;
                }

                variantsInput.push(base);
            }
        } else {
            variantsInput = activeVariants.map((v) => {
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
                const base: any = {
                    price: (v.price || product.salePrice || 0).toString(),
                    optionValues,
                };

                const isBundleParent = !!v.sku && bundleParentSkus.has(v.sku.trim());

                if (!isBundleParent) {
                    base.inventoryItem = {
                        tracked: true,
                        sku: v.sku,
                        cost: v.unitCost || 0
                    };

                    base.inventoryQuantities = v.stockOnHand
                        ? [
                            {
                                quantity: v.stockOnHand,
                                locationId,
                                name: "available",
                            },
                        ]
                        : undefined;
                }

                return base;
            });
        }

        // const upsellMetafield = await this.getShopifyUpsellMetafield(product, store);
        const upsellMetafield = null;

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

            let remoteProduct = await this.syncProduct({ productId: localProduct.id });

            if (remoteProduct) {
                upsellGids.push(remoteProduct.id);
            }
        }

        if (upsellGids.length === 0) return null;

        return {
            namespace: "upsellings-products",
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
            shipsInventory
          }
        }
      }
    }
  `;

        const resp = await this.runGraphQL(store, false, query, {});
        const id = resp?.locations?.edges?.find((edge) => edge.node?.shipsInventory)?.node?.id || resp?.locations?.edges?.[0]?.node?.id;

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
        remoteProduct?: any,
    ): Promise<any> {
        const mode = remoteProduct?.id ? "update" : "create";
        const identifier =
            remoteProduct?.id
                ? { id: remoteProduct?.id } // update existing product
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
                 product {
                    id
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
            remoteProduct
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

            const names = localBatch.map(c => c.name).join(',');

            // Bulk fetch collections by handle from Shopify
            const remoteCollections = await this.getCollections(store, handles, names);

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
        productIds?: string[]
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
            if (productIds.length === 0) {
                qb.where("product.storeId = :storeId", { storeId: store.id })
            }
            qb.andWhere("product.adminId = :adminId", { adminId: store.adminId })
                .andWhere("product.isActive = :isActive", { isActive: true })
                .orderBy("product.id", "ASC")
                .take(20);

            if (productIds && productIds.length > 0) {
                qb.andWhere("product.id IN (:...productIds)", { productIds });
            }

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
                            remote,
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

                    await this.sendSyncSuccessNotification({
                        adminId: product.adminId,
                        entityId: product.id,
                        entityName: product.name,
                        storeName: store.name,
                        isProduct: true,
                        action: remote ? "UPDATE" : "CREATE"
                    });

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
        const checkName = category.name?.trim();

        // 1. Check if collection exists by handle
        const existingCollection = await this.getCollection(store, checkHandle, checkName);

        if (existingCollection) {
            return await this.updateCollection(store, existingCollection.id, category);
        } else {
            return await this.createCollection(store, category);
        }
    }
    private async getBundleVariantWithComponents(
        store: StoreEntity,
        variantId: string,
    ): Promise<{ productVariantComponents: { nodes: any[] } } | null> {
        const query = `
    query BundleVariantComponents($id: ID!) {
      productVariant(id: $id) {
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
  `;

        const resp = await this.runGraphQL(store, false, query, { id: variantId });
        const node = resp?.productVariant ?? resp?.data?.productVariant ?? null;
        return node;
    }
    private async findRemoteVariantByProductGidAndSku(
        store: StoreEntity,
        productGid: string,
        sku: string,
    ) {
        // Convert product GID -> numeric ID for search query
        const productNumericId = productGid.split("/").pop();
        if (!productNumericId) {
            return undefined;
        }

        const query = `
    query BundleByProductAndVariantSku($query: String!) {
      productVariants(first: 1, query: $query) {
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

        // Search for variant under this product by sku
        const searchQuery = `product_id:${productNumericId} AND sku:${sku}`;

        const response = await this.runGraphQL(store, false, query, {
            query: searchQuery,
        });

        // Handle possible response shapes
        const root = response?.data ?? response;
        const nodes = root?.productVariants?.nodes ?? [];

        const variant = nodes[0];
        if (!variant) {
            return undefined;
        }

        // Optionally, double-check SKU matches exactly
        if (variant.sku !== sku) {
            return undefined;
        }

        return variant;
    }

    private async setVariantRequiresComponents(
        activeStore: StoreEntity,
        productId: string,
        variantId: string,
        requiresComponents: boolean = true,
    ): Promise<void> {
        const mutation = `
    mutation SetVariantRequiresComponents($productId: ID!, $variantId: ID!, $requiresComponents: Boolean!) {
      productVariantsBulkUpdate(
        productId: $productId
        variants: [
          {
            id: $variantId
            requiresComponents: $requiresComponents
          }
        ]
      ) {
        productVariants {
          id
          title
          requiresComponents
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
            productId,
            variantId,
            requiresComponents,
        };

        const result = await this.runGraphQL(
            activeStore,
            true,
            mutation,
            variables,
        );

        const userErrors =
            result?.data?.productVariantsBulkUpdate?.userErrors ?? [];

        if (userErrors.length > 0) {
            throw new Error(
                `Failed to set requiresComponents: ${JSON.stringify(userErrors)}`,
            );
        }
    }

    private async removeAllBundleComponents(
        activeStore: StoreEntity,
        parentVariantId: string,
    ) {
        const mutation = `
    mutation RemoveAllBundleComponents($input: [ProductVariantRelationshipUpdateInput!]!) {
      productVariantRelationshipBulkUpdate(input: $input) {
        parentProductVariants {
          id
          productVariantComponents(first: 30) {
            nodes {
              id
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
            input: [
                {
                    parentProductVariantId: parentVariantId,
                    removeAllProductVariantRelationships: true,
                },
            ],
        };

        const result = await this.runGraphQL(
            activeStore,
            true,
            mutation,
            variables,
        );

        const errors =
            result?.data?.productVariantRelationshipBulkUpdate?.userErrors ?? [];
        if (errors.length > 0) {
            throw new Error(
                `Failed to remove bundle components: ${JSON.stringify(errors)}`,
            );
        }
    }

    private async disableRemoteBundleVariant(
        activeStore: StoreEntity,
        adminId: string,
        productId: string,
        sku: string,
    ): Promise<void> {
        const syncStates = await this.productSyncStateRepo.find({
            where: {
                adminId,
                storeId: activeStore.id,
                externalStoreId: activeStore.externalStoreId,
                productId,
            },
            relations: ['product', 'product.variants'],
        });

        const syncState = syncStates?.[0];

        if (syncState && syncState.remoteProductId) {
            const remoteVariant = await this.findRemoteVariantByProductGidAndSku(
                activeStore,
                syncState.remoteProductId,
                sku,
            );

            if (remoteVariant && remoteVariant.id && remoteVariant.requiresComponents) {
                // 1. Delete all components
                await this.removeAllBundleComponents(activeStore, remoteVariant.id);

                // 2. Set requiresComponents to false
                await this.setVariantRequiresComponents(
                    activeStore,
                    syncState.remoteProductId,
                    remoteVariant.id,
                    false,
                );
            }
        }
    }

    async deleteBundle(mainVaraintId: string, storeId: string, adminId: string): Promise<void> {
        const oldStore = await this.storesRepo.findOne({
            where: {
                adminId: adminId,
                id: storeId,
                provider: StoreProvider.SHOPIFY,
            },
        });
        const oldVariant = await this.pvRepo.findOne({
            where: { id: mainVaraintId }
        });

        if (oldStore && oldVariant) {
            await this.disableRemoteBundleVariant(
                oldStore,
                adminId,
                oldVariant.productId,
                oldVariant.sku
            );
        }
    }


    public async syncBundle(bundle: BundleEntity) {
        // 1. Validate Store
        const activeStore = await this.getStoreForSync(bundle.adminId);
        if (!activeStore) {
            throw new Error("Store not found or inactive")
        }

        // 1. Sync products (main product variant and items product variants)
        // Sync main product variant
        const syncedProductsMap = new Map<string, any>();

        if (bundle.variant && bundle.variant.product) {
            const newProduct = await this.syncProduct({
                productId: bundle.variant.productId,
            });
            syncedProductsMap.set(String(bundle.variant.productId), newProduct);
        }


        const activeItems = bundle.items;

        // Sync item product variants
        for (const item of activeItems) {
            if (item.variant && item.variant.product) {
                const newProduct = await this.syncProduct({
                    productId: item.variant.productId,
                });
                syncedProductsMap.set(String(item.variant.productId), newProduct);
            }
        }
        try {

            //refetch bundle data
            bundle = await this.bundleRepo.createQueryBuilder('bundle')

                .leftJoinAndSelect('bundle.variant', 'variant')
                .leftJoinAndSelect('variant.product', 'product')

                .leftJoinAndSelect(
                    'bundle.items',
                    'items',
                    'items.isActive = :itemActive',
                    { itemActive: true }
                )
                .innerJoinAndSelect(
                    'items.variant',
                    'itemVariant',
                    'itemVariant.isActive = :active',
                    { active: true }
                )
                .leftJoinAndSelect('itemVariant.product', 'itemProduct')

                .where('bundle.id = :bundleId', { bundleId: bundle.id })
                .getOne();

            const mainRemoteProduct = syncedProductsMap.get(bundle.variant?.productId);

            const remoteBundleVariant = mainRemoteProduct?.variants?.nodes?.find(
                rv => String(rv?.id) === String(bundle?.variant?.externalId)
            );

            const bundleVariantNode = await this.getBundleVariantWithComponents(
                activeStore,
                remoteBundleVariant.id,
            );

            if (!bundleVariantNode) {
                throw new Error(`Could not load productVariant ${remoteBundleVariant.id} with components for bundle ${bundle.id}`);
            }

            const remoteComponents = bundleVariantNode.productVariantComponents?.nodes ?? [];

            // 3. Determine components to create, update, or remove
            const localItems = activeItems;
            const productVariantRelationshipsToCreate: Array<{
                id: string;
                quantity: number;
            }> = [];
            const productVariantRelationshipsToUpdate: Array<{
                id: string;
                quantity: number;
            }> = [];
            const productVariantRelationshipsToRemove: string[] = [];

            // Map existing remote components by SKU
            const remoteComponentsMap = new Map<string, any>();
            for (const comp of remoteComponents) {
                remoteComponentsMap.set(comp.productVariant.sku, comp);
            }

            // Compare local items vs existing remote components
            for (const localItem of localItems) {
                const sku = localItem.variant.sku;
                const remoteComp = remoteComponentsMap.get(sku);

                if (remoteComp) {
                    // Component exists remotely, check if quantity changed
                    if (remoteComp.quantity !== localItem.qty) {
                        productVariantRelationshipsToUpdate.push({
                            id: remoteComp.productVariant.id,
                            quantity: localItem.qty,
                        });
                    }
                    // Remove from map so we know what's left to delete later
                    remoteComponentsMap.delete(sku);
                } else {
                    const localProductId = localItem.variant.productId;
                    if (!localProductId) {
                        this.logger.warn(
                            `Skipping component with SKU ${sku} because local productId is missing.`,
                        );
                        continue;
                    }

                    const remoteProduct = syncedProductsMap.get(localProductId);
                    if (!remoteProduct) {
                        throw new Error(`Can't find remote product for local product ${localItem?.variant?.product?.name || localItem?.variant?.productId}`)
                    }

                    const remoteProductGid = remoteProduct?.id;
                    if (!remoteProductGid) {
                        const msg = `No remote product found in sync state for component productId ${localProductId}, SKU ${sku}`;
                        this.logger.warn(msg);
                        throw new Error(msg);
                    }

                    const remoteVariant = remoteProduct?.variants?.nodes?.find(
                        rv => String(rv?.id) === String(localItem?.variant?.externalId)
                    )
                    if (remoteVariant) {
                        productVariantRelationshipsToCreate.push({
                            id: remoteVariant.id,
                            quantity: localItem.qty,
                        });
                    } else {
                        const msg = `No remote variant found on Shopify for component SKU ${sku} under product ${remoteProductGid}`;
                        this.logger.warn(msg);
                        throw new Error(msg);
                    }
                }
            }

            // Remaining remote components are not in local bundle anymore => remove them
            for (const remoteComp of remoteComponentsMap.values()) {
                productVariantRelationshipsToRemove.push(remoteComp.productVariant.id);
            }

            // 4. Apply changes via productVariantRelationshipBulkUpdate
            if (
                productVariantRelationshipsToCreate.length > 0 ||
                productVariantRelationshipsToUpdate.length > 0 ||
                productVariantRelationshipsToRemove.length > 0
            ) {
                await this.setVariantRequiresComponents(
                    activeStore,
                    remoteBundleVariant?.product?.id, // however you store this
                    remoteBundleVariant?.id,
                );


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

                const inputItem: any = {
                    parentProductVariantId: remoteBundleVariant.id,
                };

                if (productVariantRelationshipsToCreate.length > 0) {
                    inputItem.productVariantRelationshipsToCreate =
                        productVariantRelationshipsToCreate;
                }

                if (productVariantRelationshipsToUpdate.length > 0) {
                    inputItem.productVariantRelationshipsToUpdate =
                        productVariantRelationshipsToUpdate;
                }

                if (productVariantRelationshipsToRemove.length > 0) {
                    inputItem.productVariantRelationshipsToRemove =
                        productVariantRelationshipsToRemove;
                }

                const variables = {
                    input: [inputItem],
                };

                const mutationResult = await this.runGraphQL(
                    activeStore,
                    true,
                    updateMutation,
                    variables,
                );

                // Normalize response shape: { productVariantRelationshipBulkUpdate } vs { data: { ... } }
                const bulkPayload =
                    mutationResult?.productVariantRelationshipBulkUpdate ??
                    mutationResult?.data?.productVariantRelationshipBulkUpdate ??
                    null;

                if (!bulkPayload) {
                    throw new Error(
                        `productVariantRelationshipBulkUpdate returned empty payload for bundle ${bundle.id}`,
                    );
                }

                const errors = bulkPayload.userErrors;
                if (errors && errors.length > 0) {
                    throw new Error(
                        `Shopify mutation errors: ${JSON.stringify(errors)}`,
                    );
                }

                await this.sendSyncSuccessNotification({
                    adminId: bundle.adminId,
                    entityId: bundle.id,
                    entityName: bundle.name,
                    storeName: activeStore.name,
                    isProduct: false,
                    action: "SYNC"
                });
            }
        } catch (error: any) {
            const message = this.getErrorMessage(error);
            await this.productSyncStateService.upsertSyncErrorLog(
                { adminId: activeStore.adminId, bundleId: bundle?.id, storeId: activeStore.id, entityType: SyncEntityType?.BUNDLE },
                {
                    remoteProductId: null,
                    action: ProductSyncAction?.BUNDLE_SYNC,

                    errorMessage: message,
                    userMessage: `Failed to sync bundle "${bundle.name}" to ${activeStore.name}: ${message}`,
                    responseStatus: error?.response?.status,
                    requestPayload: error?.config?.data ? JSON.parse(error.config.data) : null
                }
            );
            throw error;
        }
    }

    public async syncProduct({ productId }: { productId: string }) {
        const product = await this.productsRepo.findOne({
            where: { id: productId },
            relations: ['category']
        });

        const activeStore = await this.getStoreForSync(product.adminId);
        if (!activeStore) {
            throw new Error("Store not found or inactive")
        }
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
                    syncedProduct = await this.updateProductWithProductSet(activeStore, product, variants, remoteProduct)
                } else {
                    syncedProduct = await this.updateProductWithProductSet(activeStore, product, variants)
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
            return syncedProduct;
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

    public async syncOrderStatus(order: OrderEntity, newStatusId: string, oldStatusId?: string): Promise<{ actions: ShopifyAction[] }> {
        const store = await this.getStoreForSync(order.adminId);
        if (!store) {
            throw new Error(`No active store enabled for admin (${order.adminId})`);
        }

        return await this.updateOrderStatus(order, store, newStatusId, oldStatusId);
    }

    public async updateOrderStatus(
        order: OrderEntity,
        store: StoreEntity,
        newStatusId?: string,
        oldStatusId?: string,
    ): Promise<{ actions: ShopifyAction[] }> {
        const actions: ShopifyAction[] = [];

        if (!order.externalId)
            return { actions };

        // 1) Resolve internal status record
        const status = await this.ordersService.findStatusById(
            newStatusId,
            order.adminId,
        );

        if (!status) {
            throw new Error(`No status found for order (${order.id})`)
        }

        const oldStatus = await this.ordersService.findStatusById(
            oldStatusId,
            order.adminId,
        );

        const internalStatus = status.code as OrderStatus;
        const internalOldStatus = oldStatus.code as OrderStatus;
        const startAction = this.mapOldStatusToShopifyAction(internalStatus, internalOldStatus);
        if (startAction !== 'NONE') {
            await this.startAction(order, startAction, store);
            actions.push(startAction);
        }
        const action = this.mapStatusToShopifyAction(internalStatus);
        if (action !== 'NONE' && action !== startAction) {
            await this.startAction(order, action, store);
            actions.push(action);
        }

        return { actions };
    }

    private async startAction(
        order: OrderEntity,
        action: ShopifyAction,
        store: StoreEntity,
    ): Promise<void> {
        switch (action) {
            case "FULFILL":
                await this.createFulfillment(order, store);
                break;

            case "CANCEL":
                await this.cancelOrder(order, store);
                break;

            case "HOLD":
                await this.holdFulfillment(order, store);
                break;

            case "RELEASE_HOLD":
                await this.releaseHoldFulfillment(order, store);
                break;

            case "PROGRESS":
                await this.markFulfillmentInProgress(order, store);
                break;

            case "DELIVERED":
                await this.markOrderDelivered(order, store);
                break;

            case "RETURN_REQUEST":
                await this.createReturnRequest(order, store);
                break;

            case "RETURN_APPROVE":
                await this.approveReturnRequest(order, store);
                break;

            case "RETURN_DECLINE":
                await this.declineReturnRequest(order, store);
                break;
            case "NONE":
            default:
                // 🔥 Do nothing for states that don't map to a Shopify fulfillment/cancellation action
                return;
        }
    }



    //create fulfillSingleFO - 
    private async fulfillSingleFO(
        store: StoreEntity,
        order: OrderEntity,
        fulfillmentOrderId: string,
        trackingCompany?: string,
        trackingNumber?: string,
    ): Promise<void> {
        const mutation = `
    mutation FulfillAllRemainingItemsWithTracking(
      $fulfillmentOrderId: ID!
      $trackingCompany: String
      $trackingNumber: String
    ) {
      fulfillmentCreate(
        fulfillment: {
          notifyCustomer: true
          trackingInfo: {
            company: $trackingCompany
            number: $trackingNumber
          }
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
          trackingInfo(first: 10) {
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
            trackingCompany: trackingCompany ?? null,
            trackingNumber: trackingNumber ?? null,
        };

        const response = await this.runGraphQL(store, true, mutation, variables);

        const payload =
            response?.fulfillmentCreate ?? response?.data?.fulfillmentCreate ?? null;

        if (!payload) {
            throw new Error(
                `fulfillmentCreate returned empty payload for order ${order.id} (FO: ${fulfillmentOrderId})`,
            );
        }

        const userErrors = payload.userErrors;
        if (userErrors && userErrors.length > 0) {
            throw new Error(
                `fulfillmentCreate errors for order ${order.id} (FO: ${fulfillmentOrderId}): ${userErrors[0].message}`,
            );
        }

        this.logger.log(
            `[Shopify] Successfully fulfilled all remaining items for fulfillmentOrder ${fulfillmentOrderId} (order ${order.id}) with tracking ${trackingCompany || ''} ${trackingNumber || ''}`,
        );
    }


    private async getOrderFulfillments(
        store: StoreEntity,
        orderGid: string,
    ): Promise<any> {
        const query = `
    query GetOrderFulfillments($orderId: ID!) {
      order(id: $orderId) {
        id
        fulfillments(first: 50) {
            id
            status
        }
      }
    }
  `;

        const response = await this.runGraphQL(store, false, query, {
            orderId: orderGid,
        });

        const orderNode = response?.order ?? response?.data?.order ?? null;

        if (!orderNode) {
            throw new Error(
                `Could not fetch order ${orderGid} fulfillments`,
            );
        }

        return orderNode;
    }

    private async getOrderFulfillmentOrders(
        store: StoreEntity,
        orderGid: string,
    ): Promise<any> {
        const query = `
    query GetOrderFulfillmentOrders($orderId: ID!) {
      order(id: $orderId) {
        id
        fulfillmentOrders(first: 50) {
          edges {
            node {
              id
              status
              requestStatus
              supportedActions {
                action
              }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    remainingQuantity
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

        const response = await this.runGraphQL(store, false, query, {
            orderId: orderGid,
        });

        const orderNode = response?.order ?? response?.data?.order ?? null;

        if (!orderNode) {
            throw new Error(
                `Could not fetch order ${orderGid} fulfillment orders`,
            );
        }

        return orderNode;
    }

    private async getOrderFulfillmentData(
        store: StoreEntity,
        orderGid: string,
    ): Promise<any> {
        const query = `
    query GetOrderFulfillmentData($orderId: ID!) {
      order(id: $orderId) {
        id
        fulfillments(first: 50) {
            id
            status
        }
        fulfillmentOrders(first: 50) {
          edges {
            node {
              id
              status
              requestStatus
              supportedActions {
                action
              }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    totalQuantity
                    remainingQuantity
                    inventoryItemId
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

        const response = await this.runGraphQL(store, false, query, {
            orderId: orderGid,
        });

        const orderNode = response?.order ?? response?.data?.order ?? null;

        if (!orderNode) {
            throw new Error(
                `Could not fetch order ${orderGid} fulfillment data`,
            );
        }

        return orderNode;
    }



    private async cancelSingleFulfillment(store: StoreEntity, order: OrderEntity, fulfillmentId: string): Promise<void> {
        const mutation = `
    mutation CancelFulfillment($fulfillmentId: ID!) {
      fulfillmentCancel(id: $fulfillmentId) {
        fulfillment {
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

        const variables = { fulfillmentId };

        const response = await this.runGraphQL(store, true, mutation, variables);

        const payload = response?.fulfillmentCancel ?? response?.data?.fulfillmentCancel ?? null;
        if (!payload) {
            throw new Error(`fulfillmentCancel returned empty payload for fulfillment ${fulfillmentId}`);
        }

        const userErrors = payload.userErrors;
        if (userErrors && userErrors.length > 0) {
            throw new Error(`Failed to cancel fulfillment ${fulfillmentId} for order ${order.id}: ${userErrors[0].message}`);
        }

        this.logger.log(`[Shopify] Successfully canceled fulfillment ${fulfillmentId} for order ${order.id}`);
    }

    private async createFulfillment(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<void> {
        const orderGid = this.normalizeOrderId(order.externalId);
        let orderNode = await this.getOrderFulfillmentOrders(store, orderGid);

        const trackingNumber = order.trackingNumber;
        const trackingCompany =
            order.shippingCompany?.name || order.shippingCompany?.code;


        const getFOs = (node: any) =>
            node.fulfillmentOrders?.edges?.map((e: any) => e.node) ?? [];

        let fulfillmentOrders = getFOs(orderNode);

        if (!fulfillmentOrders.length) {
            throw new Error(
                `No fulfillment orders found for order ${order.id}`,
            );
        }

        const supportsCreateFulfillment = (fo: any): boolean => {
            const actions = fo.supportedActions ?? [];
            return actions.some(
                (a: any) => a?.action === 'CREATE_FULFILLMENT',
            );
        };

        const hasRemainingQuantity = (fo: any): boolean => {
            const lineItems =
                fo.lineItems?.edges?.map((e: any) => e.node) ?? [];
            return lineItems.some(
                (li: any) => (li?.remainingQuantity ?? 0) > 0,
            );
        };

        // 1) Separate ON_HOLD FOs from others
        const onHoldFOs: any[] = [];
        const normalFOs: any[] = [];

        for (const fo of fulfillmentOrders) {
            const status = (fo.status || '').toUpperCase();
            if (status === 'ON_HOLD') {
                onHoldFOs.push(fo);
            } else {
                normalFOs.push(fo);
            }
        }

        // 2) Release holds for ON_HOLD fulfillment orders
        for (const fo of onHoldFOs) {
            this.logger.log(
                `[Shopify] Releasing hold for fulfillment order ${fo.id} (order ${order.id}) before fulfilling`,
            );
            await this.releaseFulfillmentOrderHold(store, fo.id);
        }

        // 3) Rebuild list of FOs we can fulfill (including ones we just released)
        orderNode = await this.getOrderFulfillmentOrders(store, orderGid);
        fulfillmentOrders = getFOs(orderNode);

        const fulfillableFOs = fulfillmentOrders.filter((fo: any) => {
            const status = (fo.status || '').toUpperCase();
            const isTerminal = status === 'CANCELLED' || status === 'CLOSED';

            const canCreate = supportsCreateFulfillment(fo);
            const hasQty = hasRemainingQuantity(fo);

            return !isTerminal && canCreate && hasQty;
        });

        if (!fulfillableFOs.length) {
            throw new Error(
                `No fulfillable fulfillment orders for order ${order.id} after releasing holds`,
            );
        }

        // 4) Fulfill each FO with tracking
        for (const fo of fulfillableFOs) {
            await this.fulfillSingleFO(
                store,
                order,
                fo.id,
                trackingCompany,
                trackingNumber,
            );
        }
    }
    private async cancelOrder(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<void> {
        const orderGid = this.normalizeOrderId(order.externalId);

        // Step 1: Get all fulfillment data
        const orderNode = await this.getOrderFulfillmentData(store, orderGid);

        // Step 2: Cancel all active fulfillments first
        const fulfillments = orderNode.fulfillments ?? [];
        for (const fulfillment of fulfillments) {
            const status = (fulfillment.status || '').toUpperCase();
            if (status === "CANCELLED" || status === "FAILURE") {
                this.logger.log(`[Shopify] Skipping fulfillment ${fulfillment.id} for order ${order.id} with status ${status}`);
                continue;
            }

            await this.cancelSingleFulfillment(store, order, fulfillment.id);
        }

        // Step 3: Handle unfulfilled fulfillment orders (cancel or submit cancellation request)
        const fulfillmentOrders = orderNode.fulfillmentOrders?.edges?.map((e: any) => e.node) ?? [];
        for (const fo of fulfillmentOrders) {
            const status = (fo.status || '').toUpperCase();
            const actions = fo.supportedActions ?? [];
            const supportsCancel = actions.some(
                (a: any) => a?.action === 'CANCEL_FULFILLMENT_ORDER',
            );
            const supportsSubmitCancel = actions.some(
                (a: any) => a?.action === 'REQUEST_CANCELLATION',
            );
            // Skip if already in a terminal state
            if (status === "CANCELLED" || status === "CLOSED" || status === "FAILURE") {
                this.logger.log(`[Shopify] Skipping fulfillment order ${fo.id} for order ${order.id} with status ${status}`);
                continue;
            }

            // Try to cancel fulfillment order if supported
            if (supportsCancel) {
                const foCancelMutation = `
      mutation CancelFulfillmentOrder($fulfillmentOrderId: ID!) {
        fulfillmentOrderCancel(id: $fulfillmentOrderId) {
          fulfillmentOrder {
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

                const variables = { fulfillmentOrderId: fo.id };
                const response = await this.runGraphQL(store, true, foCancelMutation, variables);
                const payload = response?.fulfillmentOrderCancel ?? response?.data?.fulfillmentOrderCancel ?? null;

                if (payload?.userErrors?.length > 0) {
                    this.logger.warn(`[Shopify] Could not cancel fulfillment order ${fo.id} for order ${order.id}: ${payload.userErrors[0].message}`);
                } else {
                    this.logger.log(`[Shopify] Successfully canceled fulfillment order ${fo.id} for order ${order.id}`);
                }
            } else if (supportsSubmitCancel) {
                // Submit cancellation request if direct cancel not supported
                const submitCancelMutation = `
      mutation SubmitCancellationRequest($fulfillmentOrderId: ID!) {
        fulfillmentOrderSubmitCancellationRequest(id: $fulfillmentOrderId) {
          fulfillmentOrder {
            id
            requestStatus
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

                const variables = { fulfillmentOrderId: fo.id };
                const response = await this.runGraphQL(store, true, submitCancelMutation, variables);
                const payload = response?.fulfillmentOrderSubmitCancellationRequest ?? response?.data?.fulfillmentOrderSubmitCancellationRequest ?? null;

                if (payload?.userErrors?.length > 0) {
                    this.logger.warn(`[Shopify] Could not submit cancellation request for fulfillment order ${fo.id} for order ${order.id}: ${payload.userErrors[0].message}`);
                } else {
                    this.logger.log(`[Shopify] Successfully submitted cancellation request for fulfillment order ${fo.id} for order ${order.id}`);
                }
            }
        }

        // Step 4: Finally cancel the order
        const orderCancelMutation = `
    mutation CancelOrder($orderId: ID!) {
      orderCancel(
        orderId: $orderId
        refundMethod: {
          originalPaymentMethodsRefund: false
        }
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

        const response = await this.runGraphQL(store, true, orderCancelMutation, variables);

        const payload =
            response?.orderCancel ?? response?.data?.orderCancel ?? null;

        if (!payload) {
            throw new Error(
                `orderCancel returned empty payload for order ${order.id} (${order.externalId})`,
            );
        }

        const errors = payload.orderCancelUserErrors;
        if (errors && errors.length > 0) {
            throw new Error(
                `Failed to cancel order ${order.id} (${order.externalId}): ${errors[0].message}`,
            );
        }

        const job = payload.job;
        if (job) {
            this.logger.log(
                `[Shopify] orderCancel job created for order ${order.id} (${order.externalId}) | jobId: ${job.id} | done: ${job.done}`,
            );
        }
    }

    private async holdFulfillment(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<void> {
        const orderGid = this.normalizeOrderId(order.externalId);

        // 1) Get order with fulfillment orders
        const orderNode = await this.getOrderFulfillmentOrders(store, orderGid);
        const fulfillmentOrders =
            orderNode.fulfillmentOrders?.edges?.map((e: any) => e.node) ?? [];

        if (!fulfillmentOrders.length) {
            throw new Error(
                `No fulfillment orders found for order ${order.id} (${order.externalId}) to put on hold`,
            );
        }

        // 2) Choose which FOs to hold
        const targetFOs = fulfillmentOrders.filter((fo: any) => {
            const status = (fo.status || '').toUpperCase();
            const isTerminal = status === 'CANCELLED' || status === 'CLOSED';

            // Optional: check remaining quantity
            const lineItems =
                fo.lineItems?.edges?.map((e: any) => e.node) ?? [];
            const hasRemainingQty = lineItems.some(
                (li: any) => (li?.remainingQuantity ?? 0) > 0,
            );

            return !isTerminal && hasRemainingQty;
        });

        if (!targetFOs.length) {
            this.logger.log(
                `[Shopify] No non-terminal fulfillment orders with remaining quantity for order ${order.id}; skipping fulfillment hold`,
            );
            return;
        }

        // 3) Place holds on each FO
        for (const fo of targetFOs) {
            await this.placeFulfillmentOrderHold(
                store,
                fo.id,
                'OTHER',
                'Placed on hold via integration',
            );

            this.logger.log(
                `[Shopify] Placed fulfillment hold on FO ${fo.id} for order ${order.id} (${order.externalId})`,
            );
        }

        // await this.addOnHoldTagToOrder(order, store);
    }

    private async addOnHoldTagToOrder(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<void> {
        const orderGid = this.normalizeOrderId(order.externalId);

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
            throw new Error(
                `Could not load order ${order.id} (${order.externalId}) to add on_hold tag`,
            );
        }

        const existingTags: string[] = orderNode.tags || [];
        const newTags = new Set(
            existingTags.map((t) => t.trim()).filter(Boolean),
        );
        newTags.add('on_hold');

        const tagsArray = Array.from(newTags);

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
            throw new Error(
                `orderUpdate returned empty payload for hold tag on order ${order.id} (${order.externalId})`,
            );
        }

        const userErrors = payload.userErrors;
        if (userErrors && userErrors.length > 0) {
            throw new Error(
                `Failed to tag order ${order.id} (${order.externalId}) as on_hold: ${userErrors[0].message}`,
            );
        }

        this.logger.log(
            `[Shopify] Order ${order.id} (${order.externalId}) tagged as on_hold`,
        );
    }

    private async placeFulfillmentOrderHold(
        store: StoreEntity,
        fulfillmentOrderId: string,
        reason: string,       // should match FulfillmentHoldReason enum name
        reasonNotes?: string,
    ): Promise<void> {

        const mutation = `
              mutation PlaceFulfillmentOrderHold(
                $fulfillmentOrderId: ID!
                $reason: FulfillmentHoldReason!
                $reasonNotes: String
              ) {
                fulfillmentOrderHold(
                  id: $fulfillmentOrderId
                  fulfillmentHold: {
                    reason: $reason
                    reasonNotes: $reasonNotes
                  }
                ) {
                  fulfillmentOrder {
                    id
                    status
                    requestStatus
                    fulfillmentHolds {
                      id
                      reason
                      reasonNotes
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
            reason,
            reasonNotes: reasonNotes ?? null,
        };

        const response = await this.runGraphQL(store, true, mutation, variables);
        const payload =
            response?.fulfillmentOrderHold ??
            response?.data?.fulfillmentOrderHold ??
            null;

        if (!payload) {
            throw new Error(
                `fulfillmentOrderHold returned empty payload for FO ${fulfillmentOrderId}`,
            );
        }

        const userErrors = payload.userErrors;
        if (userErrors && userErrors.length > 0) {
            throw new Error(
                `Failed to place hold on FO ${fulfillmentOrderId}: ${userErrors[0].message}`,
            );
        }
    }

    private async markFulfillmentInProgress(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<void> {
        const orderGid = this.normalizeOrderId(order.externalId);
        const orderNode = await this.getOrderFulfillmentOrders(store, orderGid);

        const fulfillmentOrdersConnection = orderNode.fulfillmentOrders ?? null;
        const fulfillmentOrders =
            fulfillmentOrdersConnection?.edges?.map((e: any) => e.node) ?? [];

        if (!fulfillmentOrders.length) {
            throw new Error(
                `No fulfillment orders found for order ${order.id}`,
            );
        }

        const hasRemainingQuantity = (fo: any): boolean => {
            const lineItems =
                fo.lineItems?.edges?.map((e: any) => e.node) ?? [];
            return lineItems.some(
                (li: any) => (li?.remainingQuantity ?? 0) > 0,
            );
        };

        const canReportProgress = (fo: any): boolean => {
            const actions = fo.supportedActions ?? [];
            return actions.some(
                (a: any) => a?.action === 'REPORT_PROGRESS',
            );
        };

        const targetFOs = fulfillmentOrders.filter((fo: any) => {
            const status = (fo.status || '').toUpperCase();
            const isTerminal = status === 'CANCELLED' || status === 'CLOSED';

            const hasQty = hasRemainingQuantity(fo);
            const supportsReport = canReportProgress(fo);

            return !isTerminal && hasQty && supportsReport;
        });

        if (!targetFOs.length) {
            this.logger.log(
                `[Shopify] No fulfillment orders that support REPORT_PROGRESS for order ${order.id} (${order.externalId})`,
            );
            return;
        }

        for (const fo of targetFOs) {
            await this.reportFulfillmentOrderProgress(
                store,
                fo.id,
                `Marked in progress via integration for order ${order.id}`,
            );
        }
    }

    private async reportFulfillmentOrderProgress(
        store: StoreEntity,
        fulfillmentOrderId: string,
        reasonNotes?: string,
    ): Promise<void> {
        const mutation = `
    mutation FulfillmentOrderReportProgress(
      $fulfillmentOrderId: ID!
      $reasonNotes: String
    ) {
      fulfillmentOrderReportProgress(
        id: $fulfillmentOrderId
        progressReport: { reasonNotes: $reasonNotes }
      ) {
        fulfillmentOrder {
          id
          status
          requestStatus
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

        const variables = {
            fulfillmentOrderId,
            reasonNotes: reasonNotes ?? null,
        };

        const response = await this.runGraphQL(store, true, mutation, variables);
        const payload =
            response?.fulfillmentOrderReportProgress ??
            response?.data?.fulfillmentOrderReportProgress ??
            null;

        if (!payload) {
            throw new Error(
                `fulfillmentOrderReportProgress returned empty payload for FO ${fulfillmentOrderId}`,
            );
        }

        const userErrors = payload.userErrors;
        if (userErrors && userErrors.length > 0) {
            throw new Error(
                `Failed to report progress for FO ${fulfillmentOrderId}: ${userErrors[0].message}`,
            );
        }

        this.logger.log(
            `[Shopify] Reported progress for fulfillment order ${fulfillmentOrderId}`,
        );
    }

    private async markOrderDelivered(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<void> {

        const orderNode = await this.getOrderFulfillments(
            store,
            this.normalizeOrderId(order.externalId)
        );

        const fulfillments = orderNode.fulfillments ?? [];

        if (!fulfillments.length) {
            this.logger.log(
                `[Shopify] No fulfillments found for order ${order.id}`,
            );
            return;
        }

        for (const fulfillment of fulfillments) {
            await this.createDeliveredEvent(
                store,
                fulfillment.id,
                order.deliveredAt ? order.deliveredAt?.toISOString() : undefined,
            );
        }
    }

    private async createDeliveredEvent(
        store: StoreEntity,
        fulfillmentId: string,
        deliveredAt?: string,
        message?: string,
    ): Promise<void> {
        const mutation = `
    mutation FulfillmentEventCreate(
      $fulfillmentEvent: FulfillmentEventInput!
    ) {
      fulfillmentEventCreate(
        fulfillmentEvent: $fulfillmentEvent
      ) {
        fulfillmentEvent {
          id
          status
          happenedAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

        const variables = {
            fulfillmentEvent: {
                fulfillmentId,
                status: "DELIVERED",
                message:
                    message ??
                    "Order marked as delivered via integration.",
                happenedAt: deliveredAt ?? new Date().toISOString(),
            },
        };

        const response = await this.runGraphQL(
            store,
            true,
            mutation,
            variables,
        );

        const payload =
            response?.fulfillmentEventCreate ??
            response?.data?.fulfillmentEventCreate ??
            null;

        if (!payload) {
            throw new Error(
                `fulfillmentEventCreate returned empty payload for fulfillment ${fulfillmentId}`,
            );
        }

        const userErrors = payload.userErrors;
        if (userErrors && userErrors.length > 0) {
            throw new Error(
                `Failed to mark fulfillment ${fulfillmentId} as delivered: ${userErrors
                    .map((e: any) => e.message)
                    .join(", ")}`,
            );
        }

        this.logger.log(
            `[Shopify] Marked fulfillment ${fulfillmentId} as DELIVERED`,
        );
    }

    private async createReturnRequest(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<string> {
        const orderGid = this.normalizeOrderId(order.externalId);

        // 1. Get last return request
        if (!order.lastReturnId) {
            throw new Error(`Order ${order.id} has no last return request`);
        }
        const returnRequest = await this.returnRequestRepo.findOne({
            where: { id: order.lastReturnId },
            relations: ['items', 'items.returnedVariant', 'items.originalItem', 'items.originalItem.variant']
        });
        if (!returnRequest) {
            throw new Error(`Return request ${order.lastReturnId} not found for order ${order.id}`);
        }

        // 2. Query returnable fulfillments from Shopify
        const returnableQuery = `
    query GetReturnableFulfillments($orderId: ID!) {
      returnableFulfillments(orderId: $orderId, first: 10) {
        edges {
          node {
            id
            fulfillment {
              id
            }
            returnableFulfillmentLineItems(first: 10) {
              edges {
                node {
                  quantity
                  fulfillmentLineItem {
                    id
                    lineItem {
                      id
                      sku
                          variant {
                            id
                            sku
                        }
                            product {
                            id
                            handle
                        }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

        const returnableResponse = await this.runGraphQL(store, false, returnableQuery, {
            orderId: orderGid
        });

        const returnableNode =
            returnableResponse?.returnableFulfillments ??
            returnableResponse?.data?.returnableFulfillments ??
            null;

        if (!returnableNode) {
            throw new Error(`Failed to fetch returnable fulfillments for order ${order.id}`);
        }

        // 3. Flatten returnable line items and map by SKU
        const allReturnableLineItems = (returnableNode.edges || []).flatMap((edge: any) =>
            (edge.node?.returnableFulfillmentLineItems?.edges || []).map((liEdge: any) => liEdge.node)
        );

        const skuToReturnableItem: Map<string, any> = new Map();
        for (const item of allReturnableLineItems) {
            const sku = item.fulfillmentLineItem?.lineItem?.sku;
            if (sku) {
                skuToReturnableItem.set(sku, item);
            }
        }

        // 4. Match return request items with returnable line items
        const returnLineItems: any[] = [];
        for (const returnItem of returnRequest.items) {
            const variant = returnItem.returnedVariant;
            if (!variant?.sku) {
                throw new Error(`Return item ${returnItem.id} has no SKU`);
            }

            const returnableItem = skuToReturnableItem.get(variant.sku);
            if (!returnableItem) {
                throw new Error(`No returnable fulfillment line item found for SKU ${variant.sku}`);
            }

            returnLineItems.push({
                fulfillmentLineItemId: returnableItem.fulfillmentLineItem.id,
                quantity: returnItem.quantity,
                returnReason: "OTHER",
                customerNote: null
            });
        }

        // 5. Create the return request on Shopify
        const mutation = `
    mutation ReturnRequestCreate($input: ReturnRequestInput!) {
      returnRequest(input: $input) {
        return {
          id
          status
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

        const input = {
            orderId: orderGid,
            returnLineItems
        };

        const variables = { input };
        const response = await this.runGraphQL(store, true, mutation, variables);
        const payload = response?.returnRequest ?? response?.data?.returnRequest ?? null;

        if (!payload) {
            throw new Error(`returnRequest returned empty payload for order ${order.id} (${order.externalId})`);
        }

        if (payload.userErrors?.length > 0) {
            throw new Error(`Failed to create return request for order ${order.id}: ${payload.userErrors[0].message}`);
        }

        const returnId = payload.return?.id;
        if (!returnId) {
            throw new Error(`returnRequest did not return a return ID for order ${order.id}`);
        }

        this.logger.log(`[Shopify] Created return request ${returnId} for order ${order.id} with ${returnLineItems.length} items`);
        return returnId;
    }
    private async getShopifyReturnDetails(order: OrderEntity, store: StoreEntity): Promise<{
        id: string,
        status: string,
        createdAt: string,
        returnLineItems: Array<{
            id: string;
            quantity: number;
            lineItem: {
                id: string;
                sku?: string | null;
            };
            reverseFulfillmentOrderLineItem?: {
                id: string;
            } | null;
        }>;
    }> {
        const query = `
    query GetOrderReturns($orderId: ID!) {
      order(id: $orderId) {
        id
        returns(first: 10) {
          edges {
            node {
              id
              status
              createdAt
              returnLineItems(first: 50) {
                edges {
                  node {
                    ... on ReturnLineItem {
                      id
                      quantity
                      fulfillmentLineItem {
                        id
                        lineItem {
                          id
                          sku
                        }
                      }
                    }
                  }
                }
              }
              reverseFulfillmentOrders(first: 50) {
                edges {
                  node {
                    id
                    lineItems(first: 50) {
                      edges {
                        node {
                          id
                          fulfillmentLineItem {
                            id
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;


        const response = await this.runGraphQL(store, false, query, {
            orderId: this.normalizeOrderId(order.externalId)
        });

        const orderNode = response?.order ?? response?.data?.order ?? null;
        if (!orderNode) {
            throw new Error(`Failed to fetch order to get returns`);
        }

        const returns = orderNode.returns?.edges?.map((e: any) => e.node) || [];
        if (!returns.length) {
            throw new Error(`No returns found for order ${order.id} on Shopify`);
        }

        // Get the most recent return
        returns.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const returnData = returns[0];

        // 1) Build a map: fulfillmentLineItemId -> reverseFulfillmentOrderLineItemId
        const reverseMap = new Map<string, string>();

        const rfoEdges = returnData.reverseFulfillmentOrders?.edges ?? [];
        for (const rfoEdge of rfoEdges) {
            const rfoNode = rfoEdge?.node;
            if (!rfoNode) continue;

            const lineItemEdges = rfoNode.lineItems?.edges ?? [];
            for (const liEdge of lineItemEdges) {
                const rfoLineItem = liEdge?.node;
                const fulfillmentLineItemId =
                    rfoLineItem?.fulfillmentLineItem?.id ?? null;

                if (rfoLineItem?.id && fulfillmentLineItemId) {
                    // If there are multiple RFO line items for the same fulfillment line item,
                    // you may need to decide how to handle that. Here we just map the last one.
                    reverseMap.set(fulfillmentLineItemId, rfoLineItem.id);
                }
            }
        }


        // Map return line items
        const returnLineItems =
            (returnData.returnLineItems?.edges || []).map((edge: any) => {
                const node = edge.node;
                const fulfillmentLineItem = node.fulfillmentLineItem ?? null;
                const lineItem = fulfillmentLineItem?.lineItem ?? null;
                let reverseFulfillmentOrderLineItem: { id: string } | null = null;
                const fulfillmentLineItemId = fulfillmentLineItem?.id ?? null;

                if (fulfillmentLineItemId && reverseMap.has(fulfillmentLineItemId)) {
                    reverseFulfillmentOrderLineItem = {
                        id: reverseMap.get(fulfillmentLineItemId)!,
                    };
                }
                return {
                    id: node.id as string,
                    quantity: node.quantity as number,
                    lineItem: {
                        id: lineItem?.id ?? '',
                        sku: lineItem?.sku ?? null,
                    },
                    reverseFulfillmentOrderLineItem,
                };
            });
        return {
            id: returnData.id,
            status: returnData.status,
            createdAt: returnData.createdAt,
            returnLineItems,
        };
    }

    private async getShopifyOrderTransactions(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<
        Array<{
            id: string;
            kind: string;
            amountSet: {
                shopMoney: {
                    amount: string;
                    currencyCode: string;
                };
            };
        }>
    > {
        const query = `
    query GetOrderTransactions($orderId: ID!) {
      order(id: $orderId) {
        id
        transactions(first: 50) {
          id
          kind
          amountSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
      }
    }
  `;

        const response = await this.runGraphQL(store, false, query, {
            orderId: this.normalizeOrderId(order.externalId),
        });

        const orderNode = response?.order ?? response?.data?.order ?? null;
        if (!orderNode) {
            throw new Error(`Failed to fetch order transactions`);
        }

        // transactions is already an array of OrderTransaction, not a connection
        return (orderNode.transactions ?? []) as Array<{
            id: string;
            kind: string;
            amountSet: {
                shopMoney: {
                    amount: string;
                    currencyCode: string;
                };
            };
        }>;
    }

    private async approveReturnRequest(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<void> {
        // Step 1: Get local return request
        if (!order.lastReturnId) {
            throw new Error(`Order ${order.id} has no last return request`);
        }

        // Get local return with items
        const returnRequest = await this.returnRequestRepo.findOne({
            where: { id: order.lastReturnId },
            relations: ['items', 'items.returnedVariant', 'items.originalItem'],
        });

        if (!returnRequest) {
            throw new Error(`Return request ${order.lastReturnId} not found`);
        }

        // Step 2: Get Shopify return details
        const shopifyReturn = await this.getShopifyReturnDetails(order, store);

        if (shopifyReturn.status !== 'REQUESTED') {
            throw new Error(`Return request ${shopifyReturn.id} is not in REQUESTED status`);
        }

        // Step 3: Approve the return first
        const approveMutation = `
    mutation ReturnApproveRequest($input: ReturnApproveRequestInput!) {
      returnApproveRequest(input: $input) {
        return {
          id
          status
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

        const approveVariables = {
            input: {
                id: shopifyReturn.id,
            },
        };

        const approveResponse = await this.runGraphQL(store, true, approveMutation, approveVariables);
        const approvePayload =
            approveResponse?.returnApproveRequest ??
            approveResponse?.data?.returnApproveRequest ??
            null;

        if (!approvePayload) {
            throw new Error(`returnApproveRequest returned empty payload for return ${shopifyReturn.id}`);
        }

        if (approvePayload.userErrors?.length > 0) {
            throw new Error(`Failed to approve return request ${shopifyReturn.id}: ${approvePayload.userErrors[0].message}`);
        }

        this.logger.log(`[Shopify] Approved return request ${shopifyReturn.id} (status=${approvePayload.return?.status})`);

        // Step 4: Prepare data for processAndRefundReturn
        const locationId = await this.getFirstLocationId(store);
        const transactions = await this.getShopifyOrderTransactions(order, store);

        // Find first SALE transaction as parent
        const parentTransaction = transactions.find(t => t.kind === 'SALE');
        if (!parentTransaction) {
            throw new Error(`No SALE transaction found for order ${order.id}`);
        }

        const currencyCode = parentTransaction.amountSet.shopMoney.currencyCode;

        // Calculate refund amount: sum of (original item unit price * quantity) for return items
        let totalRefundAmount = 0;
        for (const item of returnRequest.items) {
            totalRefundAmount += (item.originalItem?.unitPrice || 0) * item.quantity;
        }

        // Build dispositions: match local return items to Shopify return line items via SKU
        const dispositions: Array<{
            returnLineItemId: string;
            quantity: number;
            reverseFulfillmentOrderLineItemId: string;
            locationId: string;
            dispositionType: 'RESTOCKED' | 'DISCARDED' | 'UNKNOWN';
        }> = [];

        for (const localItem of returnRequest.items) {
            const shopifyReturnLineItem = shopifyReturn.returnLineItems.find(
                (rli) => rli.lineItem.sku === localItem.returnedVariant?.sku
            );

            if (!shopifyReturnLineItem) {
                throw new Error(`Could not find Shopify return line item for SKU ${localItem.returnedVariant?.sku}`);
            }

            if (!shopifyReturnLineItem.reverseFulfillmentOrderLineItem?.id) {
                throw new Error(`Shopify return line item ${shopifyReturnLineItem.id} has no reverse fulfillment order line item`);
            }

            dispositions.push({
                returnLineItemId: shopifyReturnLineItem.id,
                quantity: localItem.quantity,
                reverseFulfillmentOrderLineItemId: shopifyReturnLineItem.reverseFulfillmentOrderLineItem.id,
                locationId,
                dispositionType: localItem.condition === 'Damaged' ? 'DISCARDED' : 'RESTOCKED',
            });
        }

        // Step 5: Process and refund the return
        await this.processAndRefundReturn(shopifyReturn.id, store, {
            notifyCustomer: false,
            refundAmount: totalRefundAmount.toString(),
            currencyCode,
            parentTransactionId: parentTransaction.id,
            dispositions,
        });
    }

    private async processAndRefundReturn(
        returnId: string,
        store: StoreEntity,
        options: {
            notifyCustomer?: boolean;
            refundAmount: string; // or number
            currencyCode: string; // e.g. "USD"
            parentTransactionId: string; // gid://shopify/OrderTransaction/...
            dispositions: Array<{
                returnLineItemId: string;
                quantity: number;
                reverseFulfillmentOrderLineItemId: string;
                locationId: string;
                dispositionType: 'RESTOCKED' | 'DISCARDED' | 'UNKNOWN'; // etc.
            }>;
        },
    ): Promise<void> {
        const mutation = `
    mutation ProcessReturn($input: ReturnProcessInput!) {
      returnProcess(input: $input) {
        return {
          id
          status
          refunds(first: 10) {
            edges {
              node {
                id
                createdAt
                totalRefundedSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

        const groupedByReturnLineItem: Record<string, any[]> = {};
        for (const disp of options.dispositions) {
            if (!groupedByReturnLineItem[disp.returnLineItemId]) {
                groupedByReturnLineItem[disp.returnLineItemId] = [];
            }
            groupedByReturnLineItem[disp.returnLineItemId].push({
                reverseFulfillmentOrderLineItemId: disp.reverseFulfillmentOrderLineItemId,
                quantity: disp.quantity,
                locationId: disp.locationId,
                dispositionType: disp.dispositionType,
            });
        }

        const returnLineItems = Object.entries(groupedByReturnLineItem).map(
            ([returnLineItemId, dispositions]) => ({
                id: returnLineItemId,
                // sum quantities from dispositions or pass as known quantity
                quantity: (dispositions as any[]).reduce(
                    (sum, d) => sum + d.quantity,
                    0,
                ),
                dispositions,
            }),
        );

        const variables = {
            input: {
                returnId,
                returnLineItems,
                financialTransfer: {
                    issueRefund: {
                        orderTransactions: [
                            {
                                parentId: options.parentTransactionId,
                                transactionAmount: {
                                    amount: options.refundAmount,
                                    currencyCode: options.currencyCode,
                                },
                            },
                        ],
                    },
                },
                notifyCustomer: options.notifyCustomer ?? false,
            },
        };

        const response = await this.runGraphQL(store, true, mutation, variables);

        const payload =
            response?.returnProcess ?? response?.data?.returnProcess ?? null;

        if (!payload) {
            throw new Error(
                `returnProcess returned empty payload for return ${returnId}`,
            );
        }

        if (payload.userErrors?.length > 0) {
            const firstError = payload.userErrors[0];
            throw new Error(
                `Failed to process and refund return ${returnId}: ${firstError.message}`,
            );
        }

        this.logger.log(
            `[Shopify] Processed and refunded return ${returnId} (status=${payload.return?.status})`,
        );
    }

    private async declineReturnRequest(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<void> {
        const { id: returnId, status } = await this.getShopifyReturnDetails(order, store);
        if (status !== 'REQUESTED') {
            throw new Error(`Return request ${returnId} is not in REQUESTED status`);
        }
        const mutation = `
    mutation ReturnDeclineRequest($input: ReturnDeclineRequestInput!) {
      returnDeclineRequest(input: $input) {
        return {
          id
          status
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

        const variables = {
            input: {
                id: returnId,
                declineReason: "OTHER"
            },
        };

        const response = await this.runGraphQL(store, true, mutation, variables);
        const payload =
            response?.returnDeclineRequest ??
            response?.data?.returnDeclineRequest ??
            null;

        if (!payload) {
            throw new Error(`returnDeclineRequest returned empty payload for return ${returnId}`);
        }

        if (payload.userErrors?.length > 0) {
            throw new Error(`Failed to decline return request ${returnId}: ${payload.userErrors[0].message}`);
        }

        this.logger.log(`[Shopify] Declined return request ${returnId} (status=${payload.return?.status})`);
    }

    private async releaseHoldFulfillment(
        order: OrderEntity,
        store: StoreEntity,
    ): Promise<void> {
        const orderGid = this.normalizeOrderId(order.externalId);
        const orderNode = await this.getOrderFulfillmentOrders(store, orderGid);

        const getFOs = (node: any) =>
            node.fulfillmentOrders?.edges?.map((e: any) => e.node) ?? [];

        const fulfillmentOrders = getFOs(orderNode);

        // Find all ON_HOLD fulfillment orders
        const onHoldFOs = fulfillmentOrders.filter((fo: any) => {
            const status = (fo.status || '').toUpperCase();
            return status === 'ON_HOLD';
        });

        if (!onHoldFOs.length) {
            this.logger.log(
                `[Shopify] No fulfillment orders on hold for order ${order.id}, nothing to do`,
            );
            return;
        }

        // Release holds for each ON_HOLD fulfillment order
        for (const fo of onHoldFOs) {
            this.logger.log(
                `[Shopify] Releasing hold for fulfillment order ${fo.id} (order ${order.id})`,
            );
            await this.releaseFulfillmentOrderHold(store, fo.id);
        }

        this.logger.log(
            `[Shopify] Released holds on ${onHoldFOs.length} fulfillment orders for order ${order.id}`,
        );
    }

    private async releaseFulfillmentOrderHold(
        store: StoreEntity,
        fulfillmentOrderId: string,
    ): Promise<void> {
        const mutation = `
    mutation ReleaseFulfillmentOrderHold($fulfillmentOrderId: ID!) {
      fulfillmentOrderReleaseHold(id: $fulfillmentOrderId) {
        fulfillmentOrder {
          id
          status
          requestStatus
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

        const variables = { fulfillmentOrderId };

        const response = await this.runGraphQL(store, true, mutation, variables);
        const payload =
            response?.fulfillmentOrderReleaseHold ??
            response?.data?.fulfillmentOrderReleaseHold ??
            null;

        if (!payload) {
            throw new Error(
                `fulfillmentOrderReleaseHold returned empty payload for FO ${fulfillmentOrderId}`,
            );
        }

        const userErrors = payload.userErrors;
        if (userErrors && userErrors.length > 0) {
            throw new Error(
                `Failed to release fulfillment hold for FO ${fulfillmentOrderId}: ${userErrors[0].message}`,
            );
        }

        this.logger.log(
            `[Shopify] Released hold on fulfillment order ${fulfillmentOrderId}`,
        );
    }

    public mapStatusToShopifyAction(status: OrderStatus): ShopifyAction {
        switch (status) {
            case OrderStatus.SHIPPED:
                return "FULFILL";

            case OrderStatus.PREPARING:
                return "PROGRESS";

            case OrderStatus.DELIVERED:
                return "DELIVERED";

            case OrderStatus.CANCELLED:
            case OrderStatus.REJECTED:
            case OrderStatus.FAILED_DELIVERY:
            case OrderStatus.OUT_OF_DELIVERY_AREA:
                return "CANCEL";

            case OrderStatus.RETURN_PREPARING:
                return "RETURN_REQUEST";

            case OrderStatus.RETURNED:
                return "RETURN_APPROVE";

            case OrderStatus.POSTPONED:
                return "HOLD";

            default:
                return "NONE";
        }
    }

    public mapOldStatusToShopifyAction(status: OrderStatus, oldStatus: OrderStatus): ShopifyAction {
        if (!status || !oldStatus || status === oldStatus) {
            return "NONE";
        }

        if (oldStatus === OrderStatus.POSTPONED) {
            return "RELEASE_HOLD";
        }

        if (oldStatus === OrderStatus.RETURN_PREPARING && status !== OrderStatus.RETURNED) {
            return "RETURN_DECLINE";
        }

        return "NONE";
    }


    public async syncFullStore(store: StoreEntity, productIds?: string[]) {
        if (!store || !store.isActive) {
            throw new Error(`Store is inactive or null`);
        }
        const hasProductIds = productIds?.length > 0;
        if (store.localSyncStatus === SyncStatus.SYNCING) {
            throw new Error(`Store is already syncing. Skipping.`);
        }

        try {
            await this.storesRepo.update(store.id, {
                localSyncStatus: SyncStatus.SYNCING,
                localSyncStatusAt: new Date()
            });

            let categoryMap = new Map<string, string>();
            if (!hasProductIds) {
                categoryMap = await this.syncCategoriesCursor(store);
            }

            await this.syncProductsCursor(store, categoryMap, productIds);

            await this.storesRepo.update(store.id, {
                localSyncStatus: SyncStatus.SYNCED,
            });


            if (store.adminId) {
                this.appGateway.emitStoreSyncStatus(String(store.adminId), {
                    storeId: store.id,
                    provider: store.provider,
                    status: SyncStatus.SYNCED,
                    type: "local",
                });
            }
        } catch (error) {
            const message = this.getErrorMessage(error);

            await this.storesRepo.update(store.id, {
                localSyncStatus: SyncStatus.FAILED,
            });

            if (store.adminId) {
                this.appGateway.emitStoreSyncStatus(String(store.adminId), {
                    storeId: store.id,
                    provider: store.provider,
                    status: SyncStatus.FAILED,
                    type: "local",
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

        const savedSecret = store?.credentials?.clientSecret;
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

        const isAuthed = crypto.timingSafeEqual(
            Buffer.from(generatedHash),
            Buffer.from(shopifyHmac)
        );
        return isAuthed;
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


    public async mapWebhookCreate(body: any, store: StoreEntity): Promise<WebhookOrderPayload> {
        const paymentMethod = body.payment_gateway_names?.length > 0 ? this.mapPaymentMethod(body.payment_gateway_names?.[0] || "") : PaymentMethod.CASH_ON_DELIVERY;
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
            const hasOnlyDefaultVariant = product.hasOnlyDefaultVariant || false;
            // Map every variant's options for this product
            if (!hasOnlyDefaultVariant) {
                product.variants?.nodes?.forEach((v: any) => {
                    const numericVarId = v.id.split('/').pop();
                    variantIdToOptionsMap.set(numericVarId, v.selectedOptions);
                });
            }
        });

        const billing = body.billing_address || {};
        const fullName = `${billing.first_name || ""} ${billing.last_name || ""}`.trim();
        const address = `${billing.address1 || ""} ${billing.address2 || ""}`.trim();
        return {
            externalOrderId: String(String(body.id).startsWith('gid://') ? body.id : `gid://shopify/Order/${body.id}`),
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

                const variationProps = realProps
                    .filter(p => p.value)
                    .map(p => ({
                        name: p.name?.trim(),
                        value: String(p.value)?.trim()
                    }));


                const attrs = variationProps.reduce((acc: Record<string, string>, prop) => {
                    if (prop.name && prop.value) {
                        const key = this.productsService.slugifyKey(prop.name);
                        const value = prop.value;
                        acc[key] = value;
                    }
                    return acc;
                }, {});
                const key = this.productsService.canonicalKey(attrs);

                const gidId = prodId.startsWith('gid://') ? prodId : `gid://shopify/Product/${prodId}`
                return {
                    name: String(item.title),
                    productSlug: idToSlugMap.get(prodId) || item.sku || prodId,
                    remoteProductId: gidId,
                    quantity: item.quantity,
                    price: Number(item.price),
                    variant: varId
                        ? {
                            key: key || "default",
                            variation_props: variationProps
                        }
                        : {
                            key: "default",
                            variation_props: []
                        }
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
        hasOnlyDefaultVariant
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
        metafield(namespace: "upsellings-products", key: "complementary_products") {
            id
            namespace
            key
            type
            value
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

    public async getScopes(store: StoreEntity): Promise<string[] | null> {
        const query = `
    query getAppScopes {
      currentAppInstallation {
        accessScopes {
          handle
        }
      }
    }
  `;

        try {
            const response = await this.runGraphQL(
                store,
                false, // query
                query,
                {}
            );

            const scopes =
                response?.currentAppInstallation?.accessScopes?.map(
                    (s: any) => s.handle
                ) || [];

            return scopes;

        } catch (error: any) {
            this.logger?.error?.(
                `[Shopify] Failed to fetch scopes: ${error?.message}`
            );
            return null;
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
                    hasOnlyDefaultVariant
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
                        requiresComponents
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
            .map(id => id.startsWith('gid://') ? id : `gid://shopify/Product/${id}`)
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
          hasOnlyDefaultVariant
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
              requiresComponents
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
        const hasOnlyDefaultVariant = remote.hasOnlyDefaultVariant || false;

        // Map variants from Shopify to EasyOrder variant DTO
        const variants = (remote.variants?.nodes || []).map((v: any) => {
            const baseVariant: any = {
                price: Number(v.price) || 0,
                // Use Shopify unit cost as expense
                expense: v.inventoryItem?.unitCost?.amount
                    ? Number(v.inventoryItem.unitCost.amount)
                    : 0,
                quantity: Number(v.inventoryQuantity) || 0,
                sku: String(v.sku || ""),
            };

            baseVariant.variation_props = [];
            if (!hasOnlyDefaultVariant) {
                baseVariant.variation_props = (v.selectedOptions || []).map((o: any) => ({
                    variation: o.name?.trim(),
                    variation_prop: String(o.value)?.trim(),
                }));
            }

            return baseVariant;
        });

        let variations: any[] = [];
        if (!hasOnlyDefaultVariant) {
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

            variations = Array.from(variationMap.entries()).map(
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
        }

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
            id: String(remote.id),
            name: remote.title?.trim(),
            price: productPrice,
            expense: productExpense,
            description: remote.descriptionHtml || "",
            slug: remote.handle,
            type: hasOnlyDefaultVariant ? ProductType.SINGLE : ProductType.VARIABLE,
            upsellings: [],
            sku: hasOnlyDefaultVariant ? firstVariant?.sku || "" : "",
            thumb: remote.images?.nodes?.[0]?.url || "",
            images: (remote.images?.nodes || []).slice(1).map((img: any) => img.url),
            categories: (remote.collections?.nodes || []).map((c: any) => ({
                id: String(c.id),
                slug: c.handle,
                name: c.title,
            })),
            quantity: totalQuantity,
            variations,
            variants,
        };
    }

    async validateProviderConnection(store: StoreEntity): Promise<boolean> {
        const scopes = ["read_all_orders,read_returns,write_returns,  write_locations, read_locations, read_orders, write_fulfillments,read_fulfillments,write_orders, read_products, write_products, read_publications, write_publications, read_third_party_fulfillment_orders, write_third_party_fulfillment_orders, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders, read_assigned_fulfillment_orders, write_assigned_fulfillment_orders"]

        const { storeUrl, credentials } = store;
        const accessToken = await this.getAccessToken(store);
        const apiKey = credentials?.apiKey;

        if (!storeUrl || !apiKey || !accessToken) {
            this.logger.error(`[Shopify] Validation failed: Missing storeUrl, apiKey, or accessToken`);
            return false;
        }

        try {
            // 🔥 Step 1: Fetch scopes using your existing method
            // const scopes = await this.getScopes(store);

            // if (!scopes) {
            //     this.logger.error(`[Shopify] Failed to fetch scopes (invalid token or app not installed)`);
            //     return false;
            // }

            // // 🔥 Step 2: Compare scopes
            // const grantedSet = new Set(scopes);
            // const missingScopes = REQUIRED_SCOPES.filter(s => !grantedSet.has(s));

            // if (missingScopes.length > 0) {
            //     this.logger.warn(
            //         `[Shopify] Missing required scopes: ${missingScopes.join(', ')}`
            //     );
            //     return false;
            // }

            return true;
        } catch (error: any) {
            const message = this.getErrorMessage(error);
            this.logger.error(`[Shopify] Connection check failed: ${message}`);
            return false;
        }
    }


    public async getAllMappedProducts(store: StoreEntity, filters?: string[]): Promise<MappedProductDto[]> {

        let allProducts: MappedProductDto[] = [];
        let hasNextPage = true;
        let after: string | null = null;

        const query = `
            query PaginatedProducts($first: Int!, $after: String) {
                products(first: $first, after: $after) {
                    nodes {
                        id
                        handle
                        title
                        descriptionHtml
                        hasOnlyDefaultVariant
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
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                }
            }
        `;

        while (hasNextPage) {
            try {
                const response = await this.runGraphQL(
                    store,
                    false, // query
                    query,
                    { first: 50, after },
                );

                const productsData = response?.products || response?.data?.products;
                const nodes = productsData?.nodes || [];

                allProducts.push(...nodes.map(p => this.mapRemoteProductToDto(p)));

                const pageInfo = productsData?.pageInfo;
                hasNextPage = pageInfo?.hasNextPage || false;
                after = pageInfo?.endCursor || null;

            } catch (error: any) {
                const message = this.getErrorMessage(error);
                this.logger.error(`[Shopify] Failed to fetch products batch: ${message}`);
                hasNextPage = false; // Stop on error
            }
        }

        return allProducts;
    }

    public override normalizeOrderId(externalOrderId: string): string {
        return String(externalOrderId).startsWith('gid://') ? externalOrderId : `gid://shopify/Order/${externalOrderId}`;
    }


    public async processExternalOrderId(body: any, headers: Record<string, any>): Promise<string | null> {
        type OrderIdResolver = (body: any, headers: any, store: StoreEntity | null) => Promise<string | null>;

        const externalStoreId = headers["x-shopify-shop-domain"];
        const store = externalStoreId ? await this.getStoreByExternalStoreId(externalStoreId) : null;

        if (body?.order_id) {
            return body?.order_id;
        }

        // const getFulfillmentOrderIdResolver: OrderIdResolver = async (body, headers, store) => {
        //     let orderId = body?.fulfillment_order?.order_id;
        //     if (!orderId && body?.fulfillment_order?.id && store) {
        //         orderId = await this.getOrderIdFromFulfillmentOrderId(body.fulfillment_order.id, store);
        //     }
        //     return orderId;
        // };

        const orderIdResolvers: Record<ShopifyTopic, OrderIdResolver> = {

            [ShopifyTopic.ORDERS_CREATE]: (body) => Promise.resolve(body?.id),
            [ShopifyTopic.ORDERS_CANCELLED]: (body) => Promise.resolve(body?.id),
            [ShopifyTopic.ORDERS_DELETE]: (body) => Promise.resolve(body?.id),
            [ShopifyTopic.ORDERS_UPDATED]: (body) => Promise.resolve(body?.id),
            [ShopifyTopic.ORDERS_PAID]: (body) => Promise.resolve(body?.id),
            [ShopifyTopic.ORDERS_RISK_ASSESSMENT_CHANGED]: (body) => Promise.resolve(body?.order_id)

            
            // [ShopifyTopic.ORDERS_FULFILLED]: (body) => Promise.resolve(body?.id),
            // [ShopifyTopic.REFUNDS_CREATE]: (body) => Promise.resolve(body?.order_id),

            // [ShopifyTopic.RETURNS_REQUEST]: (body) => Promise.resolve(body?.return?.order?.id || body?.order?.id),
            // [ShopifyTopic.RETURNS_APPROVE]: (body) => Promise.resolve(body?.return?.order?.id || body?.order?.id),
            // [ShopifyTopic.RETURNS_PROCESS]: (body) => Promise.resolve(body?.return?.order?.id || body?.order?.id),
            // [ShopifyTopic.RETURNS_CLOSE]: (body) => Promise.resolve(body?.return?.order?.id || body?.order?.id),
            // [ShopifyTopic.RETURNS_REOPEN]: (body) => Promise.resolve(body?.return?.order?.id || body?.order?.id),
            // [ShopifyTopic.RETURNS_UPDATE]: (body) => Promise.resolve(body?.return?.order?.id || body?.order?.id),
            // [ShopifyTopic.RETURNS_CANCEL]: (body) => Promise.resolve(body?.return?.order?.id || body?.order?.id),

            // // 👇 fulfillment ORDER webhooks (IMPORTANT)
            // [ShopifyTopic.FULFILLMENT_ORDERS_PLACED_ON_HOLD]: getFulfillmentOrderIdResolver,
            // [ShopifyTopic.FULFILLMENT_ORDERS_HOLD_RELEASED]: getFulfillmentOrderIdResolver,
            // [ShopifyTopic.FULFILLMENT_ORDERS_RESCHEDULED]: getFulfillmentOrderIdResolver,
            // [ShopifyTopic.FULFILLMENT_ORDERS_PROGRESS_REPORTED]: getFulfillmentOrderIdResolver,
            // [ShopifyTopic.FULFILLMENT_ORDERS_SPLIT]: getFulfillmentOrderIdResolver,
            // [ShopifyTopic.FULFILLMENT_ORDERS_MERGED]: getFulfillmentOrderIdResolver,
            // [ShopifyTopic.FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE]: getFulfillmentOrderIdResolver,

            // // 👇 fulfillment (shipment-level)
            // [ShopifyTopic.FULFILLMENTS_CREATE]: (body) => Promise.resolve(body?.order_id),
            // [ShopifyTopic.FULFILLMENTS_UPDATE]: (body) => Promise.resolve(body?.order_id),
        };

        const topic = headers["x-shopify-topic"];

        const resolver = orderIdResolvers[topic as ShopifyTopic];

        if (!resolver) {
            return null;
        }

        const externalOrderId = await resolver(body, headers, store);

        return externalOrderId;
    }
}
