import { BadRequestException, forwardRef, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, In, Not, Repository } from "typeorm";
import { OrderFailStatus, StoreEntity, StoreProvider, SyncStatus, WebhookOrderFailureEntity } from "entities/stores.entity";
import { CreateStoreDto, UpdateStoreDto } from "dto/stores.dto";
import { tenantId } from "src/category/category.service";
import { CategoryEntity } from "entities/categories.entity";
import { ProductEntity, ProductVariantEntity } from "entities/sku.entity";
import { OrderEntity } from "entities/order.entity";
import { RedisService } from "common/redis/RedisService";
import { StoreQueueService } from "./storesIntegrations/queues";
import { BaseStoreProvider, UnifiedProductDto, WebhookOrderPayload } from "./storesIntegrations/BaseStoreProvider";
import { ShopifyService } from "./storesIntegrations/ShopifyService";
import { EasyOrderService } from "./storesIntegrations/EasyOrderService";
import { WooCommerceService } from "./storesIntegrations/WooCommerce";
import { OrdersService } from "src/orders/services/orders.service";
import { ProductsService } from "src/products/products.service";
import { CreateOrderDto } from "dto/order.dto";
import { UpsertProductSkusDto } from "dto/product.dto";
import * as crypto from "crypto";
import * as ExcelJS from "exceljs";
import { AppGateway } from "common/app.gateway";

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
    private readonly shopifyService: ShopifyService,
    private readonly easyOrderService: EasyOrderService,
    private readonly woocommerceService: WooCommerceService,

    @InjectRepository(ProductEntity)
    protected readonly productsRepo: Repository<ProductEntity>,
    @InjectRepository(ProductVariantEntity)
    protected readonly pvRepo: Repository<ProductVariantEntity>,
    @InjectRepository(WebhookOrderFailureEntity)
    private readonly failureRepo: Repository<WebhookOrderFailureEntity>,

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


  private getProvider(provider: string): BaseStoreProvider {
    const key = (provider || '').toLowerCase().trim();
    const p = this.providers[key];
    if (!p) throw new BadRequestException(`Unsupported shipping provider: ${provider}`);
    return p;
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

  async get(me: any, id: number) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(`Store not found`);
    return this.getMaskedStoreIntegrations(store);
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
        // code: dto.code.trim(),
        storeUrl: dto.storeUrl.trim(),
        provider: dto.provider,
        credentials, // Direct jsonb assignment
        isActive: true,
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
      } catch (error) {
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
  private async removeAuthCashe(storeId: number) {
    const cacheKey = `store_auth:${storeId}`;
    await this.redisService.del(cacheKey);
    this.logger.log(`Cache cleared for store ${storeId}.`);
  }

  async regenerateWebhookSecrets(me: any, id: number) {
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

    const { webhookCreateOrderSecret, webhookUpdateStatusSecret } = store.credentials;

    return {
      webhookCreateOrderSecret,
      webhookUpdateStatusSecret,
    };
  }

  async update(me: any, id: number, dto: UpdateStoreDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");
    // Find the existing store
    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(`Store not found`);

    const p = this.getProvider(store.provider);
    return await this.dataSource.transaction(async (manager) => {

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

        try {

          const isAuth = await p.validateProviderConnection(store);
          if (!isAuth) {
            throw new BadRequestException(`Unable to authenticate with the provided credentials for ${p.displayName}. Please check your API key and other settings.`);
          }
        } catch (error) {
          throw new BadRequestException(`Unable to validate the integration to ${p.displayName}. This could be due to an invalid key, or incorrect provider settings.`);
        }
      }

      // 3. Handle Unique Code Update
      // if (dto.code) {
      //   const trimmedCode = dto.code.trim();
      //   if (trimmedCode !== store.code) {
      //     const existingCode = await manager.findOne(StoreEntity, {
      //       where: { adminId, code: trimmedCode }
      //     });

      //     if (existingCode) {
      //       throw new BadRequestException(`Store code "${trimmedCode}" is already in use.`);
      //     }
      //     store.code = trimmedCode;
      //   }
      // }

      // 4. Update standard fields (with trimming)
      if (dto.name) store.name = dto.name.trim();
      if (dto.storeUrl) store.storeUrl = dto.storeUrl.trim();
      if (dto.isActive !== undefined) store.isActive = dto.isActive;

      const savedStore = await manager.save(store);

      // 5. Cleanup
      await this.removeAuthCashe(savedStore.id);

      return {
        ok: true,
        id: savedStore.id,
        // Masking logic if needed for the response
        credentialsConfigured: !!savedStore.credentials?.apiKey,
      };
    });
  }

  // async checkCodeExists(me: any, code: string): Promise<boolean> {
  //   const adminId = tenantId(me);
  //   if (!adminId) throw new BadRequestException("Missing adminId");

  //   // .exists() returns a boolean directly (true if found, false if not)
  //   // We trim the code to ensure accurate comparison
  //   return await this.storesRepo.exists({
  //     where: {
  //       adminId,
  //       code: code.trim()
  //     }
  //   });
  // }

  async remove(me: any, id: number) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(`Store not found`);

    if (!store) throw new NotFoundException(`Store not found`);
    const removedStore = await this.storesRepo.remove(store);
    await this.removeAuthCashe(store.id);
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
      created_at: store.created_at,
      updated_at: store.updated_at,
      credentials: masked // Renamed for frontend consistency
    };
  }

  async syncCategoryToAllStores(category: CategoryEntity, slug?: string) {
    const { adminId, name, id } = category;

    // Get active stores
    const activeStores = await this.storesRepo.find({
      where: { adminId, isActive: true }
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

  async syncProductToStore(product: ProductEntity, slug?: string) {
    const { storeId, adminId, name, id } = product;
    if (!storeId) return;

    // Get active stores
    const store = await this.storesRepo.findOne({
      where: { id: storeId, adminId, isActive: true }
    });

    if (!store) {
      this.logger.warn(`[Product Sync] No active store found (ID: ${storeId}) for Product: "${name}". Skipping.`);
      return;
    }
    // Route to the correct queue based on Provider
    await this.storeQueueService.enqueueProductSync(product.id, product.adminId, store.id, store.provider, slug);
    this.logger.log(
      `[Product Sync] Dispatched sync job for Product: "${name}" (ID: ${id}) ` +
      `to Store: "${store.name}" (ID: ${store.id}) for Admin: ${adminId}. ` +
      `${slug ? `(Slug update detected from: ${slug})` : ''}`
    );

  }

  async syncOrderStatus(order: OrderEntity) {
    const { adminId, orderNumber, id } = order;

    const store = await this.storesRepo.findOne({
      where: { adminId, isActive: true }
    });

    if (!store) {
      this.logger.warn(`[Order Status Sync] No active store found to sync Order #${orderNumber} for Admin ${adminId}.`);
      return;
    }

    // Route to the correct queue based on Provider

    await this.storeQueueService.enqueueOrderStatusSync(order, store.id, store.provider);

    this.logger.log(
      `[Order Status Sync] Dispatched status update for Order #${orderNumber} (ID: ${id}) ` +
      `to Store: "${store.name}" (ID: ${store.id}) for Admin: ${adminId}.`
    );

  }

  async manualSync(me: any, id: number) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(`Store with ID ${id} not found`);

    if (!store.isActive) throw new BadRequestException("Cannot sync an inactive store");

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
      payload: rawPayload,
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

  ): Promise<{ ok: boolean; ignored?: boolean; reason?: string; orderId?: number }> {

    try {
      const runInTransaction = async (work: (em: EntityManager) => Promise<any>) => {
        if (manager) return work(manager);
        return this.dataSource.transaction(work);
      };

      return runInTransaction(async (manager) => {
        const p = this.getProvider(store?.provider);
        const existingOrder = await this.ordersService.findByExternalId(payload.externalId);
        if (existingOrder) {
          return { ok: true, ignored: true, reason: 'order_exists' };
        }

        const slugs = payload.cart_items.map(item => item.product_slug);

        const localProducts = await manager.getRepository(ProductEntity).find({
          where: { adminId, slug: In(slugs) },
          relations: ['variants'],
        });

        const productMap = new Map(localProducts.map(p => [p.slug, p]));

        const items = [];
        for (const item of payload.cart_items) {
          const localProduct = productMap.get(item.product_slug);
          if (!localProduct) {
            const reason = `Missing product for slug ${item.product_slug}`;
            throw new BadRequestException(reason);
          }

          let matchedVariant = null;
          if (item.variant && item.variant.variation_props && item.variant.variation_props.length > 0) {
            const payloadAttrs: Record<string, string> = {};

            // [2025-12-24] Remember to trim values for accurate key matching
            item.variant.variation_props.forEach(prop => {
              const key = prop.name.trim();
              const val = prop.value.trim();
              payloadAttrs[key] = val;
            });

            const payloadKey = this.productsService.canonicalKey(payloadAttrs);
            matchedVariant = localProduct.variants.find(v => v.key === payloadKey);
          }

          if (!matchedVariant) {
            const reason = `No valid variant found for product ${item.product_slug}`;
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
          customerName: payload.full_name,
          phoneNumber: payload.phone,
          address: payload.address,
          city: payload.government || "Unknown",
          paymentMethod: payload.payment_method,
          paymentStatus: payload.status,
          shippingCost: payload.shipping_cost || 0,
          shippingCompanyId: null,
          discount: 0,
          items: items,
          notes: `Imported from ${p.displayName}) via Webhook`,
          storeId: String(store.id),

        };

        const User = { id: store.adminId, role: { name: 'admin' } };

        const newOrder = await this.ordersService.createWithManager(manager, adminId, User, createOrderDto);
        await this.ordersService.updateExternalId(newOrder.id, payload.externalId);
        await manager.update(OrderEntity, newOrder.id, { externalId: payload.externalId });


        this.logger.log(`[Webhook Order Create] Created new order from webhook with External ID ${payload.externalId} mapped to Internal Order #${newOrder.orderNumber} (ID: ${newOrder.id}).`);
        return { ok: true, orderId: newOrder.id };
      });
    } catch (error) {
      this.logger.error(`[Webhook Order Create] Error processing webhook order: ${error.message}`, error.stack);
      if (failureLog) {
        failureLog.status = OrderFailStatus.FAILED;
        failureLog.reason = error.message;
        await this.failureRepo.save(failureLog);
      } else {
        const externalId = payload?.externalId || 'UNKNOWN';
        const customerName = payload?.full_name?.trim() || 'N/A';
        await this.logFailedWebhookOrder(
          adminId,
          store,
          rawBody,
          `${error.message}`,
          externalId,
          customerName,
          payload?.phone
        );
      }
      return { ok: false, ignored: true, reason: 'processing_error' };
    }
  }

  async handleWebhookOrderCreate(provider: string, body: any, headers: Record<string, any>, adminId: string, req: any) {
    const p = this.getProvider(provider);
    const store = await this.storesRepo.findOne({ where: { provider: p.code, adminId } });
    if (!store) {
      this.logger.warn(`[Webhook Order Create] could not locate store for provider=${provider}`);
      return { ok: true, ignored: true, reason: 'store_not_found' };
    }
    if (!store.isActive) {
      this.logger.warn(`[Webhook Order Create] Store "${store.name}" (ID: ${store.id}) is not active. Ignoring webhook order create.`);
      return;
    }

    if (store.provider !== p.code) {
      this.logger.warn(`[Webhook Order Create] Store "${store.name}" (ID: ${store.id}) provider mismatch. Expected ${p.code} but got ${store.provider}. Ignoring webhook order create.`);
      return;
    }

    const isAuthed = p.verifyWebhookAuth(headers, body, store, req, "create");
    if (!isAuthed) {
      return { ok: true, ignored: true, reason: 'auth_failed' };
    }

    const payload = await p.mapWebhookCreate(body, store);
    return this.processMappedWebhookOrder(adminId, store, payload, body);
  }

  async handleWebhookOrderUpdate(provider: string, body: any, headers: Record<string, any>, req: any) {
    const p = this.getProvider(provider);
    const payload = p.mapWebhookUpdate(body);
    const externalOrderId = payload?.externalId;
    const order = await this.ordersService.findByExternalId(externalOrderId);

    if (!order) {
      this.logger.warn(`[Webhook Order Update] Received status update for unknown order ${externalOrderId}`);
      return;
    }

    if (!order.storeId) {
      this.logger.warn(`[Webhook Order Update] Order ${order.orderNumber} does not have an associated storeId. Cannot process webhook status update.`);
      return;
    }
    const store = await this.storesRepo.findOne({ where: { id: Number(order.storeId) } });

    if (!store) {
      this.logger.warn(`[Webhook Order Update] Associated store with ID ${order.storeId} not found for Order #${order.orderNumber}. Cannot process webhook status update.`);
      return;
    }

    if (!store.isActive) {
      this.logger.warn(`[Webhook Order Update] Store "${store.name}" (ID: ${store.id}) associated with Order #${order.orderNumber} is not active. Ignoring webhook status update.`);
      return;
    }

    if (store.provider !== p.code) {
      this.logger.warn(`[Webhook Order Update] Store "${store.name}" (ID: ${store.id}) provider mismatch. Expected ${p.code} but got ${store.provider}. Ignoring webhook status update for Order #${order.orderNumber}.`);
      return;
    }

    const creds = store.credentials || {};

    const isAuthed = p.verifyWebhookAuth(headers, body, store, req, "update");

    if (!isAuthed) {
      this.logger.warn(`[Webhook Order Update] Authentication failed for webhook status update on Order #${order.orderNumber}. Invalid signature.`);
      return { ok: true, ignored: true, reason: 'auth_failed' };
    }

    const statusEntity = await this.ordersService.findStatusByCode(payload.mappedStatus, order?.adminId.toString())
    if (order.status.code === payload.mappedStatus) {
      this.logger.log(`[Webhook Order Update] Received status update for Order #${order.orderNumber} but status is already "${payload.mappedStatus}". No update needed.`);
      return;
    }

    if (!payload.mappedStatus) {
      this.logger.warn(`[Webhook Order Update] Received unmapped status "${payload.remoteStatus}" for Order #${order.orderNumber}. No corresponding internal status found. Ignoring update.`);
      return;
    }

    // 4. Update Status
    const User = { id: order?.adminId.toString(), role: { name: 'admin' } };

    await this.ordersService.changeStatus(User, order.id, {
      statusId: statusEntity.id,
      notes: `Status updated via Webhook from ${payload.remoteStatus} to ${payload.mappedStatus}`
    });

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

    // Filters
    if (q?.storeId) qb.andWhere("failure.storeId = :storeId", { storeId: Number(q.storeId) });

    // Date range
    if (q?.startDate) qb.andWhere("failure.created_at >= :startDate", { startDate: `${q.startDate}T00:00:00.000Z` });
    if (q?.endDate) qb.andWhere("failure.created_at <= :endDate", { endDate: `${q.endDate}T23:59:59.999Z` });
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



  async retryFailedOrder(me: any, failureId: number) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");


    return await this.dataSource.transaction(async (manager) => {
      const failureLog = await manager.findOne(WebhookOrderFailureEntity, {
        where: { id: failureId, adminId },
        relations: ['store'],
      });
      try {



        if (!failureLog || !failureLog.store) {
          throw new NotFoundException("Failure log or associated store not found");
        }

        if ([OrderFailStatus.RETRYING, OrderFailStatus.SUCCESS].includes(failureLog.status as any)) {
          throw new BadRequestException(`Cannot retry. Current status is: ${failureLog.status}`);
        }

        const store = failureLog.store;

        // 🔔 Emit retry started
        this.appGateway.emitWebhookRetryStatus(String(adminId), {
          failureId,
          status: OrderFailStatus.RETRYING,
          message: "Retry started",
        });

        const p = this.getProvider(store.provider);
        const payload = await p.mapWebhookCreate(failureLog.payload, store);

        failureLog.status = OrderFailStatus.RETRYING;
        failureLog.attempts += 1;
        await manager.save(failureLog);

        const slugsToSync = payload.cart_items.map(item => item.product_slug);
        await p.syncProductsFromProvider(store, slugsToSync, manager);

        const result = await this.processMappedWebhookOrder(
          adminId,
          store,
          payload,
          failureLog.payload,
          failureLog,
          manager
        );

        if (!result.ok) {

          // 🔴 Emit failed again
          this.appGateway.emitWebhookRetryStatus(String(adminId), {
            failureId,
            status: OrderFailStatus.FAILED,
            attempts: failureLog.attempts,
            message: result.reason,
          });

          throw new BadRequestException(`Retry failed again: ${result.reason}`);
        } else {
          failureLog.status = OrderFailStatus.SUCCESS;
          await manager.save(failureLog);
        }

        // 🟢 Emit success
        this.appGateway.emitWebhookRetryStatus(String(adminId), {
          failureId,
          status: OrderFailStatus.SUCCESS,
          orderId: result.orderId || null,
          attempts: failureLog.attempts,
          message: "Order successfully retried",
        });

        return {
          message: "Order successfully retried and created",
          orderId: result.orderId || null,
        };
      } catch (error) {
        failureLog.status = OrderFailStatus.FAILED;
        failureLog.reason = error.message || "Unknown error";
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

    // Filters
    if (q?.storeId) {
      qb.andWhere("failure.storeId = :storeId", {
        storeId: Number(q.storeId),
      });
    }

    if (q?.status) {
      qb.andWhere("failure.status = :status", {
        status: String(q.status),
      });
    }

    if (q?.startDate) {
      qb.andWhere("failure.created_at >= :startDate", {
        startDate: `${q.startDate}T00:00:00.000Z`,
      });
    }

    if (q?.endDate) {
      qb.andWhere("failure.created_at <= :endDate", {
        endDate: `${q.endDate}T23:59:59.999Z`,
      });
    }

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

  async queueRetryFailedOrder(me: any, failureId: number) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    // Fetch the failure log to get the store provider
    const failureLog = await this.failureRepo.findOne({
      where: { id: failureId, adminId },
      relations: ['store'],
    });

    if (!failureLog || !failureLog.store) {
      throw new NotFoundException("Failure log or associated store not found");
    }
    if ([OrderFailStatus.RETRYING, OrderFailStatus.SUCCESS].includes(failureLog.status as any)) {
      throw new BadRequestException(`Cannot retry. Current status is: ${failureLog.status}`);
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
      let localCategoryId: number | null = null;
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

}