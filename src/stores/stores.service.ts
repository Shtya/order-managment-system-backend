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
import { BaseStoreProvider, MappedProductDto, UnifiedProductDto, WebhookOrderPayload } from "./storesIntegrations/BaseStoreProvider";
import { ShopifyService } from "./storesIntegrations/ShopifyService";
import { EasyOrderService } from "./storesIntegrations/EasyOrderService";
import WooCommerceService from "./storesIntegrations/WooCommerce";
import { OrdersService } from "src/orders/services/orders.service";
import { ProductsService } from "src/products/products.service";
import { CreateOrderDto } from "dto/order.dto";
import { UpsertProductSkusDto } from "dto/product.dto";
import * as crypto from "crypto";
import * as ExcelJS from "exceljs";
import { DateFilterUtil } from "common/date-filter.util";
import { AppGateway } from "common/app.gateway";
import { NotificationService } from "src/notifications/notification.service";
import { getErrorMessage } from "common/healpers";
import { ProductSyncStateEntity } from "entities/product_sync_error.entity";
import { NotificationType } from "entities/notifications.entity";

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
    private readonly shopifyService: ShopifyService,
    private readonly easyOrderService: EasyOrderService,
    private readonly woocommerceService: WooCommerceService,

    @InjectRepository(ProductEntity) protected readonly productsRepo: Repository<ProductEntity>,
    @InjectRepository(ProductVariantEntity) protected readonly pvRepo: Repository<ProductVariantEntity>,
    @InjectRepository(WebhookOrderFailureEntity) private readonly failureRepo: Repository<WebhookOrderFailureEntity>,
    @InjectRepository(ProductSyncStateEntity) private readonly productSyncStateRepo: Repository<ProductSyncStateEntity>,
    @InjectRepository(OrderEntity) private readonly ordersRepo: Repository<OrderEntity>,

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
      providers: Object.values(this.providers).map((p) => ({
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
      const store = manager.create(StoreEntity, {
        adminId,
        name: dto.name.trim(),
        externalStoreId: p.code === StoreProvider.WOOCOMMERCE ? this.extractDomain(dto.storeUrl) : null,
        storeUrl: dto.storeUrl.trim(),
        provider: dto.provider,
        credentials, // Direct jsonb assignment
        isActive: p.code === StoreProvider.WOOCOMMERCE, // Only WOOCOMMERCE not wait webhook validation
        syncNewProducts: dto.syncNewProducts,
        isIntegrated: p.code !== StoreProvider.EASYORDER,
        syncStatus: SyncStatus.PENDING,
      });

      const savedStore = await manager.save(store);

      // 4. Validate Provider Connection
      // If the API key is wrong, this throws and rolls back the save
      try {
        const isAuth = await p.validateProviderConnection(savedStore);
        if (!isAuth) {
          throw new BadRequestException(`Unable to authenticate with the provided credentials for ${p.displayName}. Please check your API key and other settings.`);
        }
      } catch (error: any) {
        this.logger.error(`Validation failed for ${dto.provider}: ${error.message}`);
        throw new BadRequestException(`Unable to validate the integration to ${p.displayName}. This could be due to an invalid key, or incorrect provider settings.`);
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
      throw new BadRequestException("Store not integrated.");
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
          throw new BadRequestException(`Unable to validate the integration to ${p.displayName}. This could be due to an invalid key, or incorrect provider settings.`);
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

  async syncBundleToStore(bundle: BundleEntity) {
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
    await this.storeQueueService.enqueueBundleSync(bundle.id, bundle.adminId, store.id, store.provider);
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

    if (!store.isIntegrated) throw new BadRequestException("Cannot sync: store is not integrated");

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
    await this.failureRepo.save(record);
    this.logger.warn(`[Webhook Order Failure] recorded for admin ${adminId} store ${store?.id} reason=${reason}`);
    return record;
  }

  private async processMappedWebhookOrder(
    adminId: string,
    store: StoreEntity,
    payload: WebhookOrderPayload,
    rawBody: any,
    failureLog?: WebhookOrderFailureEntity,
    manager?: EntityManager

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

        const localProducts = await this.storesRepo.manager.createQueryBuilder(ProductEntity, "product")
          .leftJoinAndSelect("product.variants", "variants")
          .leftJoinAndMapOne(
            "product.syncState",
            ProductSyncStateEntity,
            "syncState",
            `
            syncState.productId = product.id
            AND syncState.storeId = :storeId
            AND syncState.adminId = :adminId
            AND syncState.externalStoreId = :externalStoreId
            AND syncState.remoteProductId IN (:...remoteIds)
          `,
            {
              storeId: store.id,
              adminId: store.adminId,
              externalStoreId: store.externalStoreId,
              remoteIds: safeRemoteIds,
            }
          )
          .where("product.storeId = :storeId", { storeId: store.id })
          .andWhere("product.adminId = :adminId", { adminId: store.adminId })
          .andWhere("product.isActive = :isActive", { isActive: true })
          .orderBy("product.id", "ASC")
          .getMany();

        const productMap = new Map(
          localProducts.filter(p => (p as any).syncState?.remoteProductId).map(p => [(p as any).syncState?.remoteProductId, p])
        );

        const items = [];
        for (const item of payload.cartItems) {
          const localProduct = productMap.get(item.remoteProductId);
          if (!localProduct) {
            const reason = `Missing product for ${item.name}`;
            throw new BadRequestException(reason);
          }
          let matchedVariant = null;
          if (localProduct.type === ProductType.SINGLE) {
            matchedVariant = localProduct.variants?.[0];
          } else if (item.variant && item.variant.variation_props && item.variant.variation_props.length > 0) {
            const key = item.variant.key;
            matchedVariant = localProduct.variants.find(v => v.key === key);
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
      await this.notificationService.create({
        userId: adminId,
        type: NotificationType.SYSTEM_ERROR,
        title: "Order Creation Failed",
        message: `Failed to process order from ${store.name}: ${getErrorMessage(error)}`,
        relatedEntityType: "store",
        relatedEntityId: String(store.id),
      });

      if (failureLog) {
        failureLog.status = OrderFailStatus.FAILED;
        failureLog.lastRetryFailedReason = errorMessage;
        await this.failureRepo.save(failureLog);
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
    return this.processMappedWebhookOrder(adminId, store, payload, body);
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
            problem: `Product "${item.productSlug}" was not found`,
            details: `Slug "${item.productSlug}" does not exist in your local products.`,
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
          throw new NotFoundException("Failure log or associated store not found");
        }
        if (!failureLog.store.isActive || !failureLog.store.isIntegrated) {
          throw new BadRequestException(`Store ${failureLog.store.id} is inactive or missing integration`);
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
      throw new BadRequestException(`Store ${failureLog.store.id} is inactive or missing integration`);
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

    return await this.storesRepo.save(store);
  }

  public async getFullProductById(userContext: any, provider: StoreProvider, id: string) {
    const adminId = tenantId(userContext);
    const store = await this.storesRepo.findOne({
      where: { adminId, provider }
    });
    if (!store) {
      throw new BadRequestException(`Store not found for adminId: ${adminId}, provider: ${provider}`);
    }

    if (!store.isIntegrated) {
      throw new BadRequestException("Store not integrated");
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

}