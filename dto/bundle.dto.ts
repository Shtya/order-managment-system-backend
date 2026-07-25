// --- File: src/dto/bundle.dto.ts ---
import { Transform, Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { OmitType, PartialType } from "@nestjs/mapped-types";
import { i18nValidationMessage } from "nestjs-i18n";
import { ProductImage } from "entities/sku.entity";

export class BundleItemDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  variantId!: string;

  @IsInt({message: i18nValidationMessage('validation.is_int')})
  qty!: number;
}

export class CreateBundleDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(200, {message: i18nValidationMessage('validation.max_length')})
  name!: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional() // Description is usually optional
  @MaxLength(2000, { message: i18nValidationMessage('validation.max_length') }) // Matches your Yup schema
  description?: string;

  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Min(1, {message: i18nValidationMessage('validation.min')})
  price!: number;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  storeId?: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  categoryId?: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
  sku!: string;

  @Transform(({ value }) => typeof value === 'string' ? value.toLowerCase().trim() : value)
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  @MaxLength(300, { message: i18nValidationMessage('validation.max_length') })
  @Matches(/^[a-z0-9-_]+$/, {
    message: i18nValidationMessage('validation.slug_product_format'),
  })
  slug?: string;

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

  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @ArrayMinSize(1, {message: i18nValidationMessage('validation.array_min_size')})
  @ValidateNested({ each: true })
  @Type(() => BundleItemDto)
  items!: BundleItemDto[];
}

export class UpdateBundleDto extends PartialType(
  OmitType(CreateBundleDto, ['sku'] as const),
) {
  @IsOptional()
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @ValidateNested({ each: true })
  @Type(() => BundleItemDto)
  items?: BundleItemDto[];

  @IsOptional()
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @IsString({ each: true })
  removeImgs?: string[];
}
