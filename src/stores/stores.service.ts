import { BadRequestException, forwardRef, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, In, Not, Repository } from "typeorm";
import { OrderFailStatus, StoreEntity, StoreProvider, SyncStatus, WebhookOrderFailureEntity, WebhookOrderProblem } from "entities/stores.entity";
import { CreateStoreDto, EasyOrdersCredentialsDto, IntegrateDto, UpdateStoreDto } from "dto/stores.dto";
import { tenantId } from "src/category/category.service";
import { CategoryEntity } from "entities/categories.entity";
import { BundleEntity } from "entities/bundle.entity";
import { ProductEntity, ProductType, ProductVariantEntity } from "entities/sku.entity";
import { OrderEntity, OrderStatus } from "entities/order.entity";
import { RedisService } from "common/redis/RedisService";

import { OrderSyncQueueService } from "src/queue/queues/order-sync.queue";

import { BaseStoreProvider, IBundleSyncProvider, ISkuFetch, MappedProductDto, oldBundleDataDto, UnifiedProductDto, WebhookOrderPayload } from "./storesIntegrations/BaseStoreProvider";
import { ShopifyService } from "./storesIntegrations/ShopifyService";
import { EasyOrderService } from "./storesIntegrations/EasyOrderService";
import WooCommerceService from "./storesIntegrations/WooCommerce";
import { OrdersService } from "src/orders/services/orders.service";
import { ProductsService } from "src/products/products.service";
import { ProductSyncStateService } from "src/product-sync-state/product-sync-state.service";
import { PurchasesService } from "src/purchases/purchases.service";
import { SafesService } from "src/safes/safes.service";
import { ShippingService } from "src/shipping/shipping.service";
import { CreateOrderDto } from "dto/order.dto";
import { CreateProductDto, CreateSkuItemDto, UpsertProductSkusDto } from "dto/product.dto";
import { CreatePurchaseDto, PurchaseItemDto } from "dto/purchase.dto";
import { CreateAccountDto } from "dto/safe.dto";
import { Account, AccountType } from "entities/safe.entity";
import * as crypto from "crypto";
import * as ExcelJS from "exceljs";
import { DateFilterUtil } from "common/date-filter.util";
import { AppGateway } from "common/app.gateway";
import { NotificationService } from "src/notifications/notification.service";
import { generateRandomAlphanumeric, generateSlug, getErrorMessage, normalizeSku } from "common/healpers";
import { ProductSyncStatus, ProductSyncStateEntity, ProductSyncAction, SyncEntityType } from "entities/product_sync_error.entity";
import { NotificationType } from "entities/notifications.entity";
import { ProductSyncJobs, OrderSyncJobs } from "src/queue/common/queue.constants";
import { ProductSyncQueueService } from "src/queue/queues/product-sync.queue";
import { ClientSettingsService } from "src/client-settings/client-settings.service";
import { RequestTranslationService, TranslationService } from "common/translation.service";

@Injectable()
export class StoresService {
  private readonly logger = new Logger(StoresService.name);
  private providers: Record<string, BaseStoreProvider>;
  constructor(
    private dataSource: DataSource,
    // private readonly encryptionService: EncryptionService,
    protected readonly redisService: RedisService,
    protected readonly productSyncQueueService: ProductSyncQueueService,
    protected readonly orderSyncQueueService: OrderSyncQueueService,
    private readonly appGateway: AppGateway,
    private readonly notificationService: NotificationService,
    private readonly productSyncStateService: ProductSyncStateService,
    private readonly shippingService: ShippingService,
    private readonly shopifyService: ShopifyService,
    private readonly easyOrderService: EasyOrderService,
    private readonly woocommerceService: WooCommerceService,

    @InjectRepository(ProductEntity) protected readonly productsRepo: Repository<ProductEntity>,
    @InjectRepository(ProductVariantEntity) protected readonly pvRepo: Repository<ProductVariantEntity>,
    @InjectRepository(WebhookOrderFailureEntity) private readonly failureRepo: Repository<WebhookOrderFailureEntity>,
    @InjectRepository(ProductSyncStateEntity) private readonly productSyncStateRepo: Repository<ProductSyncStateEntity>,
    @InjectRepository(OrderEntity) private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(OrderEntity) private readonly ordersRepo: Repository<OrderEntity>,
    @InjectRepository(BundleEntity) private readonly bundleRepo: Repository<BundleEntity>,

    @Inject(forwardRef(() => OrdersService))
    protected readonly ordersService: OrdersService,
    @Inject(forwardRef(() => ProductsService))
    private readonly productsService: ProductsService,

    @InjectRepository(StoreEntity)
    private readonly storesRepo: Repository<StoreEntity>,
    private readonly clientSettingsService: ClientSettingsService,
    private readonly translations: TranslationService,
    private requestTranslations: RequestTranslationService,
  ) {
    this.providers = {
      shopify: this.shopifyService,
      easyorder: this.easyOrderService,
      woocommerce: this.woocommerceService,
    };
  }


  private generateSecret() {
    return crypto.randomBytes(24).toString("hex");
  }

  isSkuFetchProvider(provider: any): provider is ISkuFetch {
    return typeof provider.getProductBySku === 'function';
  }

  public getProvider(provider: string): BaseStoreProvider {
    const key = (provider || '').toLowerCase().trim();
    const p = this.providers[key];
    if (!p)
      throw new BadRequestException(this.translations.t('domains.stores.unsupported_shipping_provider', { args: { provider } }));
    return p;
  }


  private async clearStoreCache(storeId: string) {
    const pattern = `stores:${storeId}:*`;
    try {
      // جلب كافة المفاتيح التي تطابق النمط
      const keys = await this.redisService.redisClient.keys(pattern);

      if (keys && keys.length > 0) {
        await this.redisService.redisClient.del(keys);
        this.logger.log(`[Cache] Cleared ${keys.length} keys for store ${storeId} using pattern: ${pattern}`);
      }


    } catch (error: any) {
      this.logger.error(`[Cache] Failed to clear cache for store ${storeId}: ${error.message}`);
    }
  }

  listProviders() {
    return {
      ok: true,
      providers: Object.values(this.providers).filter(p => !!p).map((p) => ({
        code: p.code,
        name: p.displayName,
        supportBundle: p.supportBundle,
        maxBundleItems: p.maxBundleItems,
      })),
    };
  }


  async list(me: any, q?: any) {
    const adminId = tenantId(me); // Normalized and trimmed adminId
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? "").trim(); // Remember to trim

    const qb = this.storesRepo.createQueryBuilder("store");

    // 1. SELECT ONLY SAFE COLUMNS (Explicitly skip encryptedData, iv, tag)
    qb.select([
      "store.id",
      "store.name",
      "store.adminId",
      "store.storeUrl",
      "store.provider",
      "store.isActive",
      "store.isIntegrated",
      "store.syncNewProducts",
      "store.syncRemoteProducts",
      "store.syncStatus",
      "store.localSyncStatus",
      "store.localSyncStatusAt",
      "store.lastSyncAttemptAt",
      "store.created_at",
      "store.updated_at",
      "store.credentials",
    ]);

    // 2. Multi-tenant Filter
    qb.where("store.adminId = :adminId", { adminId });

    if (q?.isActive === 'true') qb.andWhere('store.isActive = :isActive', { isActive: q?.isActive });

    // 3. Optional Filter: Platform/Provider
    if (q?.provider) {
      qb.andWhere("store.provider = :provider", { provider: q.provider });
    }

    // 4. Optional Filter: Status
    if (q?.syncStatus) {
      qb.andWhere("store.syncStatus = :syncStatus", { syncStatus: q?.syncStatus });
    }

    // 5. Search (Name, Code, or URL)
    if (search) {
      qb.andWhere(
        "(store.name ILIKE :s OR store.storeUrl ILIKE :s)",
        { s: `%${search}%` }
      );
    }

    // 6. Sorting
    const sortBy = q?.sortBy || "created_at";
    const sortOrder = q?.sortOrder === "ASC" ? "ASC" : "DESC";
    qb.orderBy(`store.${sortBy}`, sortOrder);

    // 7. Pagination
    const [records, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const sanitizedRecords = records.map((record) => ({
      ...record,
      credentials: record.credentials
        ? {
          apiKey: record.credentials?.apiKey || '',
        }
        : null,
    }));

    return {
      total_records: total,
      current_page: page,
      total_pages: Math.ceil(total / limit),
      per_page: limit,
      records: sanitizedRecords,
    };
  }

  async listWithCredentials(me: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const stores = await this.storesRepo.find({
      where: { adminId },
      order: { created_at: "DESC" }
    });

    const records = await Promise.all(
      stores.map(async (store) => await this.getMaskedStoreIntegrations(store))
    );

    return {
      total_records: records.length,
      records,
    };
  }


  async get(me: any, id: string) {
    const store = await this.getStoreById(me, id);
    return this.getMaskedStoreIntegrations(store);
  }

  async getStoreById(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(this.translations.t('domains.stores.not_found'));
    return store;
  }

  private extractDomain(url: string): string {
    try {
      let formattedUrl = url.trim().toLowerCase();
      if (!formattedUrl.startsWith('http')) {
        formattedUrl = `https://${formattedUrl}`;
      }

      const parsedUrl = new URL(formattedUrl);
      let domain = parsedUrl.hostname;

      return domain.replace(/^www\./, '');
    } catch (error) {
      return url.trim().toLowerCase().split('/')[0];
    }
  }

