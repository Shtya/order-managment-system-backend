/**
 * TEMPORARY. Delete this file and its StoresModule registration after the one-time image repair.
 * No auth. The path is the only gate.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { SkipThrottle } from "@nestjs/throttler";
import { Repository } from "typeorm";
import { StoreEntity, StoreProvider } from "entities/stores.entity";
import { ProductEntity, ProductImage } from "entities/sku.entity";
import { ProductSyncStateEntity } from "entities/product_sync_error.entity";
import { ShopifyService } from "./storesIntegrations/ShopifyService";

const TEMP_ADMIN_ID = process.env.TEMP_ADMIN_ID;
const TEMP_SHOPIFY_STORE_URL = process.env.TEMP_SHOPIFY_STORE_URL;
const TEMP_SHOPIFY_CLIENT_KEY = process.env.TEMP_SHOPIFY_CLIENT_KEY;
const TEMP_SHOPIFY_CLIENT_SECRET = process.env.TEMP_SHOPIFY_CLIENT_SECRET;

@SkipThrottle({ default: true })
@Controller(
  "ops/repair/shopify-product-images/k7m2p9qx4n8w1r6t3v5c0bylhdafue/20261001-a9e3",
)
export class TempShopifyImageRepairController {
  private readonly logger = new Logger(TempShopifyImageRepairController.name);

  constructor(
    private readonly shopifyService: ShopifyService,
    @InjectRepository(StoreEntity)
    private readonly storesRepo: Repository<StoreEntity>,
    @InjectRepository(ProductEntity)
    private readonly productsRepo: Repository<ProductEntity>,
    @InjectRepository(ProductSyncStateEntity)
    private readonly productSyncStateRepo: Repository<ProductSyncStateEntity>,
  ) {}

  @Get()
  async repairImages() {
    if (
      !TEMP_ADMIN_ID ||
      !TEMP_SHOPIFY_STORE_URL ||
      !TEMP_SHOPIFY_CLIENT_KEY ||
      !TEMP_SHOPIFY_CLIENT_SECRET
    ) {
      throw new BadRequestException(
        "Fill TEMP_ADMIN_ID, TEMP_SHOPIFY_STORE_URL, TEMP_SHOPIFY_CLIENT_KEY, and TEMP_SHOPIFY_CLIENT_SECRET, then delete this endpoint after the run.",
      );
    }

    const normalizedUrl = (TEMP_SHOPIFY_STORE_URL as string)
      .trim()
      .replace(/^https?:\/\/(www\.)?/i, "")
      .replace(/\/$/, "");

    const store = await this.storesRepo
      .createQueryBuilder("store")
      .where("store.adminId = :adminId", { adminId: TEMP_ADMIN_ID })
      .andWhere("store.provider = :provider", {
        provider: StoreProvider.SHOPIFY,
      })
      .andWhere(
        `(store."storeUrl" = :storeUrl OR store."normalizedStoreUrl" = :normalizedUrl)`,
        {
          storeUrl: TEMP_SHOPIFY_STORE_URL,
          normalizedUrl,
        },
      )
      .getOne();

    if (!store) {
      throw new BadRequestException(
        "Shopify store was not found for the static admin and store URL.",
      );
    }

    const apiStore = {
      ...store,
      storeUrl: TEMP_SHOPIFY_STORE_URL,
      credentials: {
        ...(store.credentials || {}),
        apiKey: TEMP_SHOPIFY_CLIENT_KEY,
        clientSecret: TEMP_SHOPIFY_CLIENT_SECRET,
      },
    } as StoreEntity;

    const remoteProducts =
      await this.shopifyService.getAllMappedProducts(apiStore);

    let updated = 0;
    let skippedNotLinked = 0;
    let skippedNoRemoteImage = 0;
    let skippedAlreadyHasImages = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const remoteProduct of remoteProducts) {
      const remoteId = String(remoteProduct.id);
      try {
        const syncState = await this.productSyncStateRepo
          .createQueryBuilder("sync")
          .leftJoinAndSelect("sync.product", "product")
          .leftJoinAndSelect("sync.bundle", "bundle")
          .where("sync.adminId = :adminId", { adminId: TEMP_ADMIN_ID })
          .andWhere("sync.storeId = :storeId", { storeId: store.id })
          .andWhere("sync.remoteProductId = :remoteProductId", {
            remoteProductId: remoteId,
          })
          .andWhere("sync.externalStoreId = :externalStoreId", {
            externalStoreId: store.externalStoreId,
          })
          .andWhere(
            `
            (
              (sync.productId IS NOT NULL AND product.isActive = true)
              OR
              (sync.bundleId IS NOT NULL AND bundle.isActive = true)
            )
          `,
          )
          .getOne();

        if (!syncState?.productId) {
          skippedNotLinked++;
          continue;
        }

        const localProduct = syncState.product;
        const hasMainImage = Boolean(localProduct?.mainImage?.trim());
        const hasGallery =
          Array.isArray(localProduct?.images) &&
          localProduct.images.some((img) => Boolean(img?.url?.trim()));
        if (hasMainImage || hasGallery) {
          skippedAlreadyHasImages++;
          continue;
        }

        const mainImage = (
          remoteProduct.thumb ||
          remoteProduct.images?.[0] ||
          ""
        ).trim();
        const gallery = (remoteProduct.images || [])
          .map((url) => String(url || "").trim())
          .filter((url) => url && url !== mainImage);

        if (!mainImage) {
          skippedNoRemoteImage++;
          continue;
        }

        const images: ProductImage[] = gallery
          .map((url) => ({ url }));

        // await this.productsRepo.update(syncState.productId, {
        //   mainImage,
        //   images,
        // });
        updated++;
      } catch (error: any) {
        failed++;
        const message = error?.message || "Unknown error";
        errors.push(
          `Product "${remoteProduct.name}" (Remote ID: ${remoteId}): ${message}`,
        );
        this.logger.error(
          `[Temp image repair] Failed for remote product ${remoteId}: ${message}`,
        );
      }
    }
    console.log("--------------------------------");
    console.log("Updated:", updated);
    console.log("Skipped not linked:", skippedNotLinked);
    console.log("Skipped no remote image:", skippedNoRemoteImage);
    console.log("Skipped already has images:", skippedAlreadyHasImages);
    console.log("Failed:", failed);
    console.log("Errors:", errors);
    console.log("--------------------------------");
    return {
      total: remoteProducts.length,
      updated,
      skippedNotLinked,
      skippedNoRemoteImage,
      skippedAlreadyHasImages,
      failed,
      errors,
    };
  }
}
