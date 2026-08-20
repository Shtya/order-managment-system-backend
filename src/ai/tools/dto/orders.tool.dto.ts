import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsObject,
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

export class GetOrderHistoryToolArgsDto {
  @SchemaProperty({ description: ORDER_NUMBER_DESC, example: "ORD8VVTGTH" })
  @IsString()
  @MinLength(1)
  orderNumber: string;
}
export class GetOrderShippingToolArgsDto {
  @SchemaProperty({ description: ORDER_NUMBER_DESC, example: "ORD8VVTGTH" })
  @IsString()
  @MinLength(1)
  orderNumber: string;
}

export class BulkUpdateShippingMetadataToolArgsDto {
  @SchemaProperty({
    description: "Unified district id to assign.",
    example: "dist_456",
  })
  @IsOptional()
  @IsString()
  districtId?: string;

  @SchemaProperty({
    description: "Unified zone id to assign.",
    example: "zone_789",
  })
  @IsOptional()
  @IsString()
  zoneId?: string;

  @SchemaProperty({
    description: "Order size (e.g. small, medium, large).",
    example: "medium",
  })
  @IsOptional()
  @IsString()
  orderSize?: string;
}

export class BulkUpdateShippingFieldItemToolArgsDto {
  @SchemaProperty({
    description: "The order UUID id.",
    example: "a1b2c3d4-5678-9abc-def0-1234567890ab",
  })
  @IsString()
  @MinLength(1)
  id: string;

  @SchemaProperty({
    description: "Unified city id to assign.",
    example: "city_123",
  })
  @IsOptional()
  @IsString()
  cityId?: string;

  @SchemaProperty({
    description:
      "Shipping metadata (districtId, zoneId, orderSize).",
  })
  @IsOptional()
  @IsObject()
  shippingMetadata?: BulkUpdateShippingMetadataToolArgsDto;
}

export class BulkUpdateOrdersShippingToolArgsDto {
  @SchemaProperty({
    description:
      "Optional code to tag this bulk update (e.g. 'holiday_promo').",
    example: "holiday_promo",
  })
  @IsOptional()
  @IsString()
  code?: string;

  @SchemaProperty({
    description:
      "List of orders to update. Each item requires the order UUID id.",
    examples: [
      [
        {
          id: "a1b2c3d4-5678-9abc-def0-1234567890ab",
          cityId: "city_123",
          shippingMetadata: { districtId: "dist_456" },
        },
      ],
    ],
  })
  @IsArray()
  items: BulkUpdateShippingFieldItemToolArgsDto[];
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

export class GetCitiesToolArgsDto {}

export class GetCityToolArgsDto {
  @SchemaProperty({
    description: "The unified city id.",
    example: "city_123",
  })
  @IsString()
  @MinLength(1)
  cityId: string;
}

export class GetAreasByCityToolArgsDto {
  @SchemaProperty({
    description: "The unified city id to get areas for.",
    example: "city_123",
  })
  @IsString()
  @MinLength(1)
  cityId: string;
}

export class GetShippingZonesToolArgsDto {
  @SchemaProperty({
    description:
      "The shipping provider code (bosta, jt, turbo, aramex, dhl, SMSA).",
    example: "bosta",
  })
  @IsString()
  @MinLength(1)
  provider: string;

  @SchemaProperty({
    description: "The provider city id to get zones for.",
    example: "provider_city_456",
  })
  @IsString()
  @MinLength(1)
  cityId: string;
}

export class GetShippingDistrictsToolArgsDto {
  @SchemaProperty({
    description:
      "The shipping provider code (bosta, jt, turbo, aramex, dhl, SMSA).",
    example: "bosta",
  })
  @IsString()
  @MinLength(1)
  provider: string;

  @SchemaProperty({
    description: "The provider city id to get districts for.",
    example: "provider_city_456",
  })
  @IsString()
  @MinLength(1)
  cityId: string;
}

export class GetLocationByCoordinatesToolArgsDto {
  @SchemaProperty({
    description: "Latitude coordinate.",
    example: 30.0444,
  })
  @IsNumber()
  latitude: number;

  @SchemaProperty({
    description: "Longitude coordinate.",
    example: 31.2357,
  })
  @IsNumber()
  longitude: number;
}
