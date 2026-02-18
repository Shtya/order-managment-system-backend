import { IsBoolean, IsObject, IsOptional, IsString, MinLength } from 'class-validator';

export class SetActiveDto {
	@IsBoolean()
	isActive: boolean;
}

/**
 * ✅ Admin sets his own provider credentials
 */
export class SetProviderCredentialsDto {

	@IsObject()
	credentials: {
		apiKey: string;
	};
}

export class CreateShipmentDto {
	@IsString()
	@MinLength(1)
	customerName: string;

	@IsString()
	@MinLength(6)
	phoneNumber: string;

	@IsString()
	@MinLength(5)
	address: string;

	@IsString()
	@MinLength(2)
	city: string;

	@IsOptional()
	@IsString()
	area?: string;

	@IsOptional()
	codAmount?: number;

	@IsOptional()
	@IsString()
	notes?: string;

	@IsOptional()
	weightKg?: number;

	@IsOptional()
	@IsString()
	size?: 'Small' | 'Medium' | 'Large';
}

export class AssignOrderDto extends CreateShipmentDto { }
