// --- File: src/dto/bundle.dto.ts ---
import { Type } from "class-transformer";
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
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
  @IsNotEmpty()
  price!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  sku!: string;

  @IsArray()
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
