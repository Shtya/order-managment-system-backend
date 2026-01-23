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
  MaxLength,
  ValidateNested,
} from "class-validator";
import { PartialType } from "@nestjs/mapped-types";
import { Money, ProductImage } from "entities/sku.entity";

export class UpsellingProductDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  callCenterDescription?: string;
}

export class CreateSkuItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  key?: string; // allow generating from attributes

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sku?: string | null;

  @IsOptional()
  @IsNumber()
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

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  wholesalePrice?: Money;

  @IsOptional()
  lowestPrice?: Money;

  @IsOptional()
  @IsString()
  storageRack?: string | null;

  @IsOptional()
  @IsInt()
  categoryId?: number | null;

  @IsOptional()
  @IsInt()
  storeId?: number | null;

  @IsOptional()
  @IsInt()
  warehouseId?: number | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsString()
  callCenterProductDescription?: string | null;

  @IsOptional()
  @IsBoolean()
  upsellingEnabled?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpsellingProductDto)
  upsellingProducts?: UpsellingProductDto[];

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  mainImage!: string;

  @IsOptional()
  @IsArray()
  images?: ProductImage[];

  // ✅ create combinations with product
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSkuItemDto)
  combinations?: CreateSkuItemDto[];
}

export class UpdateProductDto extends PartialType(CreateProductDto) {
  // ✅ NEW: remove images by url
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  removeImgs?: string[];
}

export class UpsertSkuItemDto {
  @IsString()
  @IsNotEmpty()
  key!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sku?: string | null;

  @IsOptional()
  @IsNumber()
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
