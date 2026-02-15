// shipping-company.dto.ts
import { IsString, IsOptional, IsBoolean, MinLength } from 'class-validator';

export class CreateShippingCompanyDto {
    @IsString()
    @MinLength(2)
    name: string;

    @IsBoolean()
    @IsOptional()
    isActive?: boolean;
}

export class UpdateShippingCompanyDto extends CreateShippingCompanyDto { }