  async create(me: any, dto: CreateStoreDto) {
    const adminId = tenantId(me);

    // 1. Uniqueness Checks (Code must be unique for this admin)
    // const existingStore = await this.storesRepo.findOne({
    //   where: { adminId, code: dto.code }
    // });

    // if (existingStore) {
    //   throw new BadRequestException(`Store code "${dto.code}" is already in use.`);
    // }

    const p = this.getProvider(dto.provider);

    // 2. Map & Trim Credentials (provider-specific)
    const baseCredentials = {
      apiKey: dto.credentials.apiKey?.trim(),
      clientSecret: dto.credentials.clientSecret?.trim(),
      webhookCreateOrderSecret: dto.credentials.webhookCreateOrderSecret?.trim(),
      webhookUpdateStatusSecret: dto.credentials.webhookUpdateStatusSecret?.trim(),
      webhookSecret: dto.credentials.webhookSecret?.trim(),
    };

    // For WooCommerce, always generate webhook secrets on the backend and ignore any incoming values
    const credentials =
      dto.provider === StoreProvider.WOOCOMMERCE
        ? {
          apiKey: baseCredentials.apiKey,
          clientSecret: baseCredentials.clientSecret,
          webhookCreateOrderSecret: this.generateSecret(),
          webhookUpdateStatusSecret: this.generateSecret(),
        }
        : baseCredentials;

    if (!credentials.apiKey) {
      throw new BadRequestException(this.translations.t('domains.stores.api_key_required'));
    }

    // 3. Transactional Save & Connection Validation
    return await this.dataSource.transaction(async (manager) => {
      const validateConnection = p.code !== StoreProvider.SHOPIFY;

      const store = manager.create(StoreEntity, {
        adminId,
        name: dto.name.trim(),
        externalStoreId: p.code === StoreProvider.WOOCOMMERCE ? this.extractDomain(dto.storeUrl) : null,
        storeUrl: dto.storeUrl.trim(),
        provider: dto.provider,
        credentials, // Direct jsonb assignment
        isActive: validateConnection,
        syncNewProducts: dto.syncNewProducts,
        syncRemoteProducts: dto.syncRemoteProducts,
        isIntegrated: validateConnection,
        syncStatus: SyncStatus.PENDING,
      });

      const savedStore = await manager.save(store);

      // 4. Validate Provider Connection
      // If the API key is wrong, this throws and rolls back the save
      if (validateConnection) {
        try {
          const isAuth = await p.validateProviderConnection(savedStore);
          if (!isAuth) {
            throw new BadRequestException(
              this.translations.t('domains.stores.authentication_failed_provider', { args: { providerName: p.displayName } })
            );
          }
        } catch (error: any) {
          this.logger.error(`Validation failed for ${dto.provider}: ${error.message}`);
          //the message too long
          throw new BadRequestException(
            dto.provider === StoreProvider.SHOPIFY
              ? `Unable to validate the Shopify connection. Please install the app and verify your credentials and store URL.`
              : `Unable to validate the connection to ${p.displayName}. Please verify your credentials and settings.`
          );
        }
      }

      // Return the store without sensitive keys in the response
      return {
        ok: true,
        id: savedStore.id,
        name: savedStore.name,
        // code: savedStore.code,
        provider: savedStore.provider,
        isActive: savedStore.isActive,
        // You can still use a masker if you want to show '****' on the frontend
        credentialsConfigured: true
      };
    });
  }



  async upsertIntegrate(me: any, dto: IntegrateDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const store = await this.storesRepo.findOne({ where: { adminId, provider: dto.provider } });

    if (store) {
      store.name = dto.name.trim();
      store.storeUrl = dto.storeUrl.trim();
      store.syncNewProducts = dto.syncNewProducts;
      store.syncRemoteProducts = dto.syncRemoteProducts;
      store.credentials = {
        ...store.credentials,
        ...dto.credentials,
      };
      return this.storesRepo.save(store);
    }

    const storeToSave = {
      adminId,
      name: dto.name.trim(),
      storeUrl: dto.storeUrl.trim(),
      provider: dto.provider,
      credentials: {
        apiKey: null,
        clientSecret: null,
        webhookCreateOrderSecret: null,
        webhookUpdateStatusSecret: null,
        webhookSecret: null,
        ...dto.credentials,
      },
      isIntegrated: false,
      isActive: false,
      syncNewProducts: dto.syncNewProducts,
      syncRemoteProducts: dto.syncRemoteProducts,

    };

    const savedStore = await this.storesRepo.save(storeToSave);
    return savedStore;
  }


  async cancelIntegration(me: any, provider: StoreProvider) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const store = await this.storesRepo.findOne({ where: { adminId, provider } });

    if (!store) {
      throw new BadRequestException(this.translations.t('domains.stores.store_not_found'));
    }

