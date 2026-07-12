// dto/purchase_return.dto.ts
import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested } from "class-validator";
import { ApprovalStatus, PurchaseReturnType, ReturnStatus } from "common/enums";
import { i18nValidationMessage } from "nestjs-i18n";


export class PurchaseReturnItemDto {
  @IsString({message: i18nValidationMessage('validation.is_string')}) variantId: string;
  @IsInt({message: i18nValidationMessage('validation.is_int')}) @Min(1, {message: i18nValidationMessage('validation.min')}) returnedQuantity: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, {message: i18nValidationMessage('validation.min')}) unitCost: number;

  @IsOptional() @IsBoolean({message: i18nValidationMessage('validation.is_boolean')}) taxInclusive?: boolean;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, {message: i18nValidationMessage('validation.min')}) taxRate?: number;
}

export class CreatePurchaseReturnDto {
  @IsString({message: i18nValidationMessage('validation.is_string')}) returnNumber: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  supplierId?: string;

  @IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) supplierNameSnapshot?: string;
  @IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) supplierCodeSnapshot?: string;

  @IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) invoiceNumber?: string;
  @IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) returnReason?: string;

  @IsString({message: i18nValidationMessage('validation.is_string')}) @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')}) safeId: string;

  @IsOptional() @IsEnum(PurchaseReturnType,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(PurchaseReturnType).join(', ')], }); }}) returnType?: PurchaseReturnType;

  @IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) notes?: string;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, {message: i18nValidationMessage('validation.min')}) paidAmount?: number;

  @IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) receiptAsset?: string;

  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @ValidateNested({ each: true })
  @Type(() => PurchaseReturnItemDto)
  items: PurchaseReturnItemDto[];
}

export class UpdatePurchaseReturnDto extends CreatePurchaseReturnDto {
  @IsOptional() @IsEnum(ApprovalStatus,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(ApprovalStatus).join(', ')], }); }}) status?: ApprovalStatus;
}

export class UpdatePurchaseReturnStatusDto {
  @IsEnum(ApprovalStatus,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(ApprovalStatus).join(', ')], }); }}) status: ApprovalStatus;
}


export class UpdatePaidAmountDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, {message: i18nValidationMessage('validation.min')}) paidAmount: number;
}