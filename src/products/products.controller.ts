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
import { ProductsService } from "./products.service";

import {
  AdjustVariantStockDto,
  CreateProductDto,
  UpdateProductDto,
  UpsertProductSkusDto,
} from "dto/product.dto";

import { diskStorage } from "multer";
import { extname } from "path";
import { FileFieldsInterceptor } from "@nestjs/platform-express";

const productsStorage = diskStorage({
  destination: "./uploads/products",
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `product-${uniqueSuffix}${extname(file.originalname)}`);
  },
});

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

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("products")
export class ProductsController {
  constructor(private products: ProductsService) {}

  @Permissions("products.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.products.list(req.user, q);
  }

  @Permissions("products.read")
  @Get("export")
  exportExport(@Req() req: any, @Query() q: any, @Res() res: Response) {
    return this.products.export(req.user, q, res);
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
        { name: "mainImage", maxCount: 1 },
        { name: "images", maxCount: 20 },
      ],
      { storage: productsStorage }
    )
  )
  create(
    @Req() req: any,
    @UploadedFiles()
    files: {
      mainImage?: Express.Multer.File[];
      images?: Express.Multer.File[];
    },
    @Body() body: any
  ) {
    const dto: CreateProductDto = {
      name: body.name,

      wholesalePrice: parseNumber(body.wholesalePrice) as any,
      lowestPrice: parseNumber(body.lowestPrice) as any,
      storageRack: body.storageRack ?? null,

      categoryId: parseNumber(body.categoryId) as any,
      storeId: parseNumber(body.storeId) as any,
      warehouseId: parseNumber(body.warehouseId) as any,

      description: body.description ?? null,
      callCenterProductDescription: body.callCenterProductDescription ?? null,

      upsellingEnabled: parseBool(body.upsellingEnabled) ?? false,
      upsellingProducts: parseJsonField(body.upsellingProducts, []),

      mainImage: body.mainImage ?? null,
      images: parseJsonField(body.imagesMeta, []),
      combinations: parseJsonField(body.combinations, []),
    } as any;

    const main = files?.mainImage?.[0];
    const imgs = files?.images ?? [];

    if (main) {
      dto.mainImage = `/uploads/products/${main.filename}`;
    } else if (!dto.mainImage) {
      throw new BadRequestException("mainImage is required");
    }

    if (imgs.length) {
      const uploaded = imgs.map((f) => ({
        url: `/uploads/products/${f.filename}`,
      }));
      dto.images = [...(dto.images ?? []), ...uploaded];
    }

    return this.products.create(req.user, dto);
  }

  @Permissions("products.update")
  @Patch(":id")
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "mainImage", maxCount: 1 },
        { name: "images", maxCount: 20 },
      ],
      { storage: productsStorage }
    )
  )
  update(
    @Req() req: any,
    @Param("id") id: string,
    @UploadedFiles()
    files: {
      mainImage?: Express.Multer.File[];
      images?: Express.Multer.File[];
    },
    @Body() body: any
  ) {
    const dto: UpdateProductDto = {
      name: body.name,

      wholesalePrice: parseNumber(body.wholesalePrice) as any,
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

      // ✅ NEW
      removeImgs:
        body.removeImgs !== undefined ? parseJsonField(body.removeImgs, []) : undefined,
    } as any;

    const main = files?.mainImage?.[0];
    const imgs = files?.images ?? [];

    if (main) (dto as any).mainImage = `/uploads/products/${main.filename}`;

    if (imgs.length) {
      const uploaded = imgs.map((f) => ({
        url: `/uploads/products/${f.filename}`,
      }));
      (dto as any)._appendImages = uploaded;
    }

    return this.products.update(req.user, Number(id), dto);
  }

  @Permissions("products.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.products.remove(req.user, Number(id));
  }
}
