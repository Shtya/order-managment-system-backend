// dto/purchase_return.dto.ts
import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min, ValidateNested } from "class-validator";
import { PurchaseReturnType, ReturnStatus } from "common/enums";

export class PurchaseReturnItemDto {
  @IsInt() variantId: number;
  @IsInt() @Min(1) returnedQuantity: number;
  @IsInt() @Min(0) unitCost: number;

  @IsOptional() @IsBoolean() taxInclusive?: boolean;
  @IsOptional() @IsInt() @Min(0) taxRate?: number;
}

export class CreatePurchaseReturnDto {
  @IsString() returnNumber: string;

  @IsOptional() @IsInt() supplierId?: number;
  @IsOptional() @IsString() supplierNameSnapshot?: string;
  @IsOptional() @IsString() supplierCodeSnapshot?: string;

  @IsOptional() @IsString() invoiceNumber?: string;
  @IsOptional() @IsString() returnReason?: string;

  @IsOptional() @IsInt() safeId?: number;

  @IsEnum(PurchaseReturnType) returnType: PurchaseReturnType;

  @IsOptional() @IsString() notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseReturnItemDto)
  items: PurchaseReturnItemDto[];
}

export class UpdatePurchaseReturnDto extends CreatePurchaseReturnDto {
  @IsOptional() @IsEnum(ReturnStatus) status?: ReturnStatus;
}

export class UpdatePurchaseReturnStatusDto {
  @IsEnum(ReturnStatus) status: ReturnStatus;
}
