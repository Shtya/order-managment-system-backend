// --- File: src/dto/product.dto.ts ---
import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { OmitType, PartialType } from "@nestjs/mapped-types";
import { Money, ProductImage } from "entities/sku.entity";
import { CreatePurchaseDto } from "./purchase.dto";

export class UpsellingProductDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  callCenterDescription?: string;
}

export class CreateSkuItemDto {
  // @IsOptional()
  // @IsString()
  // @MaxLength(500)
  // key?: string; // allow generating from attributes

  // @IsOptional()
  // @IsString()
  // @MaxLength(120)
  // sku?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: Money; // ✅ NEW: price per variant

  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;

  @IsOptional()
  @IsNumber()
  stockOnHand?: number;

  @IsOptional()
  @IsNumber()
  reserved?: number;
}

export class CreatePurchaseWithProductDto extends OmitType(CreatePurchaseDto, ['items']) {

}
export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'The slug must contain only lowercase English letters, numbers, and dashes (e.g., product-name-101)',
  })
  slug!: string;

  @IsOptional()
  @Min(0)
  wholesalePrice?: Money;

  @IsOptional()
  @Min(0)
  lowestPrice?: Money;

  @IsOptional()
  @Min(0)
  salePrice?: Money;

  @IsOptional()
  @IsString()
  storageRack?: string | null;

  @IsOptional()
  categoryId?: string;

  @IsOptional()
  storeId?: string | null;

  @IsOptional()
  @Min(0)
  warehouseId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  callCenterProductDescription?: string | null;

  @IsOptional()
  @IsBoolean()
  upsellingEnabled?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpsellingProductDto)
  upsellingProducts?: UpsellingProductDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  mainImage?: string;

  @IsOptional()
  mainImageOrphanId?: string;

  @IsOptional()
  @IsArray()
  images?: ProductImage[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  imagesOrphanIds?: string[];

  // ✅ create combinations with product
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSkuItemDto)
  combinations?: CreateSkuItemDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CreatePurchaseWithProductDto)
  purchase?: CreatePurchaseWithProductDto;
}

export class UpdateProductDto extends PartialType(CreateProductDto) {
  // ✅ NEW: remove images by url
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  removeImgs?: string[];
}

export class UpsertSkuItemDto {
  // @IsString()
  // @IsNotEmpty()
  // key!: string;

  // @IsOptional()
  // @IsString()
  // @MaxLength(120)
  // sku?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: "price must be a number" })
  @Min(0)
  price?: Money; // ✅ NEW: price per variant

  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;

  @IsOptional()
  @IsNumber()
  stockOnHand?: number;

  @IsOptional()
  @IsNumber()
  reserved?: number;
}

export class UpsertProductSkusDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpsertSkuItemDto)
  items!: UpsertSkuItemDto[];
}

export class AdjustVariantStockDto {
  @IsNumber()
  delta!: number;
}
