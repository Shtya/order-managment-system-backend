// dto/order.dto.ts
import { plainToInstance, Transform, Type } from "class-transformer";
import {
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsHexColor,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { PartialType } from "@nestjs/mapped-types";
import {
  PaymentStatus,
  PaymentMethod,
} from "entities/order.entity";
import { i18nValidationMessage } from "nestjs-i18n";


export class CreateStatusDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(50, { message: i18nValidationMessage('validation.max_length') })
  name: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  description?: string;

  @IsOptional()
  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  @Min(0, {message: i18nValidationMessage('validation.min')})
  sortOrder?: number;

  @IsOptional()
  @IsHexColor()
  color?: string; // Ensures #000000 format
}
export class UpdateStatusDto extends PartialType(CreateStatusDto) {
  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  statusId?: string;
}

export class OrderItemDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  variantId: string;

  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Min(1, {message: i18nValidationMessage('validation.min')})
  quantity: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, {message: i18nValidationMessage('validation.min')})
  unitPrice: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, {message: i18nValidationMessage('validation.min')})
  unitCost?: number;

  @IsOptional()
  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  isAdditional?: boolean;

  @IsOptional()
  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  addQuantity?: boolean; // If true, add quantity to existing instead of replacing
}
// ✅ Order Item DTO
export class RemovedOrderItemDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  variantId: string;
}

export class ShippingMetadataDto {
  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  cityId?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  districtId?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  zoneId?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  locationId?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  buildingNumber?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  secondPhone?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  orderSize?: string;
}

// ✅ Create Order DTO
export class CreateOrderDto {
  // Customer Info
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(200, { message: i18nValidationMessage('validation.max_length') })
  customerName: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(50, { message: i18nValidationMessage('validation.max_length') })
  phoneNumber: string;

  @IsOptional()
  @Transform(({ value }) => value === "" ? undefined : value)
  @IsEmail({}, {message: i18nValidationMessage('validation.is_email')})
  @MaxLength(200, { message: i18nValidationMessage('validation.max_length') })
  email?: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(1000, { message: i18nValidationMessage('validation.max_length') })
  address: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  @MaxLength(300, { message: i18nValidationMessage('validation.max_length') })
  landmark?: string;

  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  @IsOptional()
  deposit?: number = 0;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(100, { message: i18nValidationMessage('validation.max_length') })
  city: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  cityId?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(100, { message: i18nValidationMessage('validation.max_length') })
  area?: string;

  // Payment
  @IsEnum(PaymentMethod,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(PaymentMethod).join(', ')], }); }})
  paymentMethod: PaymentMethod;

  @IsOptional()
  @IsEnum(PaymentStatus,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(PaymentStatus).join(', ')], }); }})
  paymentStatus?: PaymentStatus;

  // Shipping
  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  shippingCompanyId: string;
  @IsOptional()
  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  allowOpenPackage?: boolean;

  // Shipping
  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  storeId: string;

  @IsOptional()
  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Min(0, {message: i18nValidationMessage('validation.min')})
  shippingCost?: number;

  // Added Optional Second Name
  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(200, { message: i18nValidationMessage('validation.max_length') })
  secondPhoneNumber?: string;

  @IsOptional()
  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Min(0, {message: i18nValidationMessage('validation.min')})
  discount?: number;

  // Notes
  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(4000, { message: i18nValidationMessage('validation.max_length') })
  notes?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MaxLength(4000, { message: i18nValidationMessage('validation.max_length') })
  customerNotes?: string;

  // Items
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @IsOptional()
  @IsObject({message: i18nValidationMessage('validation.is_object')})
  @ValidateNested()
  @Type(() => ShippingMetadataDto)
  shippingMetadata?: ShippingMetadataDto;

  @IsOptional()
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @ValidateNested({ each: true })
  @Type(() => RemovedOrderItemDto)
  removedItems?: RemovedOrderItemDto[]; // Items explicitly removed
}

// ✅ Update Order DTO
export class UpdateOrderDto extends PartialType(CreateOrderDto) {
  @IsOptional()
  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  statusId?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  trackingNumber?: string;

  @IsOptional()
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @ValidateNested({ each: true })
  @Type(() => RemovedOrderItemDto)
  removedItems?: RemovedOrderItemDto[]; // Items explicitly removed
}

export class BulkUpdateShippingMetadataDto {
  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  districtId?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  zoneId?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  orderSize?: string;
}

export class BulkUpdateShippingFieldItemDto {

