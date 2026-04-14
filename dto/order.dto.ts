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
  OrderFlowPath,
  StockDeductionStrategy,
} from "entities/order.entity";

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
  @IsString()
  statusId?: string;
}

export class OrderItemDto {
@IsString()
  variantId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitCost?: number;

  @IsOptional()
  @IsBoolean()
  isAdditional?: boolean;
}
// ✅ Order Item DTO
export class RemovedOrderItemDto {
@IsString()
  variantId: string;
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
  @IsOptional()
  @IsBoolean()
  allowOpenPackage?: boolean;

  // Shipping
  @IsOptional()
  @IsString()
  storeId: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  shippingCost?: number;

  // Added Optional Second Name
  @IsOptional()
  @IsString()
  @MaxLength(200)
  secondPhoneNumber?: string;

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

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RemovedOrderItemDto)
  removedItems?: RemovedOrderItemDto[]; // Items explicitly removed
}

// ✅ Update Order DTO
export class UpdateOrderDto extends PartialType(CreateOrderDto) {
  @IsOptional()
  @IsNumber()
  statusId?: string;

  @IsOptional()
  @IsString()
  trackingNumber?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RemovedOrderItemDto)
  removedItems?: RemovedOrderItemDto[]; // Items explicitly removed
}

export class BulkUpdateShippingMetadataDto {
  @IsOptional()
  @IsString()
  cityId?: string;

  @IsOptional()
  @IsString()
  districtId?: string;

  @IsOptional()
  @IsString()
  zoneId?: string;
}

export class BulkUpdateShippingFieldItemDto {
  
  @IsString()
  id: string;

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsString()
  @MinLength(5, {
    message: 'Address is too short. It must be at least 5 characters.',
  })
  address?: string;

  @IsOptional()
  @IsString()
  @Matches(/^01[0125][0-9]{8}$/, {
    message:
      "phoneNumber must be an Egyptian mobile number starting with 010, 011, 012, or 015 and contain 11 digits",
  })
  phoneNumber?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => BulkUpdateShippingMetadataDto)
  shippingMetadata?: BulkUpdateShippingMetadataDto;
}

export class BulkUpdateShippingFieldsDto {

  @IsOptional()
  @IsString()
  code?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkUpdateShippingFieldItemDto)
  items: BulkUpdateShippingFieldItemDto[];
}

// ✅ Change Order Status DTO
export class ChangeOrderStatusDto {
  @IsString()
  statusId: string;

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
  messageIds: string[];
}

export class ShippingSettingsDto {

  @IsString()
  @IsOptional()
  shippingCompanyId?: string;

  @IsString()
  @IsOptional()
  triggerStatus?: string;

  @IsBoolean()
  @IsOptional()
  notifyOnShipment?: boolean;

  @IsBoolean()
  @IsOptional()
  autoGenerateLabel?: boolean;

  @IsNumber()
  @IsOptional()
  partialPaymentThreshold?: number;

  @IsBoolean()
  @IsOptional()
  requireFullPayment?: boolean;

  @IsBoolean()
  @IsOptional()
  autoShipAfterWarehouse?: boolean;

  @IsString()
  @IsOptional()
  warehouseDefaultShippingCompanyId?: string;
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

  @IsBoolean()
  @IsOptional()
  notifyOrderUpdates?: boolean;

  @IsBoolean()
  @IsOptional()
  notifyNewProducts?: boolean;

  @IsBoolean()
  @IsOptional()
  notifyLowStock?: boolean;

  @IsBoolean()
  @IsOptional()
  notifyMarketing?: boolean;

  @IsEnum(StockDeductionStrategy)
  @IsOptional()
  stockDeductionStrategy?: StockDeductionStrategy;

  @IsEnum(OrderFlowPath)
  @IsOptional()
  orderFlowPath?: OrderFlowPath;

  @IsObject()
  @IsOptional()
  workingHours?: {
    enabled: boolean;
    start: string;
    end: string;
  };

  @IsOptional()
  @ValidateNested()
  @Type(() => ShippingSettingsDto)
  shipping?: ShippingSettingsDto;
}
export class ManualAssignItemDto {
  @IsNotEmpty()
@IsString()
  userId: string;

  @IsNotEmpty()
  @IsArray()
  @ArrayMinSize(1, {
    message: "You must select at least one order for each employee",
  })
  @IsInt({ each: true })
  orderIds: string[];
}

export class ManualAssignManyDto {
  @IsNotEmpty()
  @IsArray()
  @ArrayMinSize(1, {
    message: "You must provide at least one assignment block",
  })
  @ValidateNested({ each: true })
  @Type(() => ManualAssignItemDto)
  assignments: ManualAssignItemDto[];
}

export class AutoAssignDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  statusIds?: string[];

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
  statusIds: string[];

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
  statusIds?: string[];

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
@IsString()
  @Type(() => Number)
  originalOrderItemId: string;

  @IsInt()
  @Type(() => Number)
  quantityToReplace: number;

@IsString()
  @IsString()
  newVariantId: string;

  @IsInt()
  @Type(() => Number)
  @Min(0)
  newUnitPrice: number;
}

export class CreateReplacementDto {
  @IsString()
  reason: string;

  @IsString()
  @IsOptional()
  anotherReason?: string;

@IsString()
@IsString()
  originalOrderId: string;

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
@IsString()
  @IsString()
  shippingCompanyId?: string;

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
@IsString()
  @IsOptional()
  shippingCompanyId: string;

  @IsString()
  @IsOptional()
  driverName?: string;

  @IsArray()
  @IsInt({ each: true })
  orderIds: string[];
}

export class ReturnItemDto {
  @IsString()
  @IsNotEmpty()
  originalItemId: string;

  @IsNumber()
  @Min(1)
  quantity: number;

  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim()) // [2025-12-24] Trim applied
  condition?: string;
}

export class CreateReturnDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim()) // [2025-12-24] Trim applied
  reason?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items: ReturnItemDto[];
}
