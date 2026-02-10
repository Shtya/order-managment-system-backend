import { BadRequestException, forwardRef, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Not, Repository } from "typeorm";
import { StoreEntity, StoreProvider, SyncStatus } from "entities/stores.entity";
import { CreateStoreDto, EasyOrderIntegrationsDto, ShopifyIntegrationsDto, UpdateStoreDto } from "dto/stores.dto";
import { EncryptionService } from "common/encryption.service";
import { tenantId } from "src/category/category.service";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CategoryEntity } from "entities/categories.entity";
import { EasyOrderQueueService } from "./storesIntegrations/queues";
import { ProductEntity } from "entities/sku.entity";
import { OrderEntity } from "entities/order.entity";
import { RedisService } from "common/redis/RedisService";
import { EasyOrderService } from "./storesIntegrations/EasyOrderService";


@Injectable()
export class StoresService {
  private readonly logger = new Logger(StoresService.name);

  constructor(
    private readonly encryptionService: EncryptionService,
    protected readonly redisService: RedisService,
    protected readonly easyOrderQueueService: EasyOrderQueueService,
    @InjectRepository(StoreEntity) private readonly storesRepo: Repository<StoreEntity>,
  ) { }

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
      "store.code",
      "store.provider",
      "store.isActive",
      "store.syncStatus",
      "store.autoSync",
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
        "(store.name ILIKE :s OR store.code ILIKE :s OR store.storeUrl ILIKE :s)",
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

    // 1. Check 
    // uniqueness for this tenant
    const trimmedCode = dto.code.trim();
    const [existingCode, existingProvider] = await Promise.all([
      this.storesRepo.findOne({ where: { adminId, code: trimmedCode } }),
      this.storesRepo.findOne({ where: { adminId, provider: dto.provider } }),
    ]);

    if (existingCode) {
      throw new BadRequestException(`Store code "${trimmedCode}" is already in use.`);
    }


    if (existingProvider) {
      throw new BadRequestException(
        `You have already configured a store with the ${dto.provider} provider.`
      );
    }

    // 2. Encrypt the sensitive integrations object
    // We trim all keys/values inside the object before stringifying
    const trimmedIntegrations = this.trimObjectValues(dto.integrations);
    const { ciphertext, iv, tag } = await this.encryptionService.encrypt(
      JSON.stringify(trimmedIntegrations)
    );

    // 3. Create and Save
    const store = this.storesRepo.create({
      ...dto,
      name: dto.name.trim(),
      code: dto.code.trim(),
      storeUrl: dto.storeUrl.trim(),
      adminId,
      encryptedData: ciphertext,
      iv,
      tag,
      syncStatus: SyncStatus.PENDING,
    });

