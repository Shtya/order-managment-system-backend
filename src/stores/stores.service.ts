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
import { StoreQueueService } from "./storesIntegrations/queues";
import { BaseStoreProvider, ISkuFetch, MappedProductDto, oldBundleDataDto, UnifiedProductDto, WebhookOrderPayload } from "./storesIntegrations/BaseStoreProvider";
import { ShopifyService } from "./storesIntegrations/ShopifyService";
import { EasyOrderService } from "./storesIntegrations/EasyOrderService";
import WooCommerceService from "./storesIntegrations/WooCommerce";
import { OrdersService } from "src/orders/services/orders.service";
import { ProductsService } from "src/products/products.service";
import { ProductSyncStateService } from "src/product-sync-state/product-sync-state.service";
import { PurchasesService } from "src/purchases/purchases.service";
import { SafesService } from "src/safes/safes.service";
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
import { ProductSyncStatus, ProductSyncStateEntity } from "entities/product_sync_error.entity";
import { NotificationType } from "entities/notifications.entity";
import { convert } from "html-to-text";

@Injectable()
export class StoresService {
  private readonly logger = new Logger(StoresService.name);
  private providers: Record<string, BaseStoreProvider>;
  constructor(
    private dataSource: DataSource,
    // private readonly encryptionService: EncryptionService,
    protected readonly redisService: RedisService,
    protected readonly storeQueueService: StoreQueueService,
    private readonly appGateway: AppGateway,
    private readonly notificationService: NotificationService,
    private readonly productSyncStateService: ProductSyncStateService,
    private readonly purchasesService: PurchasesService,
    private readonly safesService: SafesService,
    private readonly shopifyService: ShopifyService,
    private readonly easyOrderService: EasyOrderService,
    private readonly woocommerceService: WooCommerceService,

    @InjectRepository(ProductEntity) protected readonly productsRepo: Repository<ProductEntity>,
    @InjectRepository(ProductVariantEntity) protected readonly pvRepo: Repository<ProductVariantEntity>,
    @InjectRepository(WebhookOrderFailureEntity) private readonly failureRepo: Repository<WebhookOrderFailureEntity>,
    @InjectRepository(ProductSyncStateEntity) private readonly productSyncStateRepo: Repository<ProductSyncStateEntity>,
    @InjectRepository(OrderEntity) private readonly ordersRepo: Repository<OrderEntity>,
    @InjectRepository(Account) private readonly safesRepo: Repository<Account>,

    @Inject(forwardRef(() => OrdersService))
    protected readonly ordersService: OrdersService,
    @Inject(forwardRef(() => ProductsService))
    private readonly productsService: ProductsService,

    @InjectRepository(StoreEntity)
    private readonly storesRepo: Repository<StoreEntity>,
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
    if (!p) throw new BadRequestException(`Unsupported shipping provider: ${provider}`);
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
    if (!adminId) throw new BadRequestException("Missing adminId");

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? "").trim(); // Remember to trim

    const qb = this.storesRepo.createQueryBuilder("store");

    // 1. SELECT ONLY SAFE COLUMNS (Explicitly skip encryptedData, iv, tag)
    qb.select([
      "store.id",
      "store.name",
      "store.storeUrl",
      "store.provider",
      "store.isActive",
      "store.isIntegrated",
      "store.syncNewProducts",
      "store.syncStatus",
      "store.lastSyncAttemptAt",
      "store.created_at",
      "store.updated_at"
    ]);

    // 2. Multi-tenant Filter
    qb.where("store.adminId = :adminId", { adminId });

    // 3. Optional Filter: Platform/Provider
    if (q?.provider) {
      qb.andWhere("store.provider = :provider", { provider: q.provider });
    }

    // 4. Optional Filter: Status
    if (q?.syncStatus) {
      qb.andWhere("store.syncStatus = :syncStatus", { syncStatus: q.syncStatus });
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

    return {
      total_records: total,
      current_page: page,
      total_pages: Math.ceil(total / limit),
      per_page: limit,
      records,
    };
  }

