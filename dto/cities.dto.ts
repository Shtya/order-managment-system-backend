import { IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateCityTenantConfigDto {
    @IsOptional()
    @IsNumber()
    @Min(0)
    minShippingDays?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    maxShippingDays?: number;
}
