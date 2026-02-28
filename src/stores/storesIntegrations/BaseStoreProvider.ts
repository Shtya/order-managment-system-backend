import { Injectable, forwardRef, Inject, Logger, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { StoreEntity, StoreProvider, SyncStatus } from "entities/stores.entity";
import { EncryptionService } from "common/encryption.service";
import { StoresService } from "../stores.service";
import { CategoryEntity } from "entities/categories.entity";
import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import Bottleneck from "bottleneck";
import { OrderEntity, OrderStatus, PaymentMethod, PaymentStatus } from "entities/order.entity";
import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";


export interface WebhookOrderPayload {
    externalId: string;
    full_name: string;
    phone: string;
    address: string;
    government?: string;
    payment_method: PaymentMethod;
    status: PaymentStatus;
    shipping_cost?: number;
    cart_items: {
        product_slug: string;
        quantity: number;
        price: number;
        variant?: {
            variation_props?: { name: string; value: string }[];
        };
    }[];
}


export interface WebhookOrderUpdatePayload {
    externalId: string;
    remoteStatus: string;
    mappedStatus: OrderStatus;
}

export interface UnifiedProductVariantDto {
    sku: string | null;
    price: number;
    stockOnHand: number;
    attributes: Record<string, string>;
    key?: string;
}

export interface UnifiedProductCategoryDto {
    slug: string;
    name: string;
    thumb?: string | null;
}

export interface UnifiedProductDto {
    externalId?: string;
    name: string;
    slug: string;
    description?: string | null;
    basePrice: number;
    mainImage?: string | null;
    images: string[];
    category?: UnifiedProductCategoryDto | null;
    variants: UnifiedProductVariantDto[];
}

@Injectable()
export abstract class BaseStoreProvider implements OnModuleInit {
    abstract readonly code: StoreProvider;
    abstract readonly displayName: string;
    abstract readonly baseUrl: string;

    protected readonly logger = new Logger(this.constructor.name);
    protected limiters: Map<string, Bottleneck> = new Map();
    protected axiosInstance: AxiosInstance;
    protected readonly limit: number;
    protected readonly storeProvider: StoreProvider;
    protected readonly baseImg = process.env.IMAGE_BASE_URL;

    public customWebhookName = 'secret';
    constructor(
        @InjectRepository(StoreEntity) protected readonly storesRepo: Repository<StoreEntity>,
        @InjectRepository(CategoryEntity) protected readonly categoryRepo: Repository<CategoryEntity>,
        protected readonly encryptionService: EncryptionService,
        @Inject(forwardRef(() => StoresService))
        protected readonly mainStoresService: StoresService,
        limit,
        storeProvider
    ) {
        this.limit = limit;
        this.storeProvider = storeProvider;
    }
    onModuleInit() {
        this.axiosInstance = axios.create({
            baseURL: this.baseUrl, // Safe to access now
            timeout: 10000,
        });

        this.recoverStuckSyncs()
    }
    /* Centralized Error Handling for Axios
       */
    protected handleError(error: any, context: string) {
        // If we exhausted retries and still got a 429
        if (error.response?.status === 429) {
            this.logger.error(`Permanent Rate Limit block for ${context}. Please check dashboard.`);
        }
        throw error;
    }


    /**
     * ==========================================
     * CONTEXTUAL LOGGING HELPERS
     * ==========================================
     * These methods automatically include Store ID and Admin ID in log messages
     * for better traceability and debugging
     */
    protected getCtxString(store?: StoreEntity, adminId?: string | number): string {
        const parts: string[] = [];
        if (store) {
            parts.push(`StoreID:${store.id}`);
            parts.push(`AdminID:${store.adminId}`);
        } else if (adminId) {
            parts.push(`AdminID:${adminId}`);
        }
        return parts.length > 0 ? `[${parts.join('|')}]` : '';
    }

    protected logCtx(message: string, store?: StoreEntity, adminId?: string | number): void {
        const ctx = this.getCtxString(store, adminId);
        this.logger.log(`${ctx} ${message}`);
    }

    protected logCtxDebug(message: string, store?: StoreEntity, adminId?: string | number): void {
        const ctx = this.getCtxString(store, adminId);
        this.logger.debug(`${ctx} ${message}`);
    }

    protected logCtxWarn(message: string, store?: StoreEntity, adminId?: string | number): void {
        const ctx = this.getCtxString(store, adminId);
        this.logger.warn(`${ctx} ${message}`);
    }

    protected logCtxError(message: string, store?: StoreEntity, adminId?: string | number): void {
        const ctx = this.getCtxString(store, adminId);
        this.logger.error(`${ctx} ${message}`);
    }
    protected getLimiter(adminId: string): Bottleneck {
        let limiter = this.limiters.get(adminId);
        const calculatedMinTime = Math.ceil(60000 / this.limit);
        if (!limiter) {
            limiter = new Bottleneck({
                id: `limiter_${adminId}`,
                reservoir: this.limit,
                reservoirRefreshAmount: this.limit,
                reservoirRefreshInterval: 60 * 1000,
                // SOLUTION: Use maxConcurrent 1 and 1500ms minTime to strictly obey 40 req/min
                maxConcurrent: 150,
                minTime: calculatedMinTime,
            });

            limiter.on('idle', () => {
                this.limiters.delete(adminId);
                this.logger.debug(`Cleaned up idle limiter for admin: ${adminId}`);
            });

            this.limiters.set(adminId, limiter);
        }
        return limiter;
    }

    /**
     * Centralized limiter + retry/backoff executor.
     * - `fn` should perform the actual network call and throw on errors.
     * - `backoffBase` in ms (used to multiply attempt index)
     */
    protected async executeWithLimiter(adminId: string, fn: () => Promise<any>, attempt = 0, backoffBase = 10000, context?: string): Promise<any> {
        const cleanAdminId = String(adminId || 'global');
        const limiter = this.getLimiter(cleanAdminId);

        try {
            return await limiter.schedule(async () => {
                return await fn();
            });
        } catch (error) {
            const status = error.response?.status;
            const code = error.code || error.cause?.code; // Catch system errors like ETIMEDOUT

            // Define what constitutes a "Retryable Error"
            const isRateLimit = status === 429;
            const isNetworkError = ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN'].includes(code);
            // Handle throttling centrally
            if ((isRateLimit || isNetworkError) && attempt < 5) {
                const waitTime = (attempt + 1) * backoffBase;

                // Stop all other outgoing requests for this admin immediately
                try {
                    const currentRes = await limiter.currentReservoir();
                    if (currentRes > 0) {
                        await limiter.incrementReservoir(-currentRes);
                    }
                } catch (e) {
                    this.logger.debug(`Failed to clear reservoir for ${cleanAdminId}: ${e?.message}`);
                }
                const errorType = isRateLimit ? 'Rate Limit (429)' : `Network Error (${code || 'ETIMEDOUT'})`;
                if (isRateLimit) {
                    this.logger.warn(
                        `${context ?? '[Limiter]'} ${errorType} hit for Admin ${cleanAdminId}. ` +
                        `Reservoir cleared. Cooling down for ${waitTime}ms (Attempt ${attempt + 1}/5)...`
                    );
                } else {
                    this.logger.warn(
                        `${context ?? '[Limiter]'} ${errorType} detected for Admin ${cleanAdminId}. ` +
                        `Retrying in ${waitTime}ms (Attempt ${attempt + 1}/5)...`
                    );
                }

                await new Promise((resolve) => setTimeout(resolve, waitTime));

                // Refill only 1 slot to allow the retry attempt to proceed
                try {
                    await limiter.incrementReservoir(1);
                } catch (e) {
                    this.logger.debug(`Failed to increment reservoir for ${cleanAdminId}: ${e?.message}`);
                }

                return this.executeWithLimiter(adminId, fn, attempt + 1, backoffBase, context);
            }

            // Re-throw for upstream handling
            throw error;
        }
    }

    /**
     * Reusable axios call that leverages the centralized limiter/retry logic.
     */
    protected async sendRequest(store: StoreEntity, config: AxiosRequestConfig, attempt = 0): Promise<any> {
        const cleanAdminId = String(store?.adminId || 'global');
        const method = (config.method || 'GET').toUpperCase();
        const url = config.url || config.baseURL || '';

        return this.executeWithLimiter(cleanAdminId, async () => {
            if (!store) {
                this.logger.warn(`Sync skipped for Admin ${cleanAdminId}: No active store found is disabled.`);
                return null;
            }

            const response = await this.axiosInstance.request({ ...config });
            return response.data;
        }, attempt, 10000, `${method} ${url}`);
    }

    getImageUrl = (url) => {
        return url.startsWith('http') ? url : this.baseImg + url;

    };

    /**
          * RECOVERY: Clean up stores stuck in SYNCING status (useful when app crashes)
          * Should be called on app startup to prevent indefinite locks
          */
    public async recoverStuckSyncs(): Promise<number> {
        this.logger.warn(`[Recovery] Scanning for stores stuck in SYNCING status...`);

        try {
            const stuckStores = await this.storesRepo.find({
                where: {
                    provider: this.storeProvider,
                    syncStatus: SyncStatus.SYNCING
                }
            });

            if (stuckStores.length === 0) {
                this.logger.log(`[Recovery] ✓ No stores stuck in SYNCING status`);
                return 0;
            }

            for (const store of stuckStores) {
                this.logCtxWarn(
                    `[Recovery] Found store stuck in SYNCING for ${Math.floor((Date.now() - store.lastSyncAttemptAt.getTime()) / 1000)}s. Resetting to FAILED status...`,
                    store
                );

                await this.storesRepo.update(store.id, {
                    syncStatus: SyncStatus.FAILED,
                });
            }

            this.logger.log(`[Recovery] ✓ Successfully recovered ${stuckStores.length} stuck store(s)`);
            return stuckStores.length;
        } catch (error) {
            this.logger.error(`[Recovery] ✗ Failed to recover stuck syncs: ${error.message}`);
            return 0;
        }
    }


    // Shopify-specific GraphQL helper was moved into `ShopifyService` to allow
    // usage of the `@shopify/shopify-api` client and provider-specific behavior.
    public abstract syncCategory({ category, relatedAdminId, slug }: { category: CategoryEntity, relatedAdminId?: string, slug?: string })
    public abstract syncProduct({ product, variants, slug }: { product: ProductEntity, variants: ProductVariantEntity[], slug?: string })
    public abstract syncOrderStatus(order: OrderEntity)
    public abstract syncFullStore(store: StoreEntity)
    public abstract verifyWebhookAuth(headers: Record<string, any>, body: any, store: StoreEntity, req?: any, action?: "create" | "update"): boolean;
    public abstract mapWebhookUpdate(body: any): WebhookOrderUpdatePayload;
    public abstract mapWebhookCreate(body: any, store: StoreEntity): Promise<WebhookOrderPayload>;
    public abstract syncProductsFromProvider(store: StoreEntity, slugs?: string[], manager?: any): Promise<void>;
    public abstract validateProviderConnection(store: StoreEntity): Promise<boolean>

}


