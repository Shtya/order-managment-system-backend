// dto/purchase.dto.ts
import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested } from "class-validator";
import { ApprovalStatus } from "common/enums";
import { i18nValidationMessage } from "nestjs-i18n";


export class PurchaseItemDto {
	@IsString({message: i18nValidationMessage('validation.is_string')}) variantId: string;
	@IsInt({message: i18nValidationMessage('validation.is_int')}) @Min(1, {message: i18nValidationMessage('validation.min')}) quantity: number;
	@Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, {message: i18nValidationMessage('validation.min')}) purchaseCost: number;
}

export class CreatePurchaseDto {

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	supplierId?: string;

	@IsString({message: i18nValidationMessage('validation.is_string')}) @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')}) receiptNumber: string;
	@IsString({message: i18nValidationMessage('validation.is_string')}) @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')}) safeId: string;

	@IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, {message: i18nValidationMessage('validation.min')}) paidAmount?: number;
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) notes?: string;

	// Receipt image as base64 string or file path
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) receiptAsset?: string;

	@IsArray({message: i18nValidationMessage('validation.is_array')})
	@ValidateNested({ each: true })
	@Type(() => PurchaseItemDto)
	items: PurchaseItemDto[];

	@IsOptional()
	@IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
	saveAsDraft?: boolean;
}


export class UpdatePurchaseDto {
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) supplierId?: string;
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) receiptNumber?: string;
	@IsString({message: i18nValidationMessage('validation.is_string')}) @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')}) safeId: string;

	@IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, {message: i18nValidationMessage('validation.min')}) paidAmount?: number;
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) notes?: string;

	// Receipt image as base64 string or file path
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) receiptAsset?: string;

	@IsOptional()
	@IsArray({message: i18nValidationMessage('validation.is_array')})
	@ValidateNested({ each: true })
	@Type(() => PurchaseItemDto)
	items?: PurchaseItemDto[];
}

export class UpdatePurchaseStatusDto {
	@IsEnum(ApprovalStatus,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(ApprovalStatus).join(', ')], }); }}) status: ApprovalStatus;
}

export class UpdatePaidAmountDto {
	@IsInt({message: i18nValidationMessage('validation.is_int')}) @Min(0, {message: i18nValidationMessage('validation.min')}) paidAmount: number;
}



