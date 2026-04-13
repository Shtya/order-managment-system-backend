// --- File: src/products/products.controller.ts ---
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";
import { ProductsService } from "./products.service";

import {
  AdjustVariantStockDto,
  CreateProductDto,
  UpdateProductDto,
  UpsertProductSkusDto,
} from "dto/product.dto";

import { diskStorage } from "multer";
import { extname } from "path";
import { FileFieldsInterceptor, NoFilesInterceptor } from "@nestjs/platform-express";
import { Response } from "express";

const productsStorage = diskStorage({
  destination: "./uploads/products",
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `product-${uniqueSuffix}${extname(file.originalname)}`);
  },
});


export const multerOptions = {
  storage: productsStorage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new BadRequestException('Only image files are allowed!'), false);
    }
    cb(null, true);
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
};

function parseJsonField<T>(val: any, fallback: T): T {
  if (val === undefined || val === null || val === "") return fallback;
  if (typeof val !== "string") return val as T;
  try {
    return JSON.parse(val) as T;
  } catch {
    return fallback;
  }
}

function parseBool(val: any): boolean | undefined {
  if (val === undefined) return undefined;
  if (typeof val === "boolean") return val;
  if (typeof val === "string") return val === "true" || val === "1";
  return undefined;
}

function parseNumber(val: any): number | null | undefined {
  if (val === undefined) return undefined;
  if (val === null || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller("products")
@RequireSubscription()
export class ProductsController {
  constructor(private products: ProductsService) { }

  @Permissions("products.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.products.list(req.user, q);
  }

  @Permissions("products.read")
  @Get("export")
  async exportProducts(
    @Req() req: any,
    @Query() q: any,
    @Res() res: Response
  ) {
    const buffer = await this.products.exportProducts(req.user, q);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Products_export_${Date.now()}.xlsx`
    );

    return res.send(buffer);
  }

  @Permissions("products.read")
  @Get("summary")
  getSummary(@Req() req: any) {
    return this.products.getAdminSummary(req.user);
  }

  @Permissions("products.read")
  @Get("check-slug")
  async checkSlug(
    @Req() req: any,
    @Query("slug") slug: string,
    @Query("storeId") storeId?: string, // يأتي كـ string من الـ URL
    @Query("productId") productId?: string, // يأتي كـ string من الـ URL
  ) {

    const parsedStoreId = storeId ? Number(storeId) : undefined;

    // إذا فشل التحويل (مثلاً أرسل المستخدم نصاً بدلاً من رقم)
    if (storeId && isNaN(parsedStoreId)) {
      throw new BadRequestException("Invalid storeId format");
    }

    return this.products.checkSlug(req.user, slug, parsedStoreId, productId);
  }

  @Permissions("products.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.products.remove(req.user, Number(id));
  }

  @Permissions("products.read")
  @Get("search")
  searchProducts(@Req() req: any, @Query() q: any) {
    return this.products.searchWithSkus(req.user, q);
  }

  @Permissions("products.read")
  @Get("by-sku/:sku")
  getBySku(@Req() req: any, @Param("sku") sku: string) {
    return this.products.getBySku(req.user, sku);
  }

  @Permissions("products.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.products.get(req.user, Number(id));
  }

  @Permissions("products.read")
  @Get(":id/skus")
  getSkus(@Req() req: any, @Param("id") id: string) {
    return this.products.getSkus(req.user, Number(id));
  }

  @Permissions("products.update")
  @Put(":id/skus")
  upsertSkus(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: UpsertProductSkusDto
  ) {
    return this.products.upsertSkus(req.user, Number(id), body);
  }

  @Permissions("products.update")
  @Post(":id/skus/:variantId/adjust-stock")
  adjustStock(
    @Req() req: any,
    @Param("id") id: string,
    @Param("variantId") variantId: string,
    @Body() body: AdjustVariantStockDto
  ) {
    return this.products.adjustVariantStock(
      req.user,
      Number(id),
      Number(variantId),
      body
    );
  }

  @Permissions("products.create")
  @Post()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "purchaseReceiptAsset", maxCount: 1 },
      ],
      multerOptions
    )
  )
  create(
    @Req() req: any,
    @UploadedFiles()
    files: {
      purchaseReceiptAsset?: Express.Multer.File[];
    },
    @Body() body: any
  ) {
    const dto: CreateProductDto = {
      name: body.name,
      slug: body.slug,

      wholesalePrice: parseNumber(body.wholesalePrice) as any,
      salePrice: parseNumber(body.salePrice) as any,
      lowestPrice: parseNumber(body.lowestPrice) as any,
      storageRack: body.storageRack ?? null,

      categoryId: parseNumber(body.categoryId) as any,
      storeId: parseNumber(body.storeId) as any,
      warehouseId: parseNumber(body.warehouseId) as any,

      description: body.description ?? null,
      callCenterProductDescription: body.callCenterProductDescription ?? null,

      upsellingEnabled: parseBool(body.upsellingEnabled) ?? false,
      upsellingProducts: parseJsonField(body.upsellingProducts, []),

      // images are now linked via orphan file ids
      mainImage: body.mainImage ?? null,
      mainImageOrphanId: parseNumber(body.mainImageOrphanId) as any,
      imagesOrphanIds: parseJsonField(body.imagesOrphanIds, []),
      images: parseJsonField(body.imagesMeta, []),
      combinations: parseJsonField(body.combinations, []),
      purchase: parseJsonField(body.purchase, undefined),
    } as any;

    const purchaseReceipt = files?.purchaseReceiptAsset?.[0];

    if (!dto.mainImageOrphanId) {
      throw new BadRequestException("mainImageOrphanId is required");
    }

    if (purchaseReceipt && dto.purchase) {
      dto.purchase.receiptAsset = `/uploads/products/${purchaseReceipt.filename}`;
    }

    return this.products.create(req.user, dto);
  }

  @Permissions("products.update")
  @UseInterceptors(NoFilesInterceptor())
  @Patch(":id")
  update(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any
  ) {
    const dto: UpdateProductDto = {
      name: body.name,
      slug: body.slug,
      wholesalePrice: parseNumber(body.wholesalePrice) as any,
      salePrice: parseNumber(body.salePrice) as any,
      lowestPrice: parseNumber(body.lowestPrice) as any,
      storageRack: body.storageRack,

      categoryId:
        body.categoryId !== undefined
          ? (parseNumber(body.categoryId) as any)
          : undefined,
      storeId:
        body.storeId !== undefined ? (parseNumber(body.storeId) as any) : undefined,
      warehouseId:
        body.warehouseId !== undefined
          ? (parseNumber(body.warehouseId) as any)
          : undefined,

      description: body.description,
      callCenterProductDescription: body.callCenterProductDescription,

      upsellingEnabled:
        body.upsellingEnabled !== undefined
          ? (parseBool(body.upsellingEnabled) as any)
          : undefined,

      upsellingProducts:
        body.upsellingProducts !== undefined
          ? parseJsonField(body.upsellingProducts, [])
          : undefined,

      mainImageOrphanId:
        body.mainImageOrphanId !== undefined
          ? (parseNumber(body.mainImageOrphanId) as any)
          : undefined,
      imagesOrphanIds:
        body.imagesOrphanIds !== undefined
          ? parseJsonField(body.imagesOrphanIds, [])
          : undefined,
      imagesMeta:
        body.imagesMeta !== undefined
          ? parseJsonField(body.imagesMeta, [])
          : undefined,

      // ✅ NEW
      removeImgs:
        body.
          removedImages !== undefined ? parseJsonField(body.
            removedImages, []) : undefined,
    } as any;
    return this.products.update(req.user, Number(id), dto);
  }


}
