import { IsString, IsOptional, IsEmail, MaxLength, IsArray, IsNumber, IsIn } from "class-validator";
import { i18nValidationMessage } from "nestjs-i18n";


export class CreateSupplierDto {
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
	name: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(200, { message: i18nValidationMessage('validation.max_length') })
	address?: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	description?: string;

	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(30, { message: i18nValidationMessage('validation.max_length') })
	phone: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(10, { message: i18nValidationMessage('validation.max_length') })
	phoneCountry?: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(30, { message: i18nValidationMessage('validation.max_length') })
	secondPhone?: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(10, { message: i18nValidationMessage('validation.max_length') })
	secondPhoneCountry?: string;

	@IsOptional()
	@IsEmail({}, {message: i18nValidationMessage('validation.is_email')})
	@MaxLength(100, { message: i18nValidationMessage('validation.max_length') })
	email?: string;

	@IsArray({message: i18nValidationMessage('validation.is_array')})
	categoryIds: string[];
}

export class UpdateSupplierDto {
	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
	name?: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(200, { message: i18nValidationMessage('validation.max_length') })
	address?: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	description?: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(30, { message: i18nValidationMessage('validation.max_length') })
	phone?: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(10, { message: i18nValidationMessage('validation.max_length') })
	phoneCountry?: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(30, { message: i18nValidationMessage('validation.max_length') })
	secondPhone?: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(10, { message: i18nValidationMessage('validation.max_length') })
	secondPhoneCountry?: string;

	@IsOptional()
	@IsEmail({}, {message: i18nValidationMessage('validation.is_email')})
	@MaxLength(100, { message: i18nValidationMessage('validation.max_length') })
	email?: string;

	@IsArray({message: i18nValidationMessage('validation.is_array')})
	categoryIds: string[];
}

export class UpdateSupplierFinancialsDto {
	@IsOptional()
	@IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
	dueBalance?: number;

	@IsOptional()
	@IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
	purchaseValue?: number;
}


export class CreateSupplierCategoryDto {
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(100, { message: i18nValidationMessage('validation.max_length') })
	name: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(500, { message: i18nValidationMessage('validation.max_length') })
	description?: string;
}

export class UpdateSupplierCategoryDto {
	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(100, { message: i18nValidationMessage('validation.max_length') })
	name?: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MaxLength(500, { message: i18nValidationMessage('validation.max_length') })
	description?: string;
}