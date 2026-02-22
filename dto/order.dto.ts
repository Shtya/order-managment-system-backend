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
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { PartialType } from "@nestjs/mapped-types";
import { PaymentStatus, PaymentMethod, ReplacementReason } from "entities/order.entity";


export class CreateStatusDto {
  @IsString()
  @MaxLength(50)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsHexColor()
  color?: string; // Ensures #000000 format
}
export class UpdateStatusDto extends PartialType(CreateStatusDto) {
  @IsOptional()
  @IsNumber()
  statusId?: number;
}

// ✅ Order Item DTO
export class OrderItemDto {
  @IsInt()
  variantId: number;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsInt()
  @Min(0)
  unitPrice: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  unitCost?: number; // optional, can be calculated from variant
}


export class ShippingMetadataDto {
  @IsOptional()
  @IsString()
  cityId?: string;

  @IsOptional()
  @IsString()
  districtId?: string;

  @IsOptional()
  @IsString()
  zoneId?: string;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsString()
  buildingNumber?: string;

  @IsOptional()
  @IsString()
  secondPhone?: string;
}

// ✅ Create Order DTO
export class CreateOrderDto {
  // Customer Info
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  customerName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  phoneNumber: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  email?: string;

  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @IsOptional()
  landmark?: string;

  @IsNumber()
  @IsOptional()
  deposit?: number = 0;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  area?: string;

  // Payment
  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;

  // Shipping
  @IsOptional()
  @IsString()
  shippingCompanyId: string;


  // Shipping
  @IsOptional()
  @IsString()
  storeId: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  shippingCost?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  discount?: number;

  // Notes
  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  customerNotes?: string;

  // Items
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ShippingMetadataDto)
  shippingMetadata?: ShippingMetadataDto;
}

// ✅ Update Order DTO
export class UpdateOrderDto extends PartialType(CreateOrderDto) {
  @IsOptional()
  @IsNumber()
  statusId?: number;

  @IsOptional()
  @IsString()
  trackingNumber?: string;
}

// ✅ Change Order Status DTO
export class ChangeOrderStatusDto {
  @IsNumber()
  statusId: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

// ✅ Update Payment Status DTO
export class UpdatePaymentStatusDto {
  @IsEnum(PaymentStatus)
  paymentStatus: PaymentStatus;
}

// ✅ Add Order Message DTO
export class AddOrderMessageDto {
  @IsString()
  @IsNotEmpty()
  message: string;

  @IsEnum(["admin", "customer"])
  senderType: "admin" | "customer";
}

// ✅ Mark Messages Read DTO
export class MarkMessagesReadDto {
  @IsArray()
  @IsInt({ each: true })
  messageIds: number[];
}

export class UpsertOrderRetrySettingsDto {
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsNumber()
  @IsOptional()
  maxRetries?: number;

  @IsNumber()
  @IsOptional()
  retryInterval?: number;

  @IsString()
  @IsOptional()
  autoMoveStatus?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  retryStatuses?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  confirmationStatuses?: string[];

  @IsBoolean()
  @IsOptional()
  notifyEmployee?: boolean;

  @IsBoolean()
  @IsOptional()
  notifyAdmin?: boolean;

  @IsObject()
  @IsOptional()
  workingHours?: {
    enabled: boolean;
    start: string;
    end: string;
  };
}
export class ManualAssignItemDto {
  @IsNotEmpty()
  @IsInt()
  userId: number;

  @IsNotEmpty()
  @IsArray()
  @ArrayMinSize(1, { message: "You must select at least one order for each employee" })
  @IsInt({ each: true })
  orderIds: number[];
}

export class ManualAssignManyDto {
  @IsNotEmpty()
  @IsArray()
  @ArrayMinSize(1, { message: "You must provide at least one assignment block" })
  @ValidateNested({ each: true })
  @Type(() => ManualAssignItemDto)
  assignments: ManualAssignItemDto[];
}

export class AutoAssignDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Type(() => Number)
  statusIds?: number[];

  @IsNotEmpty()
  @IsInt()
  @Min(1)
  employeeCount: number; // How many employees should participate (e.g., 5)

  @IsNotEmpty()
  @IsInt()
  @Min(1)
  orderCount: number; // How many employees should participate (e.g., 5)

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class AutoPreviewDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Type(() => Number)
  statusIds: number[];

  @IsInt()
  @Type(() => Number)
  requestedOrderCount: number;

  @IsInt()
  @Type(() => Number)
  requestedEmployeeCount: number;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

}


export class GetFreeOrdersDto {

  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Type(() => Number)
  statusIds?: number[];

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  // cursor = created_at of last item from previous page
  @IsOptional()
  @IsDateString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}




export class ReplacementItemDto {
  @IsInt()
  @Type(() => Number)
  originalOrderItemId: number;

  @IsInt()
  @Type(() => Number)
  quantityToReplace: number;

  @IsInt()
  @Type(() => Number)
  newVariantId: number;

  @IsInt()
  @Type(() => Number)
  @Min(0)
  newUnitPrice: number;
}

export class CreateReplacementDto {
  @IsEnum(ReplacementReason)
  reason: ReplacementReason;

  @IsString()
  @IsOptional()
  anotherReason?: string;

  @IsInt()
  @Type(() => Number)
  originalOrderId: number;

  @IsOptional()
  @IsString()
  internalNotes?: string;

  @IsOptional()
  @IsString()
  customerNotes?: string;

  @IsOptional()
  @IsArray()
  returnImages?: string[];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  shippingCompanyId?: number;


  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @Min(0)
  discount?: number;

  // Payment
  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @Min(0)
  shippingCost?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      try {
        const parsedArray = JSON.parse(value);
        // 👈 CRITICAL: Convert the plain objects into actual DTO instances!
        return plainToInstance(ReplacementItemDto, parsedArray);
      } catch (e) {
        return value;
      }
    }
    // If it's already an array (e.g., in a normal JSON request), still convert it
    return Array.isArray(value) ? plainToInstance(ReplacementItemDto, value) : value;
  })
  items: ReplacementItemDto[];
}