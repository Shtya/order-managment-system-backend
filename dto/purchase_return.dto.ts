// dto/purchase_return.dto.ts
import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Min, ValidateNested } from "class-validator";
import { ApprovalStatus, PurchaseReturnType, ReturnStatus } from "common/enums";

export class PurchaseReturnItemDto {
@IsString() variantId: string;
  @IsInt() @Min(1) returnedQuantity: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) unitCost: number;

  @IsOptional() @IsBoolean() taxInclusive?: boolean;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) taxRate?: number;
}

export class CreatePurchaseReturnDto {
  @IsString() returnNumber: string;

  @IsOptional() @IsInt() supplierId?: string;
  @IsOptional() @IsString() supplierNameSnapshot?: string;
  @IsOptional() @IsString() supplierCodeSnapshot?: string;

  @IsOptional() @IsString() invoiceNumber?: string;
  @IsOptional() @IsString() returnReason?: string;

  @IsOptional() @IsString() safeId?: string;

  @IsOptional() @IsEnum(PurchaseReturnType) returnType?: PurchaseReturnType;

  @IsOptional() @IsString() notes?: string;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) paidAmount?: number;

  @IsOptional() @IsString() receiptAsset?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseReturnItemDto)
  items: PurchaseReturnItemDto[];
}

export class UpdatePurchaseReturnDto extends CreatePurchaseReturnDto {
  @IsOptional() @IsEnum(ApprovalStatus) status?: ApprovalStatus;
}

export class UpdatePurchaseReturnStatusDto {
  @IsEnum(ApprovalStatus) status: ApprovalStatus;
}


export class UpdatePaidAmountDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) paidAmount: number;
}