// dto/purchase.dto.ts
import { Type } from "class-transformer";
import { IsArray, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Min, ValidateNested } from "class-validator";
import { ApprovalStatus } from "common/enums";

export class PurchaseItemDto {
	@IsInt() variantId: number;
	@IsInt() @Min(1) quantity: number;
	@IsInt() @Min(0) purchaseCost: number;
}

export class CreatePurchaseDto {
	@IsInt() supplierId: number;
	@IsString() @IsNotEmpty() receiptNumber: string;
	safeId: any;

	@IsOptional() @IsInt() @Min(0) paidAmount?: number;
	@IsOptional() @IsString() notes?: string;

	// Receipt image as base64 string or file path
	@IsOptional() @IsString() receiptAsset?: string;

	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => PurchaseItemDto)
	items: PurchaseItemDto[];
}

export class UpdatePurchaseDto {
	@IsOptional() @IsInt() supplierId?: number;
	@IsOptional() @IsString() receiptNumber?: string;
	@IsOptional() safeId?: any;

	@IsOptional() @IsInt() @Min(0) paidAmount?: number;
	@IsOptional() @IsString() notes?: string;

	// Receipt image as base64 string or file path
	@IsOptional() @IsString() receiptAsset?: string;

	@IsOptional()
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => PurchaseItemDto)
	items?: PurchaseItemDto[];
}

export class UpdatePurchaseStatusDto {
	@IsEnum(ApprovalStatus) status: ApprovalStatus;
}

export class UpdatePaidAmountDto {
	@IsInt() @Min(0) paidAmount: number;
}



