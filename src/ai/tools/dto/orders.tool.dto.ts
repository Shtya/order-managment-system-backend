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
    description:
      "Full detailed written shipping address for couriers (street/road, neighborhood, landmark, building when known, then city). Plain text only — NEVER include latitude/longitude or suffixes like '(موقع على الخريطة: 31.13, 33.81)'. Do NOT send a short city-only summary when richer text exists.",
    example: "شارع عباس العقاد بجانب مسجد النور، مدينة نصر، القاهرة، عمارة 12 دور 3",
  })
  @IsOptional()
  @IsString()
  address?: string;

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
      "Optional shipping provider code for this update (e.g. 'bosta', 'turbo').",
    example: "bosta",
  })
  @IsOptional()
  @IsString()
  code?: string;

  @SchemaProperty({
    description:
      "List of orders to update. Each item requires the order UUID id. When correcting location, set address to the full detailed map/street text (never only city + governorate + country), plus cityId / shippingMetadata.",
    examples: [
      [
        {
          id: "a1b2c3d4-5678-9abc-def0-1234567890ab",
          address: "شارع عباس العقاد بجانب مسجد النور، مدينة نصر، القاهرة، عمارة 12 دور 3",
          cityId: "city_123",
          shippingMetadata: { districtId: "dist_456", zoneId: "zone_789" },
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

export class ReportAddressConflictAddressDto {
  @SchemaProperty({
    description:
      'WhatsApp list row title. Use exactly "العنوان المسجل" for the written order address, or "عنوان الواتساب" for the WhatsApp/map pin location.',
    example: "العنوان المسجل",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(24)
  label: string;

  @SchemaProperty({
    description:
      "Full deliverable address text only (no latitude/longitude in this string).",
    example: "شارع التحرير، وسط البلد، القاهرة",
  })
  @IsString()
  @MinLength(1)
  fullAddress: string;

  @SchemaProperty({
    description: "City name if known.",
    example: "القاهرة",
  })
  @IsOptional()
  @IsString()
  city?: string;

  @SchemaProperty({
    description: "Area / district name if known.",
    example: "وسط البلد",
  })
  @IsOptional()
  @IsString()
  area?: string;

  @SchemaProperty({
    description:
      "Which order field this candidate came from (e.g. locationAddress, address, coordinates).",
    example: "locationAddress",
  })
  @IsOptional()
  @IsString()
  source?: string;

  @SchemaProperty({
    description: "Latitude if this candidate is based on coordinates.",
    example: 30.0444,
  })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @SchemaProperty({
    description: "Longitude if this candidate is based on coordinates.",
    example: 31.2357,
  })
  @IsOptional()
  @IsNumber()
  longitude?: number;
}

export class ReportAddressConflictToolArgsDto {
  @SchemaProperty({
    description:
      "Two or more usable conflicting shipping locations. Each item must be deliverable: either a full written address (city + street detail) OR a map pin with latitude/longitude (map pin is valid even if reverse-geocode text is city-only/sparse). Example: written Cairo address vs Arish map coordinates. Do NOT include vague text with no city and no coordinates.",
    examples: [
      [
        {
          label: "العنوان المسجل",
          fullAddress:
            "زهراء مدينة نصر، شارع الميثاق، عمارة 15، الدور الثالث، شقة 7، القاهرة",
          city: "القاهرة",
          area: "مدينة نصر",
          source: "address",
        },
        {
          label: "عنوان الواتساب",
          fullAddress: "العريش، شمال سيناء، مصر",
          city: "العريش",
          source: "coordinates",
          latitude: 31.13510029,
          longitude: 33.81452872,
        },
      ],
    ],
  })
  @IsArray()
  addresses: ReportAddressConflictAddressDto[];

  @SchemaProperty({
    description: "Optional short reason why these addresses conflict.",
    example: "Map pin and typed address point to different areas",
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