    const savedStore = await this.storesRepo.save(store);
    return this.getMaskedStoreIntegrations(savedStore);
  }

  private async removeAuthCashe(storeId: number) {
    const cacheKey = `store_auth:${storeId}`;
    await this.redisService.del(cacheKey);
    this.logger.log(`Cache cleared for store ${storeId}.`);
  }

  async update(me: any, id: number, dto: UpdateStoreDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(`Store not found`);

    // If integrations are provided, re-encrypt them
    if (dto.integrations) {
      // Decrypt existing integrations first to merge
      const existingIntegrations = await this.getDecryptedIntegrations(store);

      // Merge: New values overwrite old ones
      const mergedIntegrations = {
        ...existingIntegrations,
        ...this.trimObjectValues(dto.integrations)
      };

      await this.validateIntegrations(store.provider, mergedIntegrations);

      const { ciphertext, iv, tag } = await this.encryptionService.encrypt(
        JSON.stringify(mergedIntegrations)
      );

      store.encryptedData = ciphertext;
      store.iv = iv;
      store.tag = tag;
    }

    if (dto.code) {
      const trimmedCode = dto.code.trim();
      if (trimmedCode !== store.code) {
        const existingCode = await this.storesRepo.findOne({
          where: { adminId, code: trimmedCode }
        });

        if (existingCode) {
          throw new BadRequestException(`Store code "${trimmedCode}" is already in use.`);
        }
        store.code = trimmedCode;
      }
    }

    // Update other fields with trimming
    if (dto.name) store.name = dto.name.trim();
    if (dto.storeUrl) store.storeUrl = dto.storeUrl.trim();
    if (dto.isActive !== undefined) store.isActive = dto.isActive;
    if (dto.autoSync !== undefined) store.autoSync = dto.autoSync;

    const savedStore = await this.storesRepo.save(store);

    await this.removeAuthCashe(savedStore.id);

    return this.getMaskedStoreIntegrations(savedStore);
  }

  async checkCodeExists(me: any, code: string): Promise<boolean> {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    // .exists() returns a boolean directly (true if found, false if not)
    // We trim the code to ensure accurate comparison
    return await this.storesRepo.exists({
      where: {
        adminId,
        code: code.trim()
      }
    });
  }

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

  private trimObjectValues(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj;

    return Object.keys(obj).reduce((acc, key) => {
      const value = obj[key];
      acc[key] = typeof value === 'string' ? value.trim() : value;
      return acc;
    }, {});
  }
  private async validateIntegrations(provider: StoreProvider, data: any) {
    let schema: any;

    switch (provider) {
      case StoreProvider.SHOPIFY:
        schema = ShopifyIntegrationsDto;
        break;
      case StoreProvider.EASYORDER:
        schema = EasyOrderIntegrationsDto;
        break;
      default:
        return; // Skip for 'custom'
    }

    const instance = plainToInstance(schema, data);

    // 2. Validate against the DTO decorators
    const errors = await validate(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    if (errors.length > 0) {

      const messages = errors.flatMap((error) =>
        Object.values(error.constraints || {})
      );


      throw new BadRequestException(messages);
    }
  }

  async getDecryptedIntegrations(store: StoreEntity) {
    const decrypted = await this.encryptionService.decrypt(
      store.encryptedData,
      store.iv,
      store.tag
    );
    return JSON.parse(decrypted);
  }

  async getMaskedStoreIntegrations(store: StoreEntity) {
    // We decrypt internally just to see which keys exist
    const decrypted = await this.getDecryptedIntegrations(store);
    const masked: any = {};

    Object.keys(decrypted).forEach(key => {
      const value = decrypted[key];
      // Show only first 4 and last 4 characters, or just stars
      masked[key] = value.length > 8
        ? `${value.substring(0, 4)}****************${value.slice(-4)}`
        : "****************";
    });

    const { encryptedData, tag, iv, ...storeData } = store;
    return {
      ...storeData,
      integrations: masked
    };

  }

  async syncCategoryToAllStores(category: CategoryEntity, slug?: string) {
    const { adminId, name, id } = category;

    // Get active stores
    const activeStores = await this.storesRepo.find({
      where: { adminId, isActive: true, autoSync: true }
    });

    if (activeStores.length === 0) {
      this.logger.warn(`[Category Sync] No active/auto-sync stores found for Admin ${adminId}. Skipping.`);
      return;
    }
    //  Queue the jobs
    const promises = activeStores.map(store => {
      if (store.provider === StoreProvider.EASYORDER) {
        // Enqueue to GroupMQ!
        return this.easyOrderQueueService.enqueueCategorySync(category, store.id, slug);
      }
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
      where: { id: storeId, adminId, isActive: true, autoSync: true }
    });

    if (!store) {
      this.logger.warn(`[Product Sync] No active/auto-sync store found (ID: ${storeId}) for Product: "${name}". Skipping.`);
      return;
    }
    // Route to the correct queue based on Provider
    if (store.provider === StoreProvider.EASYORDER) {
      await this.easyOrderQueueService.enqueueProductSync(product.id, product.adminId, store.id, slug);
      this.logger.log(
        `[Product Sync] Dispatched sync job for Product: "${name}" (ID: ${id}) ` +
        `to Store: "${store.name}" (ID: ${store.id}) for Admin: ${adminId}. ` +
        `${slug ? `(Slug update detected from: ${slug})` : ''}`
      );
    }
  }

  async syncOrderStatus(order: OrderEntity) {
    const { adminId, orderNumber, id } = order;

    const store = await this.storesRepo.findOne({
      where: { adminId, isActive: true, autoSync: true }
    });

    if (!store) {
      this.logger.warn(`[Order Status Sync] No active store found to sync Order #${orderNumber} for Admin ${adminId}.`);
      return;
    }

    // Route to the correct queue based on Provider
    if (store.provider === StoreProvider.EASYORDER) {
      await this.easyOrderQueueService.enqueueOrderStatusSync(order, store.id);

      this.logger.log(
        `[Order Status Sync] Dispatched status update for Order #${orderNumber} (ID: ${id}) ` +
        `to Store: "${store.name}" (ID: ${store.id}) for Admin: ${adminId}.`
      );
    }
  }

  async manualSync(me: any, id: number) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const store = await this.storesRepo.findOne({ where: { id, adminId } });
    if (!store) throw new NotFoundException(`Store with ID ${id} not found`);

    if (!store.isActive) throw new BadRequestException("Cannot sync an inactive store");

    // Route to the correct queue based on Provider
    if (store.provider === StoreProvider.EASYORDER) {
      await this.easyOrderQueueService.enqueueFullStoreSync(store);

      this.logger.log(
        `[Manual Full Sync] Dispatched full catalog sync for Store: "${store.name}" (ID: ${id}) ` +
        `initiated by Admin: ${adminId}.`
      );
    } else {
      throw new BadRequestException(`Manual sync not implemented for ${store.provider}`);
    }

    return {
      message: `Full synchronization job for "${store.name}" has been queued.`,
      storeId: id
    };
  }
}