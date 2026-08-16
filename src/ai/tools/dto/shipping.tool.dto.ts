import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const SUPPORTED_SHIPPING_PROVIDERS = ['bosta', 'jt', 'turbo', 'aramex', 'dhl', 'SMSA'] as const;

export class ListShippingProviderCitiesToolArgsDto {
	@IsIn(SUPPORTED_SHIPPING_PROVIDERS)
	provider: string;
}

export class GetShippingProviderDistrictsToolArgsDto {
	@IsIn(SUPPORTED_SHIPPING_PROVIDERS)
	provider: string;

	@IsString()
	@MinLength(1)
	cityId: string;
}

export class GetShippingProviderZonesToolArgsDto {
	@IsIn(SUPPORTED_SHIPPING_PROVIDERS)
	provider: string;

	@IsString()
	@MinLength(1)
	districtId: string;
}

export class ResolveShippingLocationIdToolArgsDto {
	@IsIn(SUPPORTED_SHIPPING_PROVIDERS)
	provider: string;

	@IsString()
	@MinLength(1)
	@MaxLength(200)
	cityName: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	areaName?: string;
}

export class UpdateOrderShippingLocationToolArgsDto {
	@IsString()
	@MinLength(1)
	orderId: string;

	@IsIn(SUPPORTED_SHIPPING_PROVIDERS)
	provider: string;

	@IsString()
	@MinLength(1)
	providerCityId: string;

	@IsOptional()
	@IsString()
	unifiedDistrictId?: string;

	@IsOptional()
	@IsString()
	unifiedZoneId?: string;

	@IsOptional()
	@IsString()
	locationId?: string;

	@IsOptional()
	@IsString()
	orderSize?: string;
}