    const p = this.getProvider(provider);
    await p.cancelIntegration(adminId);
    store.isActive = false;
    store.isIntegrated = false;
    store.credentials = {};
    await this.storesRepo.save(store);
    return {
      ok: true,
    }
  }

  async regenerateWebhookSecrets(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(this.translations.t('domains.stores.not_found'));
    if (store.provider !== StoreProvider.WOOCOMMERCE) {
      throw new BadRequestException(this.translations.t('domains.stores.woocommerce_only_webhook_regeneration'));
    }
    store.credentials = {
      ...(store.credentials || {}),
      webhookCreateOrderSecret: this.generateSecret(),
      webhookUpdateStatusSecret: this.generateSecret(),
    };

    await this.storesRepo.save(store);
    await this.clearStoreCache(store.id)
    const { webhookCreateOrderSecret, webhookUpdateStatusSecret } = store.credentials;

    return {
      webhookCreateOrderSecret,
      webhookUpdateStatusSecret,
    };
  }

  async update(me: any, id: string, dto: UpdateStoreDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));
    // Find the existing store
    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(this.translations.t('domains.stores.not_found'));

    const p = this.getProvider(store.provider);
    return await this.dataSource.transaction(async (manager) => {

      if (dto.name) store.name = dto.name.trim();
      if (dto.storeUrl) store.storeUrl = dto.storeUrl.trim();
      if (dto.syncNewProducts !== undefined) store.syncNewProducts = dto.syncNewProducts;
      if (dto.syncRemoteProducts !== undefined) store.syncRemoteProducts = dto.syncRemoteProducts;
      if (dto.isActive !== undefined) store.isActive = dto.isActive;
      if (p.code === StoreProvider.WOOCOMMERCE) store.externalStoreId = this.extractDomain(store.storeUrl)

      // Handle Credentials Update
      if (dto.credentials) {
        const updatedCredentials: any = {
          ...(store.credentials || {}),
          ...(dto.credentials.apiKey && { apiKey: dto.credentials.apiKey.trim() }),
          ...(dto.credentials.clientSecret && { clientSecret: dto.credentials.clientSecret.trim() }),
          ...(dto.credentials.webhookSecret && { webhookSecret: dto.credentials.webhookSecret.trim() }),
        };

        // Only allow updating webhookCreateOrderSecret / webhookUpdateStatusSecret for non-WooCommerce providers
        if (store.provider !== StoreProvider.WOOCOMMERCE) {
          if (dto.credentials.webhookCreateOrderSecret) {
            updatedCredentials.webhookCreateOrderSecret = dto.credentials.webhookCreateOrderSecret.trim();
          }
          if (dto.credentials.webhookUpdateStatusSecret) {
            updatedCredentials.webhookUpdateStatusSecret = dto.credentials.webhookUpdateStatusSecret.trim();
          }
        }

        store.credentials = updatedCredentials;

      }
      if (dto.credentials || dto.isActive)
        try {
          const isAuth = await p.validateProviderConnection(store);

          if (!isAuth) {
            throw new BadRequestException(
              this.translations.t('domains.stores.authentication_failed_provider', { args: { providerName: p.displayName } })
            );
          }
        } catch (error) {
          throw new BadRequestException(
            store.provider === StoreProvider.SHOPIFY
              ? this.translations.t('domains.stores.shopify_validation_failed')
              : this.translations.t('domains.stores.connection_validation_failed_provider', { args: { providerName: p.displayName } })
          );
        }


      // 4. Update standard fields (with trimming)

      const savedStore = await manager.save(store);

      // 5. Cleanup
      await this.clearStoreCache(savedStore.id);

      return {
        ok: true,
        id: savedStore.id,
        // Masking logic if needed for the response
        credentialsConfigured: !!savedStore.credentials?.apiKey,
      };
    });
  }


  async remove(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(this.translations.t('domains.stores.not_found'));

    const removedStore = await this.storesRepo.remove(store);
    await this.clearStoreCache(store.id);
    return this.getMaskedStoreIntegrations(removedStore);
  }

  async getMaskedStoreIntegrations(store: StoreEntity) {
    const masked: Record<string, string> = {};
    const credentials = store.credentials || {};

    const SENSITIVE_KEYS = ["clientSecret", "apiKey"];

    Object.keys(credentials).forEach((key) => {
      const value = credentials[key as keyof typeof credentials];

      if (value && SENSITIVE_KEYS.includes(key)) {
        masked[key] =
          value.length > 8
            ? `${value.substring(0, 4)}****************${value.slice(-4)}`
            : "****************";
      } else {
        // Return non-sensitive values as-is
        masked[key] = value;
      }
    });


    // We no longer need to destructure encryptedData, tag, or iv
    // Just return the store data with the masked credentials
    return {
      id: store.id,
      adminId: store.adminId,
      name: store.name,
      storeUrl: store.storeUrl,
      // code: store.code,
      provider: store.provider,
      isActive: store.isActive,
      syncStatus: store.syncStatus,
      lastSyncAttemptAt: store.lastSyncAttemptAt,
      isIntegrated: store.isIntegrated,
      syncNewProducts: store.syncNewProducts,
      syncRemoteProducts: store.syncRemoteProducts,
      created_at: store.created_at,
      updated_at: store.updated_at,
      credentials: masked // Renamed for frontend consistency
    };
  }

  async syncCategoryToAllStores(category: CategoryEntity, slug?: string) {
    const { adminId, name, id } = category;

    // Get active stores
    const activeStores = await this.storesRepo.find({
      where: { adminId, isActive: true, isIntegrated: true }
    });

    if (activeStores.length === 0) {
      this.logger.warn(`[Category Sync] No active stores found for Admin ${adminId}. Skipping.`);
      return;
    }
    //  Queue the jobs
    const promises = activeStores.map(store => {
      // We pass store.provider directly to our unified queue service
      return this.productSyncQueueService.enqueueCategorySync(
        category,
        store.id,
        store.provider, // Pass the provider (e.g., 'shopify')
        slug
      );
    });

    await Promise.all(promises);
    this.logger.log(
      `[Category Sync] Dispatched jobs for Category: "${name}" (ID: ${id}) ` +
      `to ${activeStores.length} stores for Admin: ${adminId}. ` +
      `${slug ? `(Slug change detected from: ${slug})` : ''}`
    );
  }

  async syncProductToStore(product: ProductEntity, auto?: boolean) {
    const { storeId, adminId, name, id } = product;
    if (!storeId) return;

    // Get active stores
    const store = await this.storesRepo.findOne({
      where: { id: storeId, adminId, isActive: true, isIntegrated: true }
    });

    if (!store) {
      this.logger.warn(`[Product Sync] No active store found (ID: ${storeId}) for Product: "${name}". Skipping.`);
      return;
    }

    if (!store.syncNewProducts && auto) {
      this.logger.warn(`[Product Sync] Store ${storeId} is not set to sync new products. Skipping.`);
      return;
    }

    if (!product?.isActive) {
      this.logger.log(`[Bundle Sync] Skipped inactive product`);
      return;
    }
    // Route to the correct queue based on Provider
    await this.productSyncQueueService.enqueueProductSync(product.id, product.adminId, store.id, store.provider);
    this.logger.log(
      `[Product Sync] Dispatched sync job for Product: "${name}" (ID: ${id}) ` +
      `to Store: "${store.name}" (ID: ${store.id}) for Admin: ${adminId}. `
    );
  }

  async syncBundleToStore(bundle: BundleEntity,
    oldBundleData: oldBundleDataDto
  ) {
    const { storeId, adminId, name, id } = bundle;
    if (!storeId) return;

    // Get active stores
    const store = await this.storesRepo.findOne({
      where: { id: storeId, adminId, isActive: true, isIntegrated: true }
    });

    if (!store) {
      this.logger.warn(`[Bundle Sync] No active store found (ID: ${storeId}) for Bundle: "${name}". Skipping.`);
      return;
    }

    if (!bundle.isActive) {
      this.logger.log(`[Bundle Sync] Skipped inactive bundle`);
      return;
    }

    // Route to the correct queue based on Provider
    await this.productSyncQueueService.enqueueBundleSync(bundle.id, bundle.adminId, store.id, store.provider, oldBundleData);
    this.logger.log(
      `[Bundle Sync] Dispatched sync job for Bundle: "${name}" (ID: ${id}) ` +
      `to Store: "${store.name}" (ID: ${store.id}) for Admin: ${adminId}.`
    );

  }

  async syncOrderStatus(orderId: string, newStatusId: string, oldStatusId: string) {
    const order = await this.orderRepo.findOne({
      where: { id: orderId },
      relations: ['store'],
    });


    if (!order.store) {
      this.logger.warn(`[Order Status Sync] No active store found to sync Order #${order.id} for Admin ${order.adminId}.`);
      return;
    }

    const store = await this.storesRepo.findOne({
      where: { adminId: order.adminId, isActive: true, isIntegrated: true, provider: order.store.provider }
    });

    if (!store) {
      this.logger.warn(`[Order Status Sync] No active store found to sync Order #${order.id} for Admin ${order.adminId}.`);
      return;
    }

    // Route to the correct queue based on Provider

    await this.orderSyncQueueService.enqueueOrderStatusSync(order, store.id, store.provider, newStatusId, oldStatusId);

    this.logger.log(
      `[Order Status Sync] Dispatched status update for Order #${order.id} (ID: ${orderId}) ` +
      `to Store: "${store.name}" (ID: ${store.id}) for Admin: ${order.adminId}.`
    );

  }

  async manualSync(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) {
      throw new NotFoundException(
        this.translations.t('domains.stores.store_id_not_found', { args: { id } })
      );
    }

    if (!store.isActive) {
      throw new BadRequestException(this.translations.t('domains.stores.cannot_sync_inactive'));
    }

    if (!store.isIntegrated) {
      throw new BadRequestException(
        this.translations.t('domains.stores.store_not_integrated', { args: { storeName: store.name.trim() } })
      );
    }

    if (store.localSyncStatus === SyncStatus.SYNCING) {
      throw new BadRequestException(this.translations.t('domains.stores.cannot_sync_already_syncing'));
    }


    // Route to the correct queue based on Provider
    await this.productSyncQueueService.enqueueFullStoreSync(store);

    this.logger.log(
      `[Manual Full Sync] Dispatched full catalog sync for Store: "${store.name}" (ID: ${id}) ` +
      `initiated by Admin: ${adminId}.`
    );

    return {
      message: this.translations.t('domains.stores.sync_job_queued', { args: { storeName: store.name } }),
      storeId: id
    };
  }

  async manualSyncFromStore(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) {
      throw new NotFoundException(
        this.translations.t('domains.stores.store_id_not_found', { args: { id } })
      );
    }

    if (!store.isActive) {
      throw new BadRequestException(this.translations.t('domains.stores.cannot_sync_inactive'));
    }

    if (!store.isIntegrated) {
      throw new BadRequestException(
        this.translations.t('domains.stores.store_not_integrated', { args: { storeName: store.name.trim() } })
      );
    }

    if (store.syncStatus === SyncStatus.SYNCING) {
      throw new BadRequestException(this.translations.t('domains.stores.cannot_sync_already_syncing'));
    }


    await this.storesRepo.update(store.id, {
      syncStatus: SyncStatus.SYNCING,
      lastSyncAttemptAt: new Date()
    });


    // Route to the correct queue based on Provider
    await this.productSyncQueueService.enqueueFullProductSyncLocally(adminId, store.provider);

    this.logger.log(
      `[Manual Full Sync] Dispatched full catalog sync for Store: "${store.name}" (ID: ${id}) ` +
      `initiated by Admin: ${adminId}.`
    );

    return {
      message: this.translations.t('domains.stores.sync_job_queued', { args: { storeName: store.name } }),
      storeId: id
    };
  }

  async manualSyncSpecificProducts(me: any, id: string, productIds: string[]) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    if (!productIds || productIds.length === 0) {
      throw new BadRequestException(this.translations.t('domains.stores.no_products_provided'));
    }

    if (productIds.length > 50) {
      throw new BadRequestException(this.translations.t('domains.stores.max_products_exceeded'));
    }

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) {
      throw new NotFoundException(
        this.translations.t('domains.stores.store_id_not_found', { args: { id } })
      );
    }

    if (!store.isActive) {
      throw new BadRequestException(this.translations.t('domains.stores.cannot_sync_inactive'));
    }

    if (!store.isIntegrated) {
      throw new BadRequestException(
        this.translations.t('domains.stores.store_not_integrated', { args: { storeName: store.name.trim() } })
      );
    }

    // We don't necessarily block partial sync if a full sync is running, 
    // but it's safer to check.
    if (store.localSyncStatus === SyncStatus.SYNCING) {
      throw new BadRequestException(this.translations.t('domains.stores.cannot_sync_already_syncing'));
    }

    await this.productSyncQueueService.enqueueFullStoreSync(store, productIds);

    this.logger.log(
      `[Manual Partial Sync] Dispatched sync for ${productIds.length} products in Store: "${store.name}" (ID: ${id}) ` +
      `initiated by Admin: ${adminId}.`
    );

    return {
      message: this.translations.t('domains.stores.partial_sync_job_queued', { args: { count: productIds.length, storeName: store.name } }),
      storeId: id
    };
  }

  private async logFailedWebhookOrder(
    adminId: string,
    store: StoreEntity,
    rawPayload: any,
    payload: WebhookOrderPayload,
    reason?: string,
    externalOrderId?: string,
    customerName?: string,
    phoneNumber?: string,
  ) {

    const existingFailure = await this.failureRepo.findOne({
      where: {
        adminId,
        storeId: store?.id,
        externalOrderId: externalOrderId || null,
      }
    })

    if (existingFailure) {
      existingFailure.attempts += 1;
      await this.failureRepo.save(existingFailure);
      return existingFailure;
    }

    const record = this.failureRepo.create({
      adminId,
      storeId: store?.id,
      rawPayload: rawPayload,
      payload,
      reason,
      externalOrderId,
      customerName,
      phoneNumber,
    });
    const created = await this.failureRepo.save(record);
    this.logger.warn(`[Webhook Order Failure] recorded for admin ${adminId} store ${store?.id} reason=${reason}`);
    await this.notificationService.create({
      userId: adminId,
      type: NotificationType.ORDER_CREATTION_FAILED,
      title: await this.requestTranslations.tAsync('domains.stores.order_creation_failed_title', adminId),
      message: await this.requestTranslations.tAsync('domains.stores.order_creation_failed_message', adminId, {
        args: { storeName: store.name, reason }
      }),
      relatedEntityType: "webhook_order_failures",
      relatedEntityId: String(created.id),
    });
    return record;
  }

  /**
   * Resolves a webhook cart line to a local variant.
   * Uses product sync state first; optional SKU fallback when enabled and no sync link exists.
   */
  private async resolveWebhookCartLineItem(
    manager: EntityManager,
    adminId: string,
    item: WebhookOrderPayload['cartItems'][number],
    productMap: Map<string, ProductEntity>,
    skuFallbackEnabled: boolean,
  ): Promise<{ variantId: string; quantity: number; unitPrice: number; unitCost: number }> {
    const pvRepo = manager.getRepository(ProductVariantEntity);

    const sku = item.variant?.sku?.trim();

    const findVariantBySku = async (): Promise<ProductVariantEntity | null> => {
      if (!skuFallbackEnabled || !sku) return null;

      return await pvRepo
        .createQueryBuilder('v')
        .innerJoinAndSelect('v.product', 'p')
        .where('v.sku = :sku', { sku })
        .andWhere('p.adminId = :adminId', { adminId })
        .getOne();
    };

    let localProduct = productMap.get(item.remoteProductId);
    let matchedVariant: ProductVariantEntity | null = null;

    // First: try normal ID/key matching
    if (localProduct?.isActive) {
      const key = item.variant.key;

      matchedVariant =
        localProduct.variants.find(
          v => v.key === key && v.isActive,
        ) || null;
    }

    // Fallback to SKU if:
    // - product not found
    // - product inactive
    // - variant not found
    // - variant inactive
    if (!matchedVariant) {
      matchedVariant = await findVariantBySku();

      if (matchedVariant?.product) {
        localProduct = matchedVariant.product;
      }
    }

    if (!localProduct) {
      throw new BadRequestException(
        this.translations.t('domains.stores.product_not_found_in_system', { args: { itemName: item.name } })
      );
    }

    if (!localProduct.isActive) {
      throw new BadRequestException(
        this.translations.t('domains.stores.product_not_active', { args: { itemName: item.name } })
      );
    }

    if (!matchedVariant) {
      throw new BadRequestException(
        this.translations.t('domains.stores.variant_not_found', { args: { itemName: item.name } })
      );
    }

    if (!matchedVariant.isActive) {
      throw new BadRequestException(
        this.translations.t('domains.stores.variant_not_active', { args: { itemName: item.name } })
      );
    }

    return {
      variantId: matchedVariant.id,
      quantity: item.quantity,
      unitPrice: item.price,
      unitCost: 0,
    };
  }

  private async processMappedWebhookOrder(
    adminId: string,
    store: StoreEntity,
    payload: WebhookOrderPayload,
    rawBody: any,
    isWebhook = false,
    failureLog?: WebhookOrderFailureEntity,
    manager?: EntityManager,

  ): Promise<{ ok: boolean; ignored?: boolean; reason?: string; orderId?: string }> {

    try {
      const runInTransaction = async (work: (em: EntityManager) => Promise<any>) => {
        if (manager) return work(manager);
        return this.dataSource.transaction(work);
      };
      return await runInTransaction(async (manager) => {
        const p = this.getProvider(store.provider);
        const proccessedExternalOrderId = p.normalizeOrderId(payload.externalOrderId);
        const existingOrder = await this.ordersService.findByExternalId(proccessedExternalOrderId, adminId);
        if (existingOrder) {
          //notification here
          return { ok: true, ignored: true, reason: 'order_exists' };
        }

        const remoteIds = payload.cartItems.map(item => item.remoteProductId);
        const safeRemoteIds = remoteIds.length > 0 ? remoteIds : [null];

        const syncStates = await manager
          .getRepository(ProductSyncStateEntity)
          .createQueryBuilder('state')
          .innerJoinAndSelect('state.product', 'product', 'product.isActive = true')
          .leftJoinAndSelect('product.variants', 'variants')
          .where('state.adminId = :adminId', { adminId })
          .andWhere('state.storeId = :storeId', { storeId: store.id })
          .andWhere('state.externalStoreId = :externalStoreId', {
            externalStoreId: store.externalStoreId,
          })
          .andWhere('state.remoteProductId IN (:...safeRemoteIds)', { safeRemoteIds })
          .getMany();

        const productMap = new Map(
          syncStates?.filter(s => s.remoteProductId).map(s => [s?.remoteProductId, s?.product])
        );

        const settings = await this.clientSettingsService.getCachedSettings(
          adminId,
        );
        const skuFallbackEnabled = settings?.storeOrderSkuFallback !== false;

        const items = [];
        for (const item of payload.cartItems) {
          const line = await this.resolveWebhookCartLineItem(
            manager,
            adminId,
            item,
            productMap,
            skuFallbackEnabled,
          );
          items.push(line);
        }

        //  Create Order
        const createOrderDto: CreateOrderDto = {
          customerName: payload.fullName,
          phoneNumber: payload.phone,
          address: payload.address,
          city: payload.government || "Unknown",
          paymentMethod: payload.paymentMethod,
          paymentStatus: payload.paymentStatus,
          shippingCost: payload.shippingCost || 0,
          shippingCompanyId: null,
          discount: 0,
          items: items,
          // notes: `Imported from ${p.displayName}) via Webhook`,
          storeId: String(store.id),
        };

        const User = { id: store.adminId, role: { name: 'admin' } };

        const newOrder = await this.ordersService.createWithManager(manager, adminId, User, createOrderDto);
        await this.ordersService.updateExternalId(newOrder.id, payload.externalOrderId);
        await manager.update(OrderEntity, newOrder.id, { externalId: payload.externalOrderId });

        this.logger.log(`[Webhook Order Create] Created new order from webhook with External ID ${payload.externalOrderId} mapped to Internal Order #${newOrder.orderNumber} (ID: ${newOrder.id}).`);
        await this.notificationService.create({
          userId: adminId,
          type: NotificationType.ORDER_CREATED,
          title: await this.requestTranslations.tAsync('domains.stores.new_order_created_title', adminId),
          message: await this.requestTranslations.tAsync('domains.stores.new_order_created_message', adminId, {
            args: { orderNumber: newOrder.orderNumber, storeName: store.name }
          }),
          relatedEntityType: "order",
          relatedEntityId: String(newOrder.id),
        });

        return { ok: true, orderId: newOrder.id };
      });
    } catch (error: any) {
      const errorMessage = getErrorMessage(error);
      this.logger.error(`[Webhook Order Create] Error processing webhook order: ${errorMessage}`, error.stack);
      if (failureLog) {

        failureLog.status = OrderFailStatus.FAILED;
        failureLog.lastRetryFailedReason = errorMessage;
        await this.failureRepo.save(failureLog);
        if (!isWebhook) {
          await this.notificationService.create({
            userId: adminId,
            type: NotificationType.ORDER_CREATTION_FAILED,
            title: await this.requestTranslations.tAsync('domains.stores.retry_order_failed_title', adminId),
            message: await this.requestTranslations.tAsync('domains.stores.retry_order_failed_message', adminId, {
              args: { storeName: store.name, errorMessage }
            }),
            relatedEntityType: "webhook_order_failures",
            relatedEntityId: String(failureLog.id),
          });
        }
      } else {

        const externalId = payload?.externalOrderId || 'UNKNOWN';
        const customerName = payload?.fullName?.trim() || 'N/A';
        await this.logFailedWebhookOrder(
          adminId,
          store,
          rawBody,
          payload,
          `${errorMessage}`,
          externalId,
          customerName,
          payload?.phone
        );
      }
      return { ok: false, ignored: true, reason: 'processing_error' };
    }
  }

  async handleWebhookOrderCreate(provider: string, body: any, headers: Record<string, any>, adminId: string, req: any) {
    this.logger.log(`[Webhook Order Create] Received webhook order create for provider=${provider}`);
    const p = this.getProvider(provider);
    //notification here

    const store = await this.storesRepo.findOne({ where: { provider: p.code, adminId } });
    if (!store) {
      return { ok: true, ignored: true, reason: 'store_not_found' };
    }

    if (!store.isActive || !store.isIntegrated) {
      return { ok: true, ignored: true, reason: 'store_not_active' };
    }

    if (store.provider !== p.code) {
      return { ok: true, ignored: true, reason: 'provider_mismatched' };
    }

    const isAuthed = p.verifyWebhookAuth(headers, body, store, req, "create");
    if (!isAuthed) {
      return { ok: true, ignored: true, reason: 'auth_failed' };
    }

    const payload = await p.mapWebhookCreate(body, store);
    return this.processMappedWebhookOrder(adminId, store, payload, body, true);
  }

  async handleWebhookOrderUpdate(
    provider: string,
    body: any,
    headers: Record<string, any>,
    adminId: string,
    req: any
  ) {
    try {
      const p = this.getProvider(provider);

      const externalId = await p.processExternalOrderId(body, headers);
      const externalOrderId = p.normalizeOrderId(externalId);

      if (!externalOrderId) {
        throw new Error(`Unknown order`);
      }

      const order = await this.ordersService.findByExternalId(externalOrderId, adminId);

      if (!order) {
        throw new Error(`Unknown order`);
      }
      const payload =
        p.mapWebhookUpdate(
          body,
          order?.status?.code as OrderStatus,
          headers,
        ) || ({} as ReturnType<typeof p.mapWebhookUpdate>);

      if (!order.storeId) {
        throw new Error(`Order ${order.orderNumber} has no storeId`);
      }

      const store = await this.storesRepo.findOne({ where: { id: order.storeId } });

      if (!store) {
        throw new Error(`Store ${order.storeId} not found`);
      }

      if (!store.isActive) {
        throw new Error(`Store ${store.name} is not active`);
      }

      if (store.provider !== p.code) {
        throw new Error(
          `Provider mismatch: expected ${p.code}, got ${store.provider}`
        );
      }

      const isAuthed = p.verifyWebhookAuth(headers, body, store, req, "update");

      if (!isAuthed) {
        throw new Error(`Webhook authentication failed`);
      }

      // ✅ mapping validation
      if (!payload.mappedStatus && !payload.mappedPaymentStatus) {
        return;
      }

      const isOrderStatusChanged =
        payload.mappedStatus &&
        order.status?.code !== payload.mappedStatus;

      const isPaymentStatusChanged =
        payload.mappedPaymentStatus &&
        order.paymentStatus !== payload.mappedPaymentStatus;

      if (!isOrderStatusChanged && !isPaymentStatusChanged) {
        this.logger.log(
          `[Webhook Order Update] No changes for Order #${order.orderNumber}`
        );
        return;
      }

      // 🟡 Order status
      if (isOrderStatusChanged) {
        const statusEntity = await this.ordersService.findStatusByCode(
          payload.mappedStatus,
          order.adminId.toString()
        );

        if (!statusEntity) {
          throw new Error(
            `Mapped status "${payload.mappedStatus}" not found`
          );
        }

        const User = { id: order.adminId.toString(), role: { name: "admin" } };

        await this.ordersService.changeStatus(User, order.id, {
          statusId: statusEntity.id,
          notes: payload.note || `Updated via webhook`,
          postponedDate: payload.postponedDate ? new Date(payload.postponedDate)?.toISOString() || null : null,
        });

      }

      // 💰 Payment status
      if (isPaymentStatusChanged) {
        order.paymentStatus = payload.mappedPaymentStatus;
        await this.ordersRepo.save(order);

        await this.notificationService.create({
          userId: order.adminId.toString(),
          type: NotificationType.ORDER_UPDATED,
          title: await this.requestTranslations.tAsync('domains.stores.order_payment_status_updated_title', adminId),
          message: await this.requestTranslations.tAsync('domains.stores.order_payment_status_updated_message', adminId, {
            args: { orderNumber: order.orderNumber, status: payload.mappedPaymentStatus }
          }),
          relatedEntityType: "order",
          relatedEntityId: String(order.id),
        });
      }

    } catch (error: any) {
      const message = getErrorMessage(error);

      this.logger.error(
        `[Webhook Order Update Failed] ${message}`,
        error?.stack
      );

      // 🔥 notify admin
      // await this.notificationService.create({
      //   userId: adminId,
      //   type: NotificationType.SYSTEM_ERROR,
      //   title: await this.requestTranslations.tAsync('domains.stores.webhook_order_update_failed_title', adminId),
      //   message: await this.requestTranslations.tAsync('domains.stores.webhook_order_update_failed_message', adminId, {
      //     args: { error: message }
      //   }),
      //   relatedEntityType: "webhook",
      //   relatedEntityId: provider,
      // });

      return; // ✅ prevent crash / webhook retry storm
    }
  }

  async listFailedOrders(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);

    const sortBy = String(q?.sortBy ?? "createdAt");
    const sortDir: "ASC" | "DESC" =
      String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

    const qb = this.failureRepo
      .createQueryBuilder("failure")
      .where("failure.adminId = :adminId", { adminId })
      .leftJoinAndSelect("failure.store", "store");

    const sortColumns: Record<string, string> = {
      createdAt: "failure.created_at",
    };

    if (q?.search) {
      const searchTerm = `%${q.search}%`;
      qb.andWhere(
        "(failure.customerName ILIKE :searchTerm OR failure.phoneNumber ILIKE :searchTerm OR failure.externalOrderId ILIKE :searchTerm)",
        { searchTerm }
      );
    }

    // Filters
    if (q?.storeId) qb.andWhere("failure.storeId = :storeId", { storeId: q.storeId });

    // Date range
    DateFilterUtil.applyToQueryBuilder(qb, "failure.created_at", q?.startDate, q?.endDate);

    if (q?.status) qb.andWhere("failure.status = :status", { status: String(q.status) });

    if (sortColumns[sortBy]) {
      qb.orderBy(sortColumns[sortBy], sortDir);
    } else {
      qb.orderBy("failure.created_at", "DESC"); // fallback
    }

    const total = await qb.getCount();
    const records = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }


  async getFailedOrderDetail(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));


    const failure = await this.failureRepo.findOne({
      where: { id, adminId },
      relations: ['store'],
    });

    if (!failure) {
      throw new NotFoundException(this.translations.t('domains.stores.failed_order_retry_not_found'));
    }

    const storeId = failure.store?.id;
    const payload = failure.payload;
    const problems = [];

    const retrySettings = await this.clientSettingsService.getCachedSettings(
      adminId,
    );
    const skuFallbackEnabled = retrySettings?.storeOrderSkuFallback !== false;


    if (payload && payload.cartItems) {
      const remoteIds = payload.cartItems.map(item => String(item.remoteProductId));
      //
      const syncStates = await this.productSyncStateRepo
        .createQueryBuilder('state')
        .innerJoinAndSelect('state.product', 'product', 'product.isActive = true')
        .leftJoinAndSelect('product.variants', 'variants')
        .where('state.adminId = :adminId', { adminId })
        .andWhere('state.storeId = :storeId', { storeId: storeId })
        .andWhere('state.externalStoreId = :externalStoreId', {
          externalStoreId: failure?.store.externalStoreId,
        })
        .andWhere('state.remoteProductId IN (:...remoteIds)', { remoteIds })
        .getMany();

      const productMap = new Map(syncStates.map(s => [s.remoteProductId, s.product]));

      for (const item of payload.cartItems) {
        const sku = item.variant?.sku?.trim();

        let localProduct = productMap.get(item.remoteProductId);
        let matchedVariant = null;
        let matchedBySku = false;

        if (localProduct?.isActive) {
          matchedVariant =
            localProduct.variants.find(
              v => v.key === item.variant.key,
            ) || null;
        }

        if (!matchedVariant && sku && skuFallbackEnabled) {
          matchedVariant = await this.pvRepo
            .createQueryBuilder('v')
            .innerJoinAndSelect('v.product', 'p')
            .where('v.sku = :sku', { sku })
            .andWhere('p.adminId = :adminId', { adminId })
            .getOne();

          if (matchedVariant?.product) {
            localProduct = matchedVariant.product;
            matchedBySku = true;
          }
        }


        if (!localProduct || !localProduct?.isActive) {
          problems.push({
            remoteId: item.remoteProductId,
            key: item?.variant?.key,
            slug: item.productSlug,
            name: item.name,
            code: WebhookOrderProblem.PRODUCT_NOT_FOUND,
            problem: this.translations.t('domains.stores.problem_product_not_found', { args: { name: item.name } }),
            details: this.translations.t('domains.stores.problem_product_not_found_details', { args: { name: item.name } }),
          });
          continue;
        }

        if (!localProduct?.isActive) {
          problems.push({
            remoteId: item.remoteProductId,
            key: item?.variant?.key,
            slug: item.productSlug,
            name: item.name,
            code: WebhookOrderProblem.PRODUCT_INACTIVE,
            problem: this.translations.t('domains.stores.problem_product_inactive', { args: { name: item.name } }),
            details: this.translations.t('domains.stores.problem_product_inactive_details', { args: { name: item.name } }),
          });
          continue;
        }


        // Add local product ID to the item's variant for the UI/frontend
        if (!item.variant) item.variant = {};
        (item.variant as any).localProductId = localProduct.id;
        (item.variant as any).matchedBySku = matchedBySku;


        if (!matchedVariant) {
          problems.push({
            remoteId: item.remoteProductId,
            key: item?.variant?.key,
            productId: localProduct.id,
            slug: item.productSlug,
            name: item.name,
            code: WebhookOrderProblem.SKU_NOT_FOUND,
            problem: this.translations.t('domains.stores.problem_variant_not_found', { args: { key: item.variant?.key, slug: item.productSlug } }),
            details: localProduct.type === ProductType.SINGLE
              ? this.translations.t('domains.stores.problem_single_product_no_sku')
              : this.translations.t('domains.stores.problem_variant_missing_details')
          });
          continue;
        }

        if (!matchedVariant?.isActive) {
          problems.push({
            remoteId: item.remoteProductId,
            key: item?.variant?.key,
            productId: localProduct.id,
            slug: item.productSlug,
            name: item.name,
            code: WebhookOrderProblem.SKU_NOT_FOUND,
            problem: this.translations.t('domains.stores.problem_variant_inactive', { args: { name: item.name } }),
            details: this.translations.t('domains.stores.problem_variant_inactive_details', { args: { name: item.name } }),
          });
          continue;
        }

        const availableStock = await this.ordersService.calculateAvailableStock(
          matchedVariant.stockOnHand,
          matchedVariant.reserved,
          matchedVariant.adminId
        );
        if (availableStock < item.quantity) {
          problems.push({
            remoteId: item.remoteProductId,
            productId: localProduct.id,
            key: item?.variant?.key,
            slug: item.productSlug,
            name: item.name,
            sku: matchedVariant.sku,
            code: WebhookOrderProblem.INSUFFICIENT_STOCK,
            problem: this.translations.t('domains.stores.problem_insufficient_stock', { args: { key: item.variant?.key, slug: item.productSlug } }),
            details: this.translations.t('domains.stores.problem_insufficient_stock_details', { args: { quantity: item.quantity, available: availableStock } })
          });
        }
      }
    }

    return {
      failureLog: failure,
      problems
    };
  }

  async updateFailedOrderPayload(me: any, id: string, payload: WebhookOrderPayload) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const failure = await this.failureRepo.findOne({
      where: { id, adminId },
    });

    if (!failure) {
      throw new NotFoundException(this.translations.t('domains.stores.failed_order_not_found'));
    }

    if ([OrderFailStatus.RETRYING, OrderFailStatus.SUCCESS].includes(failure.status as any)) {
      throw new BadRequestException(
        this.translations.t('domains.stores.cannot_update_payload_current_status', {
          args: { status: failure.status },
        }),
      );
    }

    failure.payload = payload;

    // If it was previously failed, move it back to pending so it can be retried
    if (failure.status === OrderFailStatus.FAILED) {
      failure.status = OrderFailStatus.PENDING;
    }

    return await this.failureRepo.save(failure);
  }

  async getFailedOrdersStatistics(me: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const raw = await this.failureRepo
      .createQueryBuilder("failure")
      .select("failure.status", "status")
      .addSelect("COUNT(*)", "count")
      .where("failure.adminId = :adminId", { adminId })
      .groupBy("failure.status")
      .getRawMany();

    // Convert to clean object
    const stats = {
      pending: 0,
      retrying: 0,
      success: 0,
      failed: 0,
      total: 0,
    };

    raw.forEach((row) => {
      stats[row.status] = Number(row.count);
      stats.total += Number(row.count);
    });

    return stats;
  }



  async retryFailedOrder(me: any, failureId: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    return await this.dataSource.transaction(async (manager) => {
      const { failureLog, problems } = await this.getFailedOrderDetail(me, failureId);
      try {
        if (!failureLog || !failureLog.store) {
          throw new NotFoundException(this.translations.t('domains.stores.failed_order_or_store_not_found'));
        }

        if (!failureLog.store.isActive || !failureLog.store.isIntegrated) {
          throw new BadRequestException(
            this.translations.t('domains.stores.store_inactive_or_missing_integration', {
              args: { storeName: failureLog.store.name },
            }),
          );
        }

        if ([OrderFailStatus.RETRYING, OrderFailStatus.SUCCESS].includes(failureLog.status as any)) {
          throw new BadRequestException(
            this.translations.t('domains.stores.cannot_retry_current_status', {
              args: { status: failureLog.status },
            }),
          );
        }

        if (problems.length > 0) {
          const displayed = problems.slice(0, 2).map((p) => p.problem).join(", ");
          const moreCount = problems.length - 2;
          const suffix = moreCount > 0 ? ` +${moreCount}...` : "";

          throw new BadRequestException(
            this.translations.t('domains.stores.cannot_retry_problems', {
              args: { problems: `${displayed}${suffix}` },
            }),
          );
        }

        const store = failureLog.store;
        const payload = failureLog.payload;

        failureLog.status = OrderFailStatus.RETRYING;
        failureLog.attempts += 1;
        await manager.save(failureLog);

        const result = await this.processMappedWebhookOrder(
          adminId,
          store,
          payload,
          failureLog.rawPayload,
          false,
          failureLog,
          manager,
        );

        if (!result.ok) {
          throw new BadRequestException(
            this.translations.t('domains.stores.retry_failed_again', {
              args: { reason: result.reason },
            }),
          );
        } else {
          failureLog.status = OrderFailStatus.SUCCESS;
          await manager.save(failureLog);
        }

        return {
          message: this.translations.t('domains.stores.order_successfully_retried_and_created'),
          orderId: result.orderId || null,
          result,
        };
      } catch (error: any) {
        const errorMessage = getErrorMessage(error);
        failureLog.status = OrderFailStatus.FAILED;
        failureLog.reason = errorMessage;
        await manager.save(failureLog);
        throw error;
      }
    });
  }


  async exportFailedOrders(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const qb = this.failureRepo
      .createQueryBuilder("failure")
      .where("failure.adminId = :adminId", { adminId })
      .leftJoinAndSelect("failure.store", "store");

    if (q?.search) {
      const searchTerm = `%${q.search}%`;
      qb.andWhere(
        "(failure.customerName ILIKE :searchTerm OR failure.phoneNumber ILIKE :searchTerm OR failure.externalOrderId ILIKE :searchTerm)",
        { searchTerm }
      );
    }

    if (q?.storeId) {
      qb.andWhere("failure.storeId = :storeId", {
        storeId: q.storeId,
      });
    }

    if (q?.status) {
      qb.andWhere("failure.status = :status", {
        status: String(q.status),
      });
    }

    DateFilterUtil.applyToQueryBuilder(qb, "failure.created_at", q?.startDate, q?.endDate);

    qb.orderBy("failure.created_at", "DESC");

    const failures = await qb.getMany();

    const exportData = failures.map((f) => ({
      id: f.id,
      store: f.store?.name || this.translations.t("common.not_available"),
      status: f.status,
      reason: f.reason || this.translations.t("common.not_available"),
      createdAt: f.created_at
        ? new Date(f.created_at).toLocaleDateString()
        : this.translations.t("common.not_available"),
    }));

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(
      this.translations.t("domains.stores.failed_orders")
    );

    worksheet.columns = [
      { header: this.translations.t("domains.stores.failure_id"), key: "id", width: 15 },
      { header: this.translations.t("common.store"), key: "store", width: 25 },
      { header: this.translations.t("common.status"), key: "status", width: 15 },
      { header: this.translations.t("common.reason"), key: "reason", width: 40 },
      { header: this.translations.t("common.created_at"), key: "createdAt", width: 20 },
    ];

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };

    exportData.forEach((row) => worksheet.addRow(row));

    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }

  async queueRetryFailedOrder(me: any, failureId: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    // Fetch the failure log to get the store provider
    const { failureLog, problems } = await this.getFailedOrderDetail(me, failureId);

    if (!failureLog || !failureLog.store) {
      throw new NotFoundException(this.translations.t('domains.stores.failure_log_or_store_not_found'));
    }

    if ([OrderFailStatus.RETRYING, OrderFailStatus.SUCCESS].includes(failureLog.status as any)) {
      throw new BadRequestException(
        this.translations.t('domains.stores.cannot_retry_status', { args: { status: failureLog.status } })
      );
    }
    if (!failureLog.store.isActive || !failureLog.store.isIntegrated) {
      throw new BadRequestException(
        this.translations.t('domains.stores.store_inactive_or_missing_integration', { args: { storeName: failureLog.store.name } })
      );
    }

    if (problems.length > 0) {
      const displayed = problems.slice(0, 2).map((p) => p.problem).join(", ");
      const moreCount = problems.length - 2;
      const suffix = moreCount > 0 ? this.translations.t('domains.stores.problems_count_suffix', { args: { count: moreCount } }) : "";

      throw new BadRequestException(
        this.translations.t('domains.stores.cannot_retry_problems', { args: { problems: displayed, suffix } })
      );
    }

    // Enqueue the retry job
    await this.orderSyncQueueService.enqueueRetryFailedOrder(
      adminId,
      failureId,
      failureLog.store.provider
    );

    this.logger.log(`[Queue Retry] Enqueued retry job for failureId=${failureId}, adminId=${adminId}`);

    return {
      message: this.translations.t('domains.stores.retry_job_queued_successfully'),
      failureId,
    };
  }

  /**
 * Generic helper to sync a unified external product payload into the local DB.
 * Uses EasyOrder's reverse-sync logic (category mapping, product upsert, SKU upsert)
 * as the single source of truth for how reverse product sync should behave.
 */
  public async syncExternalProductPayloadToLocal(
    adminId: string,
    store: StoreEntity,
    payload: UnifiedProductDto,
    manager?: EntityManager,
  ): Promise<ProductEntity> {
    const userContext = {
      id: store.adminId,
      adminId: store.adminId,
      role: { name: "admin" },
    };

    const runInTransaction = async (work: (em: EntityManager) => Promise<ProductEntity>) => {
      if (manager) return work(manager);
      return this.dataSource.transaction(work);
    };

    return runInTransaction(async (em) => {
      // 1) Ensure local category exists (by slug) if payload provides category info
      let localCategoryId: string | null = null;
      if (payload.category && payload.category.slug) {
        const categoryRepo = em.getRepository(CategoryEntity);
        let category = await categoryRepo.findOne({
          where: { adminId: userContext.adminId, slug: payload.category.slug },
        });

        if (!category) {
          this.logger.log(
            `[Reverse Sync] Creating new category from external: ${payload.category.name || payload.category.slug}`,
          );
          category = categoryRepo.create({
            adminId: userContext.adminId,
            name: payload.category.name || payload.category.slug,
            slug: payload.category.slug,
            image: payload.category.thumb || null,
          });
          category = await categoryRepo.save(category);
        }
        localCategoryId = category.id;
      }

      const productsRepository = em.getRepository(ProductEntity);
      const mainImage = payload.mainImage || payload.images?.[0] || "";

      // 2) Upsert product by slug + adminId
      let existingProduct = await productsRepository.findOne({
        where: { adminId, slug: payload.slug },
      });

      let savedProduct: ProductEntity;

      if (existingProduct) {
        this.logger.log(`[Reverse Sync] Updating existing product: ${existingProduct.slug}`);

        em.merge(ProductEntity, existingProduct, {
          name: payload.name,
          slug: payload.slug,
          description: payload.description,
          wholesalePrice: payload.basePrice,
          lowestPrice: payload.basePrice,
          storeId: store.id,
          categoryId: localCategoryId,
          mainImage,
        });

        savedProduct = await productsRepository.save(existingProduct);
      } else {
        this.logger.log(`[Reverse Sync] Creating new product: ${payload.slug}`);

        const newProduct = em.create(ProductEntity, {
          name: payload.name,
          slug: payload.slug,
          description: payload.description,
          wholesalePrice: payload.basePrice,
          lowestPrice: payload.basePrice,
          storeId: store.id,
          categoryId: localCategoryId,
          mainImage,
          adminId,
        });

        savedProduct = await productsRepository.save(newProduct);
      }

      // 3) Upsert SKUs/variants if provided
      if (payload.variants && payload.variants.length > 0) {
        const upsertDto: UpsertProductSkusDto = {
          items: payload.variants.map((v, index) => {
            const attributes = v.attributes || {};
            const sku = v.sku || null;

            let key = v.key || this.productsService.canonicalKey(attributes);
            if (!key && sku) {
              key = sku;
            } else if (!key) {
              key = `variant_${payload.slug}_${index}`;
            }

            return {
              key,
              sku,
              price: v.price,
              stockOnHand: v.stockOnHand ?? 0,
              reserved: 0,
              attributes,
            };
          }),
        };

        // Pass manager if available to upsertSkus
        await this.productsService.upsertSkus(userContext, savedProduct.id, upsertDto, em);
      }

      return savedProduct;
    });
  }

  public async saveEasyOrdersCredentials(adminId: string, credentials: EasyOrdersCredentialsDto) {
    const store = await this.storesRepo.findOne({
      where: { adminId, provider: StoreProvider.EASYORDER },
    });
    if (!store) {
      throw new Error(
        this.translations.t('domains.stores.easyorder_store_not_found')
      );
    }

    store.credentials = {
      apiKey: credentials.apiKey,
    };
    store.isActive = true;
    store.isIntegrated = true;
    store.externalStoreId = credentials.storeId;

    const newStore = await this.storesRepo.save(store);;
    if (newStore.syncRemoteProducts) {
      this.productSyncQueueService.enqueueFullProductSyncLocally(adminId, newStore.provider)
    }
    return newStore;
  }

  public async getFullProductById(userContext: any, provider: StoreProvider, id: string) {
    const adminId = tenantId(userContext);
    const store = await this.storesRepo.findOne({
      where: { adminId, provider }
    });
    if (!store) {
      throw new BadRequestException(
        this.translations.t('domains.stores.store_not_found_provider', {
          args: { provider },
        }),
      );
    }

    if (!store.isIntegrated) {
      throw new BadRequestException(
        this.translations.t('domains.stores.store_not_integrated', {
          args: { storeName: store.name.trim() },
        }),
      );

    }
    if (!store.isActive) {
      throw new BadRequestException(
        this.translations.t('domains.stores.store_not_active'),
      );

    }

    const p = this.getProvider(provider)

    try {
      const product = await p.getFullProductById(store, id);
      if (!product) {
        throw new BadRequestException(
          this.translations.t('domains.stores.product_not_found'),
        );

      }
      return { ...product, storeId: store.id };
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;

      const message = error.response?.data?.message || error.message;
      const status = error.response?.status;

      if (status === 429) {
        throw new BadRequestException(
          this.translations.t('domains.stores.provider_rate_limit_hit', {
            args: { provider },
          }),
        );
      }

      throw new BadRequestException(
        this.translations.t('domains.stores.failed_to_fetch_product', {
          args: {
            provider,
            message,
          },
        }),
      );
    }
  }

  public async syncStoreProductsLocally(adminId: string, provider: StoreProvider) {
    const store = await this.storesRepo.findOne({
      where: { adminId, provider }
    });
    if (!store) {
      throw new BadRequestException(`Store not found, provider: ${provider}`);
    }

    if (!store.isIntegrated) {
      throw new BadRequestException(
        this.translations.t('domains.stores.store_not_integrated', {
          args: { storeName: store.name.trim() },
        }),
      );
    }
    if (!store.isActive) {
      throw new BadRequestException(
        this.translations.t('domains.stores.store_not_active'),
      );
    }

    try {


      const p = this.getProvider(provider);
      const remoteProducts = await p.getAllMappedProducts(store);

      let successCount = 0;
      let failedCount = 0;
      let newTotal = 0;
      let newSuccess = 0;
      let newFailed = 0;
      const errors: string[] = [];

      const me = { id: adminId, adminId, role: { name: 'admin' } };
      const purchaseItems: PurchaseItemDto[] = [];
      const allProductsmap = new Map<string, Map<string, number>>();
      for (const remoteProduct of remoteProducts) {
        let isNew = false;
        try {
          const remoteId = String(remoteProduct.id);

          // 1. Check if linked via ProductSyncState
          const syncState = await this.productSyncStateRepo.findOne({
            where: {
              adminId,
              storeId: store.id,
              remoteProductId: remoteId,
              externalStoreId: store.externalStoreId,
              product: {
                isActive: true,
              },
            },
            relations: {
              product: true,
            },
          });
          isNew = !syncState;
          if (isNew) newTotal++;

          let localProduct: any = null;
          if (syncState) {
            // UPDATE (Mocked for now as requested)
            // await this.productsService.update(me, localProduct.id, this.mapMappedProductToCreateDto(remoteProduct, store));
            this.logger.log(`[Sync] Product "${remoteProduct.name}" locally already exists with ID: ${syncState.productId}.`);
            // localProduct = await this.productsRepo.findOne({ where: { id: syncState.productId, adminId }, relations: ['skus'] });
          } else {
            // CREATE
            const { product: createDto, skuQuantityMap } = this.mapMappedProductToCreateDto(remoteProduct, store);
            createDto.skipRemoteCheck = true; // Skip redundant remote slug/sku checks during local sync
            localProduct = await this.productsService.create(me, createDto);
            allProductsmap.set(localProduct.id, skuQuantityMap);

          }

          // 3. Upsert sync state to link remote product to local product
          if (localProduct) {
            await this.productSyncStateService.upsertSyncState(
              { adminId, productId: localProduct.id, storeId: store.id, externalStoreId: store.externalStoreId },
              {
                remoteProductId: remoteId,
                status: ProductSyncStatus.SYNCED,
                lastError: null,
                lastSynced_at: new Date(),
              }
            );

            // Collect SKUs for purchase if they have remote stock
            if (localProduct.type === ProductType.SINGLE) {
              const sku = localProduct.skus?.[0];
              const quantity = allProductsmap.get(localProduct.id)?.get(sku?.sku) || 0;
              if (sku && quantity > 0) {
                purchaseItems.push({
                  variantId: sku.id,
                  quantity: quantity,
                  purchaseCost: localProduct.wholesalePrice || localProduct.wholesalePrice || 0
                });
              }
            } else if (localProduct.type === ProductType.VARIABLE && localProduct.skus?.length > 0) {
              for (const localVariant of localProduct.skus) {
                const localQuantity = allProductsmap.get(localProduct.id)?.get(localVariant.sku) || 0;
                if (localQuantity > 0) {
                  const localSku = localProduct.skus?.find(s => s.key === localVariant.key);
                  if (localSku) {
                    purchaseItems.push({
                      variantId: localSku.id,
                      quantity: localQuantity,
                      purchaseCost: localProduct.wholesalePrice || localProduct.wholesalePrice || 0
                    });
                  }
                }
              }
            }
          }

          successCount++;
          if (isNew) newSuccess++;
        } catch (error: any) {
          failedCount++;
          if (isNew) newFailed++;
          const errMsg = getErrorMessage(error);
          const stack = error?.stack || 'No stack trace';
          errors.push(`Product "${remoteProduct.name}" (Remote ID: ${remoteProduct.id}): ${errMsg}`);
          // LOG THE ERROR
          await this.productSyncStateService.upsertSyncErrorLog(
            { adminId, productId: null, storeId: store.id, entityType: SyncEntityType.PULL },
            {
              remoteProductId: remoteProduct.id || null,
              action: ProductSyncAction.PULL,
              errorMessage: errMsg,
              userMessage: this.translations.t(
                'domains.stores.failed_to_sync_product_to_store',
                {
                  args: {
                    productName: remoteProduct.name,
                    storeName: store.name,
                    message: errMsg,
                  },
                },
              ),
              responseStatus: error?.response?.status,
              requestPayload: error?.config?.data ? JSON.parse(error.config.data) : null
            }
          );


          this.logger.error(`[Sync] Failed to sync product "${remoteProduct.name}": ${errMsg}`, stack);
        }
      }

      // 6. Send final summary notification
      const total = remoteProducts.length;
      await this.notificationService.create({
        userId: adminId,
        type: NotificationType.REMOTE_SYNC_END,
        title: await this.requestTranslations.tAsync(
          'domains.stores.full_store_sync_finished',
          adminId,
          {
            args: {
              storeName: store.name,
            },
          },
        ),
        message: await this.requestTranslations.tAsync(
          'domains.stores.full_store_sync_finished_message',
          adminId,
          {
            args: {
              total,
              newTotal,
              newSuccess,
              newFailed,
              alreadyLinked: total - newTotal,
            },
          },
        ),
      });


      await this.storesRepo.update(store.id, {
        syncStatus: SyncStatus.SYNCED,
      });

      // Notify admin via websocket about the new sync status
      if (store.adminId) {
        this.appGateway.emitStoreSyncStatus(String(store.adminId), {
          storeId: store.id,
          provider: store.provider,
          status: SyncStatus.SYNCED,
          type: "remote",
        });
      }


      return { total, successCount, failedCount, newTotal, newSuccess, newFailed, errors };
    } catch (error) {
      await this.storesRepo.update(store.id, {
        syncStatus: SyncStatus.FAILED,
      });

      if (store.adminId) {
        this.appGateway.emitStoreSyncStatus(String(store.adminId), {
          storeId: store.id,
          provider: store.provider,
          status: SyncStatus.FAILED,
          type: "remote",
        });
      }
      throw error;
    }

  }

  private mapMappedProductToCreateDto(p: MappedProductDto, store: StoreEntity): { product: CreateProductDto, skuQuantityMap: Map<string, number> } {
    //qunatity map 
    const skuQuantityMap = new Map<string, number>();


    // Safe slug/sku generation
    const slug = p.slug || generateSlug(p.name);
    // then rand  8numbers and letters 

    let sku = normalizeSku(p.sku || "");

    if (!sku) {
      sku = `SKU-${generateRandomAlphanumeric(8)}`;
    }


    const combinations: CreateSkuItemDto[] = p.variants?.map(v => {
      const attrs = v.variation_props.reduce((acc, vp) => {
        if (vp.variation && vp.variation_prop) {
          const key = this.productsService.slugifyKey(vp.variation);
          const value = vp.variation_prop;
          acc[key] = value;
        }
        return acc;
      }, {});
      let normalized = normalizeSku(v.sku || "");
      if (!normalized) {
        normalized = `${sku}-${generateRandomAlphanumeric(5)}`;
      }

      skuQuantityMap.set(
        normalized,
        v.quantity ?? 0,
      );
      return {
        sku: normalized,
        price: v.price,
        stockOnHand: 0,
        isActive: true,
        attributes: attrs,
      }
    }) || [];

    skuQuantityMap.set(
      sku,
      p.quantity ?? 0,
    );

    const product = {
      name: p.name,
      slug: slug,
      sku: sku,
      type: p.type || (combinations.length > 0 ? ProductType.VARIABLE : ProductType.SINGLE),
      salePrice: p.price,
      wholesalePrice: p.expense || 0,
      lowestPrice: p.price,
      description: p.description,
      categoryName: p.categories?.[0]?.name,
      storeId: store.id,
      remoteId: String(p.id),
      mainImage: p.thumb,
      images: p.images?.map(url => ({ url })),
      combinations: combinations.length > 0 ? combinations : undefined,
    };

    return { product, skuQuantityMap }
  }

  private getService(provider: string | StoreProvider): BaseStoreProvider {
    switch (provider) {
      case StoreProvider.SHOPIFY:
        return this.shopifyService;
      case StoreProvider.EASYORDER:
        return this.easyOrderService;
      case StoreProvider.WOOCOMMERCE:
        return this.woocommerceService;
      default:
        throw new Error(`Unsupported Store Provider: ${provider}`);
    }
  }

  protected getErrorMessage(error: any): string {
    return error?.response?.data?.message || error?.response?.message || error?.message || 'Unknown error';
  }

  async processProductSyncJob(data: any): Promise<any> {
    const {
      type,
      storeType,
      storeId,
      productId,
      bundleId,
      oldBundleData,
      category,
      slug,
      productIds,
      adminId,
    } = data;

    const result: any = {
      type,
      actions: [] as string[],
      success: true,
      skipped: false
    };

    try {

      const service = storeType ? this.getService(storeType) : null;

      switch (type) {
        case ProductSyncJobs.SYNC_CATEGORY:
          const categoryResult = await service?.syncCategory({ category, slug });
          this.logger.log(`[Category Sync] Provider: ${storeType} | Job: ${type} | Successfully processed: ${category?.name?.trim()}`);
          return categoryResult;
          break;

        case ProductSyncJobs.SYNC_PRODUCT:
          const product = await this.productsRepo.findOne({
            where: { id: productId },
            relations: ['category', 'store']
          });

          if (!product || !product.isActive) return;

          const productResult = await service?.syncProduct({ productId });
          this.logger.log(`[Product Sync] Provider: ${storeType} | Job: ${type} | Successfully processed: ${productId}`);
          return productResult;
          break;

        case ProductSyncJobs.SYNC_BUNDLE:
          const bundle = await this.bundleRepo.createQueryBuilder('bundle')
            // .leftJoinAndSelect('bundle.variant', 'variant')
            // .leftJoinAndSelect('variant.product', 'product')
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
            .where('bundle.id = :bundleId', { bundleId })
            .getOne();

          if (!bundle) return;

          const { oldMainVaraintId, oldStoreId, oldStoreType, adminId: storeAdmin } = oldBundleData ?? {};
          if (oldMainVaraintId && oldStoreId && (bundle?.storeId !== oldStoreId)) {
            const deleteService = this.getService(oldStoreType);
            if ('deleteBundle' in deleteService)
              await (deleteService as unknown as IBundleSyncProvider).deleteBundle(oldMainVaraintId, oldStoreId, storeAdmin);
            this.logger.log(`[Delete Bundle] Provider: ${oldStoreType} | Job: ${type} | Successfully delete bundle of old varaint: ${oldMainVaraintId}`);
          }

          // if (!bundle?.variant?.isActive) return;
          if ('syncBundle' in service) {
            await (service as unknown as IBundleSyncProvider).syncBundle(bundle);
            this.logger.log(`[Bundle Sync] Provider: ${storeType} | Job: ${type} | Successfully processed: ${bundleId}`);
          }
          break;

        case ProductSyncJobs.FULL_SYNC:
          const store = await this.storesRepo.findOneBy({ id: storeId });
          if (store) {
            const fullSyncResult = await service?.syncFullStore(store, productIds);
            this.logger.log(`[Full Store Sync] Provider: ${storeType} | Job: ${type} | Successfully processed: ${storeId}`);
            return fullSyncResult;
          }
          break;

        case ProductSyncJobs.SYNC_LOCAL:
          if (adminId && storeType) {
            const syncResult = await this.syncStoreProductsLocally(adminId, storeType);
            this.logger.log(`[Sync Products Locally] Provider: ${storeType} | Admin: ${adminId} | Successfully processed`);
            return syncResult;
          }
          break;

        default:
          this.logger.warn(`Unknown job type: ${type} for provider: ${storeType}`);
      }
    } catch (error: any) {
      const message = this.getErrorMessage(error);
      const stack = error instanceof Error ? error.stack : 'No stack trace available';
      this.logger.error(
        `[Worker Error] Provider: ${storeType} | Job: ${type} | ${message}`,
        stack
      );
      throw error;
    }
  }

  async processOrderSyncJob(data: any): Promise<any> {
    const {
      type,
      storeType,
      storeId,
      orderId,
      newStatusId,
      oldStatusId,
      orders,
      adminId,
      failureId,
      provider,
      items,
    } = data;

    try {
      const service = storeType ? this.getService(storeType) : null;

      switch (type) {
        case OrderSyncJobs.BULK_CREATE_ORDERS:
          if (!orders?.length) {
            this.logger.warn(`[Bulk Orders] Empty payload for admin ${adminId}`);
            return;
          }
          if (orders.length > 0) {
            const result = await this.ordersService.createBulkOrders(orders, adminId);
            this.logger.log(
              `[Bulk Orders] Created ${orders.length} orders for admin ${adminId}`
            );
            return result;
          }
          break;

        case OrderSyncJobs.SYNC_ORDER_STATUS:
          const order = await this.orderRepo.findOne({
            where: { id: orderId },
          });
          if (order) {
            const result = await service?.syncOrderStatus(order, newStatusId, oldStatusId);
            this.logger.log(`[Order Status Sync] Provider: ${storeType} | Job: ${type} | Successfully processed: ${orderId}`);
            return result;
          }
          break;

        case OrderSyncJobs.RETRY_FAILED_ORDER:
          if (failureId && adminId) {
            const mockUser = { id: adminId, role: { name: 'admin' } };
            const result = await this.retryFailedOrder(mockUser, failureId);
            this.logger.log(`[Retry Failed Order] Processed failureId=${failureId}, result=${JSON.stringify(result)}`);
            return result;
          }
          break;

        case OrderSyncJobs.BULK_SHIPPING:
          if (!items?.length) {
            this.logger.warn(`[Bulk Shipping] Empty payload for admin ${adminId}`);
            return;
          }
          const result = await this.processBulkShipping(adminId, provider, items);
          return result;
          break;

        default:
          this.logger.warn(`Unknown job type: ${type} for provider: ${storeType}`);
      }
    } catch (error: any) {
      const message = this.getErrorMessage(error);
      const stack = error instanceof Error ? error.stack : 'No stack trace available';
      this.logger.error(
        `[Worker Error] Provider: ${storeType} | Job: ${type} | ${message}`,
        stack
      );
      throw error;
    }
  }

  private async processBulkShipping(
    adminId: string,
    provider: any,
    items: any[],
  ) {
    const mockUser = { id: adminId, role: { name: 'admin' } };
    const chunkSize = 3;

    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);
      this.logger.log(`[Bulk Shipping] Processing chunk ${Math.floor(i / chunkSize) + 1} (${chunk.length} items)`);

      const results = await Promise.allSettled(
        chunk.map(async (item) => {
          try {
            const { orderId, ...individualDto } = item;
            await this.shippingService.createShipment(
              mockUser,
              provider,
              individualDto,
              orderId,
            );
            return { orderId, success: true };
          } catch (error) {
            this.logger.error(`[Bulk Shipping] Failed to process order ${item.orderId}:`, error);
            return { orderId: item.orderId, success: false, error };
          }
        })
      );

      const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length;
      this.logger.log(`[Bulk Shipping] Chunk complete. Success: ${successful}, Failed: ${failed}`);
    }
  }
}