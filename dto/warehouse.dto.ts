import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { i18nValidationMessage } from "nestjs-i18n";


export class CreateWarehouseDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
  name!: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(160, { message: i18nValidationMessage('validation.max_length') })
  address?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  description?: string;

  @IsOptional()
  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  isActive?: boolean;
}

export class UpdateWarehouseDto {
  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
  name?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(160, { message: i18nValidationMessage('validation.max_length') })
  address?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  description?: string;

  @IsOptional()
  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  isActive?: boolean;
}
