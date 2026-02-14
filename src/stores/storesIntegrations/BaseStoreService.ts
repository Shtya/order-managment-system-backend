import { Injectable, forwardRef, Inject, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, Not } from "typeorm";
import { StoreEntity } from "entities/stores.entity";
import { EncryptionService } from "common/encryption.service";
import { StoresService } from "../stores.service";
import { CategoryEntity } from "entities/categories.entity";
import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import Bottleneck from "bottleneck";
import { OrderEntity } from "entities/order.entity";
import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";


@Injectable()
export abstract class BaseStoreService {
    protected readonly logger = new Logger(this.constructor.name);
    protected limiters: Map<string, Bottleneck> = new Map();
    protected readonly axiosInstance: AxiosInstance;
    protected readonly limit: number;
    protected readonly baseImg = process.env.IMAGE_BASE_URL;
    constructor(
        @InjectRepository(StoreEntity) protected readonly storesRepo: Repository<StoreEntity>,
        @InjectRepository(CategoryEntity) protected readonly categoryRepo: Repository<CategoryEntity>,
        protected readonly encryptionService: EncryptionService,
        @Inject(forwardRef(() => StoresService))
        protected readonly mainStoresService: StoresService,
        baseUrl,
        limit: 40
    ) {

        this.axiosInstance = axios.create({
            baseURL: baseUrl,
            timeout: 10000,
        });
        this.limit = limit;
    }
    /* Centralized Error Handling for Axios
       */
    protected handleError(error: any, context: string) {
        // If we exhausted retries and still got a 429
        if (error.response?.status === 429) {
            this.logger.error(`EasyOrder: Permanent Rate Limit block for ${context}. Please check dashboard.`);
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

        if (!limiter) {
            limiter = new Bottleneck({
                id: `limiter_${adminId}`,
                reservoir: 40,
                reservoirRefreshAmount: 40,
                reservoirRefreshInterval: 60 * 1000,
                // SOLUTION: Use maxConcurrent 1 and 1500ms minTime to strictly obey 40 req/min
                maxConcurrent: 150,
                minTime: 1500,
            });

            limiter.on('idle', () => {
                this.limiters.delete(adminId);
                this.logger.debug(`Cleaned up idle limiter for admin: ${adminId}`);
            });

            this.limiters.set(adminId, limiter);
        }
        return limiter;
    }

    protected async sendRequest(store: StoreEntity, config: AxiosRequestConfig, attempt = 0): Promise<any> {
        const cleanAdminId = store?.adminId;
        const limiter = this.getLimiter(cleanAdminId);

        try {
            return await limiter.schedule(async () => {
                if (!store) {
                    this.logger.warn(`[EasyOrder] Sync skipped for Admin ${cleanAdminId}: No active store found or autoSync is disabled.`);
                    return null;
                }

                const response = await this.axiosInstance.request({
                    ...config,
                });

                return response.data;
            });
        } catch (error) {
            const message = error.response?.data?.message;
            const status = error.response?.status;
            const url = config.url;
            const method = config.method?.toUpperCase() || 'GET';
            // Handle 429 with a complete cooldown
            if (status === 429 && attempt < 5) {
                const waitTime = (attempt + 1) * 10000; // 10s, 20s, 30s...

                // Stop all other outgoing requests for this admin immediately
                const currentRes = await limiter.currentReservoir();
                if (currentRes > 0) {
                    await limiter.incrementReservoir(-currentRes);
                }

                this.logger.warn(`429 Hit for Admin ${cleanAdminId}. Reservoir cleared. Cooling down for ${waitTime}ms...`);

                // Wait for the backoff period
                await new Promise((resolve) => setTimeout(resolve, waitTime));

                // Refill only 1 slot to allow the retry attempt to proceed
                await limiter.incrementReservoir(1);

                // Recursive call is now safe because the previous .schedule() has resolved/rejected
                return this.sendRequest(store, config, attempt + 1);
            }
            this.logger.error(`External API Failed: ${method} ${url} - Status ${status}: ${JSON.stringify(message)}`);
            this.handleError(error, config.url);
        }
    }

    getImageUrl = (url) => {
        return url.startsWith('http') ? url : this.baseImg + url;

    };
    public abstract syncCategory({ category, relatedAdminId, slug }: { category: CategoryEntity, relatedAdminId?: string, slug?: string })
    public abstract syncProduct({ product, variants, slug }: { product: ProductEntity, variants: ProductVariantEntity[], slug?: string })
    public abstract syncOrderStatus(order: OrderEntity)
    public abstract syncFullStore(store: StoreEntity)
    public abstract recoverStuckSyncs()
}
