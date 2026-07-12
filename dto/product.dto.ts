// --- File: src/dto/product.dto.ts ---
import { Transform, Type } from "class-transformer";
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
import { Money, ProductImage, ProductType } from "entities/sku.entity";
import { CreatePurchaseDto } from "./purchase.dto";
import { i18nValidationMessage } from "nestjs-i18n";


export class UpsellingProductDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  productId!: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  label?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(1000, { message: i18nValidationMessage('validation.max_length') })
  callCenterDescription?: string;
}



export class CreateSkuItemDto {
  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(500, { message: i18nValidationMessage('validation.max_length') })
  key?: string; // allow generating from attributes

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
  @Matches(/^[a-zA-Z0-9-]+$/, {
    message: i18nValidationMessage('validation.sku_format'),
  })
  sku!: string;

  @IsOptional()
  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  @Min(0, {message: i18nValidationMessage('validation.min')})
  price?: Money; // ✅ NEW: price per variant

  @IsOptional()
  @IsObject({message: i18nValidationMessage('validation.is_object')})
  attributes?: Record<string, string>;

  @IsOptional()
  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  stockOnHand?: number;

  @IsOptional()
  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  isActive?: boolean = true;
}

export class CreatePurchaseWithProductDto extends OmitType(CreatePurchaseDto, ['items']) {

  @IsOptional()
  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  quantity?: number;

  @IsOptional()
  @Min(0, {message: i18nValidationMessage('validation.min')})
  wholesalePrice?: Money;

}
export class SingleSkuItemDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
  @Matches(/^[a-zA-Z0-9-]+$/, {
    message: i18nValidationMessage('validation.sku_format'),
  })
  sku!: string;

  @IsOptional()
  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  stockOnHand?: number;


  @IsOptional()
  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  isActive?: boolean = true;
}

export class CreateProductDto {
  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  type?: ProductType;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(200, { message: i18nValidationMessage('validation.max_length') })
  name!: string;

  @Transform(({ value }) => typeof value === 'string' ? value.toLowerCase().trim() : value)
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(300, { message: i18nValidationMessage('validation.max_length') })
  @Matches(/^[a-z0-9-_]+$/, {
    message: i18nValidationMessage('validation.slug_product_format'),
  })
  slug!: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
  @Matches(/^[a-zA-Z0-9-]+$/, {
    message: i18nValidationMessage('validation.sku_format'),
  })
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  sku!: string;


  @IsOptional()
  @Min(0, {message: i18nValidationMessage('validation.min')})
  wholesalePrice?: Money;

  @IsOptional()
  @Min(0, {message: i18nValidationMessage('validation.min')})
  lowestPrice?: Money;

  @IsOptional()
  @Min(0, {message: i18nValidationMessage('validation.min')})
  salePrice?: Money;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(200, { message: i18nValidationMessage('validation.max_length') })
  storageRack?: string | null;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  categoryId?: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  categoryName?: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  categorySlug?: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  storeId?: string | null;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  warehouseId?: string | null;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  remoteId?: string | null;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(7000, { message: i18nValidationMessage('validation.max_length') })
  description?: string | null;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(2000, { message: i18nValidationMessage('validation.max_length') })
  callCenterProductDescription?: string | null;

  @IsOptional()
  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  upsellingEnabled?: boolean;

  @IsOptional()
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @ValidateNested({ each: true })
  @Type(() => UpsellingProductDto)
  upsellingProducts?: UpsellingProductDto[];

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(500, { message: i18nValidationMessage('validation.max_length') })
  mainImage?: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  mainImageOrphanId?: string;

  @IsOptional()
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  images?: ProductImage[];

  @IsOptional()
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  imagesOrphanIds?: string[];


  // ✅ create combinations with product
  @IsOptional()
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @ValidateNested({ each: true })
  @Type(() => CreateSkuItemDto)
  combinations?: CreateSkuItemDto[];


  @IsOptional()
  @ValidateNested()
  @Type(() => CreatePurchaseWithProductDto)
  purchase?: CreatePurchaseWithProductDto;

  @IsOptional()
  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  skipRemoteCheck?: boolean;
}

export class UpdateProductDto extends PartialType(
  OmitType(CreateProductDto, ['type', 'sku'] as const),
) {
  // ✅ NEW: remove images by url
  @IsOptional()
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @IsString({ each: true })
  removeImgs?: string[];
}

export class UpsertSkuItemDto {
  // @IsString({message: i18nValidationMessage('validation.is_string')})
  // @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  // key!: string;

  // @IsOptional()
  // @IsString({message: i18nValidationMessage('validation.is_string')})
  // @MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
  // sku?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: i18nValidationMessage('validation.is_number') })
  @Min(0, {message: i18nValidationMessage('validation.min')})
  price?: Money; // ✅ NEW: price per variant

  @IsOptional()
  @IsObject({message: i18nValidationMessage('validation.is_object')})
  attributes?: Record<string, string>;

  @IsOptional()
  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  stockOnHand?: number;

  @IsOptional()
  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  reserved?: number;
}

export class UpsertProductSkusDto {
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @ValidateNested({ each: true })
  @Type(() => UpsertSkuItemDto)
  items!: UpsertSkuItemDto[];
}

export class AdjustVariantStockDto {
  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  delta!: number;
}

export class CheckSkusDto {
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @IsString({ each: true })
  skus!: string[];

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  productId?: string;
}
