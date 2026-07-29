import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { i18nValidationMessage } from "nestjs-i18n";
import { StorageLocationType } from "entities/warehouses.entity";

export class CreateStorageLocationDto {
	@IsString({ message: i18nValidationMessage('validation.is_string') })
	@IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
	@MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
	name!: string;

	@IsEnum(StorageLocationType, { message: i18nValidationMessage('validation.is_enum') })
	type!: StorageLocationType;

	@IsOptional()
	@IsString({ message: i18nValidationMessage('validation.is_string') })
	parentId?: string;

	@IsOptional()
	@IsString({ message: i18nValidationMessage('validation.is_string') })
	description?: string;
}

export class UpdateStorageLocationDto {
	@IsOptional()
	@IsString({ message: i18nValidationMessage('validation.is_string') })
	@IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
	@MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
	name?: string;

	// @IsOptional()
	// @IsEnum(StorageLocationType, { message: i18nValidationMessage('validation.is_enum') })
	// type?: StorageLocationType;

	// @IsOptional()
	// @IsString({ message: i18nValidationMessage('validation.is_string') })
	// parentId?: string | null;

	@IsOptional()
	@IsString({ message: i18nValidationMessage('validation.is_string') })
	description?: string;
}