  @IsString({message: i18nValidationMessage('validation.is_string')})
  id: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  customerName?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  // @MinLength(5, {
  //   message: i18nValidationMessage('validation.min_length'),
  // })
  address?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @Matches(/^01[0125][0-9]{8}$/, {
    message: i18nValidationMessage('validation.egyptian_mobile'),
  })
  phoneNumber?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  cityId?: string;


  @IsOptional()
  @ValidateNested()
  @Type(() => BulkUpdateShippingMetadataDto)
  shippingMetadata?: BulkUpdateShippingMetadataDto;
}

export class BulkUpdateShippingFieldsDto {

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  code?: string;

  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @ValidateNested({ each: true })
  @Type(() => BulkUpdateShippingFieldItemDto)
  items: BulkUpdateShippingFieldItemDto[];
}

// ✅ Change Order Status DTO
export class ChangeOrderStatusDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  statusId: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  notes?: string;

  @IsOptional()
  @IsDateString({}, {message: i18nValidationMessage('validation.is_date_string')})
  postponedDate?: string;

  @IsOptional()
  @IsInt({message: i18nValidationMessage('validation.is_int')})
  reminderDaysBefore?: number;
}

// ✅ Update Payment Status DTO
export class UpdatePaymentStatusDto {
  @IsEnum(PaymentStatus,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(PaymentStatus).join(', ')], }); }})
  paymentStatus: PaymentStatus;
}

// ✅ Add Order Message DTO
export class AddOrderMessageDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  message: string;

  @IsEnum(["admin", "customer"],{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(["admin", "customer"]).join(', ')], }); }})
  senderType: "admin" | "customer";
}

// ✅ Mark Messages Read DTO
export class MarkMessagesReadDto {
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  messageIds: string[];
}


export class ReplacementItemDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @Type(() => Number)
  originalOrderItemId: string;

  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Type(() => Number)
  quantityToReplace: number;

  @IsOptional()
  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Type(() => Number)
  @Min(0, {message: i18nValidationMessage('validation.min')})
  returnQuantity?: number;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsString({message: i18nValidationMessage('validation.is_string')})
  newVariantId: string;

  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Type(() => Number)
  @Min(0, {message: i18nValidationMessage('validation.min')})
  newUnitPrice: number;
}

export class CreateReplacementDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  reason: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  anotherReason?: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  originalOrderId: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  internalNotes?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  customerNotes?: string;

  @IsOptional()
  @IsArray({message: i18nValidationMessage('validation.is_array')})
  returnImages?: string[];

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  shippingCompanyId?: string;

  @IsOptional()
  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Type(() => Number)
  @Min(0, {message: i18nValidationMessage('validation.min')})
  discount?: number;

  @IsOptional()
  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  @Type(() => Number)
  @Min(0, {message: i18nValidationMessage('validation.min')})
  deposit?: number;

  // Payment
  @IsEnum(PaymentMethod,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(PaymentMethod).join(', ')], }); }})
  paymentMethod: PaymentMethod;

  @IsOptional()
  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Type(() => Number)
  @Min(0, {message: i18nValidationMessage('validation.min')})
  shippingCost?: number;

  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @ValidateNested({ each: true })
  @Transform(({ value }) => {
    if (typeof value === "string") {
      try {
        const parsedArray = JSON.parse(value);
        // 👈 CRITICAL: Convert the plain objects into actual DTO instances!
        return plainToInstance(ReplacementItemDto, parsedArray);
      } catch (e) {
        return value;
      }
    }
    // If it's already an array (e.g., in a normal JSON request), still convert it
    return Array.isArray(value)
      ? plainToInstance(ReplacementItemDto, value)
      : value;
  })
  items: ReplacementItemDto[];
}

export class CreateManifestDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  shippingCompanyId: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  driverName?: string;

  @IsArray({message: i18nValidationMessage('validation.is_array')})
  orderIds: string[];
}

export class ReturnItemDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  originalItemId: string;

  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  @Min(1, {message: i18nValidationMessage('validation.min')})
  quantity: number;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  @Transform(({ value }) => value?.trim()) // [2025-12-24] Trim applied
  condition?: string;
}

export class CreateReturnDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  orderId: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  @Transform(({ value }) => value?.trim()) // [2025-12-24] Trim applied
  reason?: string;

  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items: ReturnItemDto[];
}


export type CellErrorMap = Map<number, Map<number, string[]>>;

export type SkuErrorRow = {
  sku: string;
  totalQty: number;
  available: number;
  rows: number[];
};