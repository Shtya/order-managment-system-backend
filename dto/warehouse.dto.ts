import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { i18nValidationMessage } from "nestjs-i18n";


export class CreateWarehouseDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
  name!: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(160, { message: i18nValidationMessage('validation.max_length') })
  location?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(30, { message: i18nValidationMessage('validation.max_length') })
  phone?: string;

  // ✅ relation to user
  @IsOptional()
@IsString({message: i18nValidationMessage('validation.is_string')})
  managerUserId?: string | null;

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
  location?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(30, { message: i18nValidationMessage('validation.max_length') })
  phone?: string;

  @IsOptional()
  @IsInt({message: i18nValidationMessage('validation.is_int')})
  managerUserId?: string | null;

  @IsOptional()
  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  isActive?: boolean;
}
