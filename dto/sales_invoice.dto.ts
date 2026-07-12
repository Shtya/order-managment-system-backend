// dto/sales_invoice.dto.ts
import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { PaymentMethod, PaymentStatus } from "common/enums";
import { i18nValidationMessage } from "nestjs-i18n";


export class SalesInvoiceItemDto {
@IsString({message: i18nValidationMessage('validation.is_string')})
  variantId: string;

  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Min(1, {message: i18nValidationMessage('validation.min')})
  quantity: number;

  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Min(0, {message: i18nValidationMessage('validation.min')})
  unitPrice: number;

  @IsOptional()
  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Min(0, {message: i18nValidationMessage('validation.min')})
  discount?: number; // per line

  @IsOptional()
  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  taxInclusive?: boolean;

  @IsOptional()
  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Min(0, {message: i18nValidationMessage('validation.min')})
  taxRate?: number;
}

export class CreateSalesInvoiceDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  invoiceNumber: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  customerName: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  phone?: string;

  @IsOptional()
  @IsEnum(PaymentMethod,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(PaymentMethod).join(', ')], }); }})
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsEnum(PaymentStatus,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(PaymentStatus).join(', ')], }); }})
  paymentStatus?: PaymentStatus;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  safeId?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  notes?: string;

  @IsOptional()
  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Min(0, {message: i18nValidationMessage('validation.min')})
  shippingCost?: number;

  @IsOptional()
  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Min(0, {message: i18nValidationMessage('validation.min')})
  paidAmount?: number;

  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @ValidateNested({ each: true })
  @Type(() => SalesInvoiceItemDto)
  items: SalesInvoiceItemDto[];
}

export class UpdateSalesInvoiceDto {
  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  invoiceNumber?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  customerName?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  phone?: string;

  @IsOptional()
  @IsEnum(PaymentMethod,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(PaymentMethod).join(', ')], }); }})
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsEnum(PaymentStatus,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(PaymentStatus).join(', ')], }); }})
  paymentStatus?: PaymentStatus;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  safeId?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  notes?: string;

  @IsOptional()
  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Min(0, {message: i18nValidationMessage('validation.min')})
  shippingCost?: number;

  @IsOptional()
  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Min(0, {message: i18nValidationMessage('validation.min')})
  paidAmount?: number;

  @IsOptional()
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @ValidateNested({ each: true })
  @Type(() => SalesInvoiceItemDto)
  items?: SalesInvoiceItemDto[];
}

export class UpdateSalesPaymentStatusDto {
  @IsEnum(PaymentStatus,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(PaymentStatus).join(', ')], }); }})
  paymentStatus: PaymentStatus;
}
