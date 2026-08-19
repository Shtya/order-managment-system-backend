import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { SchemaProperty } from "../schema-property.decorator";

const ORDER_NUMBER_DESC =
  'The order number: a short code starting with "ORD" + 8 letters/digits (e.g. ORD8VVTGTH). This is NOT the UUID id.';

export class GetOrderToolArgsDto {
  @SchemaProperty({
    description:
      'The order number, a short code starting with "ORD" + 8 letters/digits (e.g. ORD8VVTGTH). NOT the UUID id. A courier tracking number (numeric, e.g. 38098658) also works here.',
    example: "ORD8VVTGTH",
  })
  @IsString()
  @MinLength(1)
  orderNumber: string;

  @SchemaProperty({
    description: "Set true to include the order items list in the response.",
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  includeItems?: boolean;
}

export class GetLatestOrderToolArgsDto {}

export class GetLatestOrderByPhoneToolArgsDto {
  @SchemaProperty({
    description:
      "The customer's full phone number, digits only, starting with the country code (e.g. 201000000000 for Egypt).",
    example: "201000000000",
  })
  @IsString()
  @MinLength(8)
  @MaxLength(20)
  phoneNumber: string;
}

export class SearchOrdersToolArgsDto {
  @SchemaProperty({
    description:
      "Free-text search across order number (ORD... code), customer name, and phone number.",
    example: "Ahmed Ali",
  })
  @IsOptional()
  @IsString()
  search?: string;

  @SchemaProperty({
    description:
      'Exact order number to find. It is a short code starting with "ORD" + 8 letters/digits (e.g. ORD8VVTGTH), NOT the UUID id.',
    example: "ORD8VVTGTH",
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  orderNumber?: string;

  @SchemaProperty({
    description: "Filter by order status name.",
    example: "New",
  })
  @IsOptional()
  @IsString()
  status?: string;

  @SchemaProperty({
    description: "Filter by payment status.",
    example: "pending",
  })
  @IsOptional()
  @IsString()
  paymentStatus?: string;

  @SchemaProperty({ description: "Filter by city name.", example: "Cairo" })
  @IsOptional()
  @IsString()
  city?: string;

  @SchemaProperty({ description: "Page number, starting at 1.", example: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  page?: number;

  @SchemaProperty({
    description: "Number of records per page (1-50).",
    example: 10,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class GetOrderStatusToolArgsDto {
  @SchemaProperty({ description: ORDER_NUMBER_DESC, example: "ORD8VVTGTH" })
  @IsString()
  @MinLength(1)
  orderNumber: string;
}

export class SummarizeOrderToolArgsDto {
  @SchemaProperty({ description: ORDER_NUMBER_DESC, example: "ORD8VVTGTH" })
  @IsString()
  @MinLength(1)
  orderNumber: string;
}

export class GetOrderHistoryToolArgsDto {
  @SchemaProperty({ description: ORDER_NUMBER_DESC, example: "ORD8VVTGTH" })
  @IsString()
  @MinLength(1)
  orderNumber: string;
}

export class SearchOrdersByPhoneToolArgsDto {
  @SchemaProperty({
    description:
      "Customer phone number. Digits only, starting with country code.",
    example: "201000000000",
  })
  @IsString()
  @MinLength(8)
  @MaxLength(20)
  phoneNumber: string;
}

export class GetOrderItemsToolArgsDto {
  @SchemaProperty({ description: ORDER_NUMBER_DESC, example: "ORD8VVTGTH" })
  @IsString()
  @MinLength(1)
  orderNumber: string;
}

export class AddOrderMessageToolArgsDto {
  @SchemaProperty({ description: ORDER_NUMBER_DESC, example: "ORD8VVTGTH" })
  @IsString()
  @MinLength(1)
  orderNumber: string;

  @SchemaProperty({
    description: "The note/message text to append to the order.",
    example: "Customer confirmed by phone.",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message: string;

  @SchemaProperty({
    description: "Source label of the message (e.g. ai, admin, system).",
    example: "ai",
  })
  @IsOptional()
  @IsString()
  source?: string;
}

export class GetOrderShippingToolArgsDto {
  @SchemaProperty({ description: ORDER_NUMBER_DESC, example: "ORD8VVTGTH" })
  @IsString()
  @MinLength(1)
  orderNumber: string;
}

export class BulkUpdateOrdersShippingToolArgsDto {
  @SchemaProperty({
    description:
      "List of orders to update. Each item orderNumber is the order code (e.g. ORD8VVTGTH), NOT the UUID id.",
    examples: [[{ orderNumber: "ORD8VVTGTH", providerCityId: "city_123" }]],
  })
  @IsArray()
  items: Array<{
    orderNumber: string;
    cityId?: string;
    areaId?: string;
    provider?: string;
    providerCityId?: string;
  }>;
}

export class GetOrderStatsToolArgsDto {
  @SchemaProperty({
    description: "Start date of the range (YYYY-MM-DD).",
    example: "2026-07-01",
  })
  @IsOptional()
  @IsString()
  startDate?: string;

  @SchemaProperty({
    description: "End date of the range (YYYY-MM-DD).",
    example: "2026-07-31",
  })
  @IsOptional()
  @IsString()
  endDate?: string;

  @SchemaProperty({
    description: "Filter statistics by a specific order status id (UUID).",
    example: "9c9f1a4e-2e8b-4b6f-9f1a-000000000000",
  })
  @IsOptional()
  @IsString()
  statusId?: string;
}
