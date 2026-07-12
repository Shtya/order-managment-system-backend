import { Transform } from "class-transformer";
import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { i18nValidationMessage } from "nestjs-i18n";

export class CreateCategoryDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(160, { message: i18nValidationMessage('validation.max_length') })
  name!: string;

  @Transform(({ value }) => typeof value === 'string' ? value.toLowerCase().trim() : value)
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(200, { message: i18nValidationMessage('validation.max_length') })
  @Matches(/^[a-z0-9-]+$/, {
     message: i18nValidationMessage('validation.slug_category_format'),
  })
  slug: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(400, { message: i18nValidationMessage('validation.max_length') })
  image?: string;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(160, { message: i18nValidationMessage('validation.max_length') })
  name?: string;

  @Transform(({ value }) => typeof value === 'string' ? value.toLowerCase().trim() : value)
  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(200, { message: i18nValidationMessage('validation.max_length') })
  @Matches(/^[a-z0-9-]+$/, {
     message: i18nValidationMessage('validation.slug_category_format'),
  })
  slug?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(400, { message: i18nValidationMessage('validation.max_length') })
  image?: string;

  @IsOptional()
  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  removeImage?: boolean;
}