  async listWithCredentials(me: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

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
    if (!adminId) throw new BadRequestException("Missing adminId");

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(`Store not found`);
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
      throw new BadRequestException('API Key is required for integration.');
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
            throw new BadRequestException(`Unable to authenticate with the provided credentials for ${p.displayName}. Please check your API key and other settings.`);
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
    if (!adminId) throw new BadRequestException("Missing adminId");

    const store = await this.storesRepo.findOne({ where: { adminId, provider: dto.provider } });

    if (store) {
      store.name = dto.name.trim();
      store.storeUrl = dto.storeUrl.trim();
      store.syncNewProducts = dto.syncNewProducts;
      return await this.storesRepo.save(store);
    }

    const storeToSave = {
      adminId,
      name: dto.name.trim(),
      storeUrl: dto.storeUrl.trim(),
      provider: dto.provider,
      credentials: {
        apiKey: null,
      },
      isIntegrated: false,
      isActive: false,
      syncNewProducts: dto.syncNewProducts,
    };

    const savedStore = await this.storesRepo.save(storeToSave);
    return savedStore;
  }


  async cancelIntegration(me: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const store = await this.storesRepo.findOne({ where: { adminId, provider: StoreProvider.EASYORDER } });

    if (!store) {
      throw new BadRequestException("No integrated store was found. Please connect your store first..");
    }

    await this.easyOrderService.cancelIntegration(adminId);
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
    if (!adminId) throw new BadRequestException("Missing adminId");

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(`Store not found`);

    if (store.provider !== StoreProvider.WOOCOMMERCE) {
      throw new BadRequestException("Webhook regeneration is only supported for WooCommerce stores.");
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
    if (!adminId) throw new BadRequestException("Missing adminId");
    // Find the existing store
    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(`Store not found`);

    const p = this.getProvider(store.provider);
    return await this.dataSource.transaction(async (manager) => {

      if (dto.name) store.name = dto.name.trim();
      if (dto.storeUrl) store.storeUrl = dto.storeUrl.trim();
      if (dto.syncNewProducts !== undefined) store.syncNewProducts = dto.syncNewProducts;
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
            throw new BadRequestException(`Unable to authenticate with the provided credentials for ${p.displayName}. Please check your API key and other settings.`);
          }
        } catch (error) {
          throw new BadRequestException(
            store.provider === StoreProvider.SHOPIFY
              ? `Unable to validate the Shopify connection. Please install the app and verify your credentials and store URL.`
              : `Unable to validate the connection to ${p.displayName}. Please verify your credentials and settings.`
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
    if (!adminId) throw new BadRequestException("Missing adminId");

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(`Store not found`);

    if (!store) throw new NotFoundException(`Store not found`);
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
      return this.storeQueueService.enqueueCategorySync(
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
    await this.storeQueueService.enqueueProductSync(product.id, product.adminId, store.id, store.provider);
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
    await this.storeQueueService.enqueueBundleSync(bundle.id, bundle.adminId, store.id, store.provider, oldBundleData);
    this.logger.log(
      `[Bundle Sync] Dispatched sync job for Bundle: "${name}" (ID: ${id}) ` +
      `to Store: "${store.name}" (ID: ${store.id}) for Admin: ${adminId}.`
    );

  }

  async syncOrderStatus(order: OrderEntity, newStatusId: string) {
    const { adminId, orderNumber, id, store: orderStore } = order;

    if (!orderStore) {
      this.logger.warn(`[Order Status Sync] No active store found to sync Order #${orderNumber} for Admin ${adminId}.`);
      return;
    }

    const store = await this.storesRepo.findOne({
      where: { adminId, isActive: true, isIntegrated: true, provider: orderStore.provider }
    });

    if (!store) {
      this.logger.warn(`[Order Status Sync] No active store found to sync Order #${orderNumber} for Admin ${adminId}.`);
      return;
    }

    // Route to the correct queue based on Provider

    await this.storeQueueService.enqueueOrderStatusSync(order, store.id, store.provider, newStatusId);

    this.logger.log(
      `[Order Status Sync] Dispatched status update for Order #${orderNumber} (ID: ${id}) ` +
      `to Store: "${store.name}" (ID: ${store.id}) for Admin: ${adminId}.`
    );

  }

  async manualSync(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(`Store with ID ${id} not found`);

    if (!store.isActive) throw new BadRequestException("Cannot sync: store is inactive");

    if (!store.isIntegrated) throw new BadRequestException(
      `The store "${store.name.trim()}" is not integrated. Please connect your store first.`
    );

    // Route to the correct queue based on Provider
    await this.storeQueueService.enqueueFullStoreSync(store);

    this.logger.log(
      `[Manual Full Sync] Dispatched full catalog sync for Store: "${store.name}" (ID: ${id}) ` +
      `initiated by Admin: ${adminId}.`
    );

    return {
      message: `Full synchronization job for "${store.name}" has been queued.`,
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
      title: "Order Creation Failed",
      message: `Failed to process order from ${store.name}: ${reason}`,
      relatedEntityType: "webhook_order_failures",
      relatedEntityId: String(created.id),
    });
    return record;
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
        const existingOrder = await this.ordersService.findByExternalId(payload.externalOrderId);
        if (existingOrder) {
          //notification here
          return { ok: true, ignored: true, reason: 'order_exists' };
        }

        const remoteIds = payload.cartItems.map(item => item.remoteProductId);
        const safeRemoteIds = remoteIds.length > 0 ? remoteIds : [null];

        const syncStates = await this.productSyncStateRepo.find({
          where: {
            adminId,
            storeId: existingOrder?.statusId,
            externalStoreId: existingOrder?.store?.externalStoreId,
            remoteProductId: In(safeRemoteIds),
          },
          relations: ['product', 'product.variants'],
        });

        const productMap = new Map(
          syncStates?.filter(s => s.remoteProductId).map(s => [s?.remoteProductId, s?.product])
        );

        const items = [];
        for (const item of payload.cartItems) {
          const localProduct = productMap.get(item.remoteProductId);
          if (!localProduct) {
            throw new BadRequestException(
              `The product "${item.name}" could not be found in your system.`
            );
          }
          if (!localProduct?.isActive) {
            throw new BadRequestException(`The Product "${item.name}" is no longer active.`);
          }

          const key = item.variant.key;
          const matchedVariant = localProduct.variants.find(v => v.key === key);

          if (!matchedVariant?.isActive) {
            throw new BadRequestException(
              `The selected variant for "${item.name}" is no longer active..`
            );
          }

          if (!matchedVariant) {
            const reason = `No valid variant found for product ${item.name}`;
            throw new BadRequestException(reason);
          }

          items.push({
            variantId: matchedVariant.id, // Internal Database ID
            quantity: item.quantity,
            unitPrice: item.price,
            unitCost: 0,
          });
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
          title: "New Order Created",
          message: `Order "${newOrder.orderNumber}" created successfully from ${store.name}.`,
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
            title: "Retry Order Creation Failed",
            message: `Failed to retry order creation for ${store.name}: ${errorMessage}`,
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

      const externalOrderId = body.id || body?.order_id
      const order = await this.ordersService.findByExternalId(externalOrderId);

      if (!order) {
        throw new Error(`Unknown order ${externalOrderId}`);
      }
      const payload = p.mapWebhookUpdate(body, order?.status?.code as OrderStatus);

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
        throw new Error(
          `Unmapped status "${payload.remoteStatus}" for order ${order.orderNumber}`
        );
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
          notes: `Updated via webhook (${payload.remoteStatus})`,
        });
      }

      // 💰 Payment status
      if (isPaymentStatusChanged) {
        order.paymentStatus = payload.mappedPaymentStatus;
        await this.ordersRepo.save(order);

        await this.notificationService.create({
          userId: order.adminId.toString(),
          type: NotificationType.ORDER_UPDATED,
          title: "Order Payment Status Updated",
          message: `Order #${order.orderNumber} payment status has been updated to ${payload.mappedPaymentStatus}.`,
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
      await this.notificationService.create({
        userId: adminId,
        type: NotificationType.SYSTEM_ERROR,
        title: "Webhook Order Update Failed",
        message: message,
        relatedEntityType: "webhook",
        relatedEntityId: provider,
      });

      return; // ✅ prevent crash / webhook retry storm
    }
  }

  async listFailedOrders(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

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
    if (!adminId) throw new BadRequestException("Missing adminId");

    const failure = await this.failureRepo.findOne({
      where: { id, adminId },
      relations: ['store'],
    });

    if (!failure) {
      throw new NotFoundException("Failed order retry details not found");
    }

    const storeId = failure.store?.id;
    const payload = failure.payload;
    const problems = [];

    if (payload && payload.cartItems) {
      const remoteIds = payload.cartItems.map(item => String(item.remoteProductId));
      //
      const syncStates = await this.productSyncStateRepo.find({
        where: {
          adminId,
          storeId,
          externalStoreId: failure?.store.externalStoreId,
          remoteProductId: In(remoteIds),
        },
        relations: ['product', 'product.variants'],
      });

      const productMap = new Map(syncStates.map(s => [s.remoteProductId, s.product]));

      for (const item of payload.cartItems) {
        const localProduct = productMap.get(item.remoteProductId);

        if (!localProduct) {
          problems.push({
            remoteId: item.remoteProductId,
            key: item?.variant?.key,
            slug: item.productSlug,
            name: item.name,
            code: WebhookOrderProblem.PRODUCT_NOT_FOUND,
            problem: `Product "${item.name}" was not found`,
            details: `The product "${item.name}" does not exist in your local products.`,
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
            problem: `Product "${item.name}" is no longer active.`,
            details: `The product "${item.name}" has been deactivated.`,
          });
          continue;
        }


        // Add local product ID to the item's variant for the UI/frontend
        if (!item.variant) item.variant = {};
        (item.variant as any).localProductId = localProduct.id;

        let matchedVariant = null;
        if (localProduct.type === ProductType.SINGLE) {
          matchedVariant = localProduct.variants?.[0];
        } else if (item.variant && item.variant.key) {
          matchedVariant = localProduct.variants.find(v => v.key === item.variant.key);
        }

        if (!matchedVariant) {
          problems.push({
            remoteId: item.remoteProductId,
            key: item?.variant?.key,
            productId: localProduct.id,
            slug: item.productSlug,
            name: item.name,
            code: WebhookOrderProblem.SKU_NOT_FOUND,
            problem: `Variant with key "${item.variant?.key}" product "${item.productSlug}" was not found`,
            details: localProduct.type === ProductType.SINGLE
              ? "Product is set as single but has no SKU/variant."
              : `Variant was not found.`
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
            problem: `Variant for "${item.name}" is no longer active.`,
            details: `The selected variant for "${item.name}" has been deactivated.`,
          });
          continue;
        }

        const availableStock = matchedVariant.stockOnHand - matchedVariant.reserved;
        if (availableStock < item.quantity) {
          problems.push({
            remoteId: item.remoteProductId,
            productId: localProduct.id,
            key: item?.variant?.key,
            slug: item.productSlug,
            name: item.name,
            sku: matchedVariant.sku,
            code: WebhookOrderProblem.INSUFFICIENT_STOCK,
            problem: `Insufficient stock for variant "${item.variant?.key}" product "${item.productSlug}"`,
            details: `Requested quantity is ${item.quantity}, but only ${availableStock} is available in stock.`
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
    if (!adminId) throw new BadRequestException("Missing adminId");

    const failure = await this.failureRepo.findOne({
      where: { id, adminId },
    });

    if (!failure) {
      throw new NotFoundException("Failed order not found");
    }

    if ([OrderFailStatus.RETRYING, OrderFailStatus.SUCCESS].includes(failure.status as any)) {
      throw new BadRequestException(`Cannot update payload. Current status is: ${failure.status}`);
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
    if (!adminId) throw new BadRequestException("Missing adminId");

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
    if (!adminId) throw new BadRequestException("Missing adminId");


    return await this.dataSource.transaction(async (manager) => {
      const { failureLog, problems } = await this.getFailedOrderDetail(me, failureId);
      try {

        if (!failureLog || !failureLog.store) {
          throw new NotFoundException(`Failed order or store not found`);
        }
        if (!failureLog.store.isActive || !failureLog.store.isIntegrated) {
          throw new BadRequestException(`Store ${failureLog.store.name} is inactive or missing integration`);
        }

        if ([OrderFailStatus.RETRYING, OrderFailStatus.SUCCESS].includes(failureLog.status as any)) {
          throw new BadRequestException(`Cannot retry. Current status is: ${failureLog.status}`);
        }

        if (problems.length > 0) {
          const displayed = problems.slice(0, 2).map((p) => p.problem).join(", ");
          const moreCount = problems.length - 2;
          const suffix = moreCount > 0 ? ` +${moreCount}...` : "";

          throw new BadRequestException(`Cannot retry. Problems: ${displayed}${suffix}`);
        }

        const store = failureLog.store;

        const payload = failureLog.payload;

        failureLog.status = OrderFailStatus.RETRYING;
        failureLog.attempts += 1;
        await manager.save(failureLog);

        // const slugsToSync = payload.cart_items.map(item => item.product_slug);
        // await p.syncProductsFromProvider(store, slugsToSync, manager);

        const result = await this.processMappedWebhookOrder(
          adminId,
          store,
          payload,
          failureLog.rawPayload,
          false,
          failureLog,
          manager
        );

        if (!result.ok) {
          // 🔴 Emit failed again
          throw new BadRequestException(`Retry failed again: ${result.reason}`);
        } else {
          failureLog.status = OrderFailStatus.SUCCESS;
          await manager.save(failureLog);
        }

        return {
          message: "Order successfully retried and created",
          orderId: result.orderId || null,
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
    if (!adminId) throw new BadRequestException("Missing adminId");

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

    // Filters
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

    // Prepare export data
    const exportData = failures.map((f) => ({
      id: f.id,
      store: f.store?.name || "N/A",
      status: f.status,
      reason: f.reason || "N/A",
      createdAt: f.created_at
        ? new Date(f.created_at).toLocaleDateString()
        : "N/A",
    }));

    // Create workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Failed Orders");

    worksheet.columns = [
      { header: "Failure ID", key: "id", width: 15 },
      { header: "Store", key: "store", width: 25 },
      { header: "Status", key: "status", width: 15 },
      { header: "Reason", key: "reason", width: 40 },
      { header: "Created At", key: "createdAt", width: 20 },
    ];

    // Header style
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
    if (!adminId) throw new BadRequestException("Missing adminId");

    // Fetch the failure log to get the store provider
    const { failureLog, problems } = await this.getFailedOrderDetail(me, failureId);

    if (!failureLog || !failureLog.store) {
      throw new NotFoundException("Failure log or associated store not found");
    }

    if ([OrderFailStatus.RETRYING, OrderFailStatus.SUCCESS].includes(failureLog.status as any)) {
      throw new BadRequestException(`Cannot retry. Current status is: ${failureLog.status}`);
    }
    if (!failureLog.store.isActive || !failureLog.store.isIntegrated) {
      throw new BadRequestException(`Store ${failureLog.store.name} is inactive or missing integration`);
    }

    if (problems.length > 0) {
      const displayed = problems.slice(0, 2).map((p) => p.problem).join(", ");
      const moreCount = problems.length - 2;
      const suffix = moreCount > 0 ? ` +${moreCount}...` : "";

      throw new BadRequestException(`Cannot retry. Problems: ${displayed}${suffix}`);
    }

    // Enqueue the retry job
    await this.storeQueueService.enqueueRetryFailedOrder(
      adminId,
      failureId,
      failureLog.store.provider
    );

    this.logger.log(`[Queue Retry] Enqueued retry job for failureId=${failureId}, adminId=${adminId}`);

    return {
      message: "Retry job queued successfully",
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
    const appURL = process.env.FRONTEND_URL;
    const store = await this.storesRepo.findOne({
      where: { adminId, provider: StoreProvider.EASYORDER },
    });
    if (!store) {
      throw new Error("EasyOrder store not found");
    }

    store.credentials = {
      apiKey: credentials.apiKey,
    };
    store.isActive = true;
    store.isIntegrated = true;
    store.externalStoreId = credentials.storeId;

    const newStore = await this.storesRepo.save(store);;
    this.storeQueueService.enqueueFullProductSyncLocally(adminId, newStore.provider)
    return newStore;
  }


  public async getFullProductById(userContext: any, provider: StoreProvider, id: string) {
    const adminId = tenantId(userContext);
    const store = await this.storesRepo.findOne({
      where: { adminId, provider }
    });
    if (!store) {
      throw new BadRequestException(`Store not found, provider: ${provider}`);
    }

    if (!store.isIntegrated) {
      throw new BadRequestException(
        `The store "${store.name.trim()}" is not integrated. Please connect your store first.`
      );
    }
    if (!store.isActive) {
      throw new BadRequestException("Store not active");
    }

    const p = this.getProvider(provider)

    try {
      const product = await p.getFullProductById(store, id);
      if (!product) {
        throw new BadRequestException("Product not found");
      }
      return { ...product, storeId: store.id };
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;

      const message = error.response?.data?.message || error.message;
      const status = error.response?.status;

      if (status === 429) {
        throw new BadRequestException(`Rate limit hit for ${provider}. Please wait and try again.`);
      }

      throw new BadRequestException(`Failed to fetch product from ${provider}: ${message}`);
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
        `The store "${store.name.trim()}" is not integrated. Please connect your store first.`
      );
    }
    if (!store.isActive) {
      throw new BadRequestException("Store not active");
    }

    const p = this.getProvider(provider);
    const remoteProducts = await p.getAllMappedProducts(store);

    let successCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    const me = { id: adminId, adminId, role: { name: 'admin' } };
    const purchaseItems: PurchaseItemDto[] = [];
    const allProductsmap = new Map<string, Map<string, number>>();
    for (const remoteProduct of remoteProducts) {
      try {
        const remoteId = String(remoteProduct.id);

        // 1. Check if linked via ProductSyncState
        let syncState = await this.productSyncStateRepo.findOne({
          where: { adminId, storeId: store.id, remoteProductId: remoteId, externalStoreId: store.externalStoreId }
        });

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
      } catch (error: any) {
        failedCount++;
        const errMsg = getErrorMessage(error);
        const stack = error?.stack || 'No stack trace';
        errors.push(`Product "${remoteProduct.name}" (Remote ID: ${remoteProduct.id}): ${errMsg}`);
        this.logger.error(`[Sync] Failed to sync product "${remoteProduct.name}": ${errMsg}`, stack);
      }
    }

    // 5. Generate purchase for initial stock if items exist
    if (purchaseItems.length > 0) {
      try {
        // Find or create default safe
        const safeName = "الخزنة الرئيسية";
        let defaultSafe = await this.safesRepo.findOne({ where: { adminId } as any });

        if (!defaultSafe) {
          const createAccountDto: CreateAccountDto = {
            name: safeName,
            type: AccountType.CASH,
            initialBalance: 0,
          };
          defaultSafe = await this.safesService.createAccount(me, createAccountDto);
        }

        const totalCost = purchaseItems.reduce((acc, item) => acc + (item.quantity * item.purchaseCost), 0);

        const randomCode = generateRandomAlphanumeric(8);
        const createPurchaseDto: CreatePurchaseDto = {
          receiptNumber: `SYNC-${randomCode}`,
          safeId: defaultSafe.id,
          items: purchaseItems,
          paidAmount: totalCost,
          notes: `Initial stock sync from ${store.name} store`,
        };

        await this.purchasesService.create(me, createPurchaseDto);
        this.logger.log(`[Sync] Successfully generated initial stock purchase for ${purchaseItems.length} SKUs.`);
      } catch (purchaseError: any) {
        this.logger.error(`[Sync] Failed to generate initial stock purchase: ${getErrorMessage(purchaseError)}`);
      }
    }

    // 6. Send final summary notification
    const total = remoteProducts.length;
    await this.notificationService.create({
      userId: adminId,
      type: NotificationType.REMOTE_SYNC_END,
      title: `Full Store Sync Finished: ${store.name}`,
      message: `Sync process completed. Total: ${total}, Success: ${successCount}, Failed: ${failedCount}, Please check the purchase details.`,
    });

    return { total, successCount, failedCount, errors };
  }


  private mapMappedProductToCreateDto(p: MappedProductDto, store: StoreEntity): { product: CreateProductDto, skuQuantityMap: Map<string, number> } {
    //qunatity map 
    const skuQuantityMap = new Map<string, number>();

    // Simple HTML strip for description
    const cleanDescription = convert(p.description, {
      wordwrap: false,
      selectors: [
        { selector: 'img', format: 'skip' },
        { selector: 'a', options: { ignoreHref: true } },
      ],
    }).replace(/\n{2,}/g, '\n')   // 👈 collapse multiple newlines into one
      .trim()

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
          const value = this.productsService.slugifyKey(vp.variation_prop);
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

    const product = {
      name: p.name,
      slug: slug,
      sku: sku,
      type: p.type || (combinations.length > 0 ? ProductType.VARIABLE : ProductType.SINGLE),
      salePrice: p.price,
      wholesalePrice: p.expense || p.price,
      lowestPrice: p.price,
      description: cleanDescription,
      categoryName: p.categories?.[0]?.name,
      storeId: store.id,
      remoteId: String(p.id),
      mainImage: p.thumb,
      images: p.images?.map(url => ({ url })),
      combinations: combinations.length > 0 ? combinations : undefined,
    };

    return { product, skuQuantityMap }
  }

}