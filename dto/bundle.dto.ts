// --- File: src/dto/bundle.dto.ts ---
import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { PartialType } from "@nestjs/mapped-types";

export class BundleItemDto {
  @IsInt()
  variantId!: number;

  @IsInt()
  qty!: number;
}

export class CreateBundleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsOptional() // Description is usually optional
  @MaxLength(2000) // Matches your Yup schema
  description?: string;

  @IsInt()
  @Min(1)
  price!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  sku!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'At least one item is required' })
  @ValidateNested({ each: true })
  @Type(() => BundleItemDto)
  items!: BundleItemDto[];
}

export class UpdateBundleDto extends PartialType(CreateBundleDto) {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BundleItemDto)
  items?: BundleItemDto[];
}
