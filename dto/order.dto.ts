// dto/order.dto.ts
import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsHexColor,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { PartialType } from "@nestjs/mapped-types";
import { PaymentStatus, PaymentMethod } from "entities/order.entity";


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