import { IsNumber, IsOptional, Min } from 'class-validator';
import { i18nValidationMessage } from "nestjs-i18n";


export class UpdateCityTenantConfigDto {
    @IsOptional()
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @Min(0, {message: i18nValidationMessage('validation.min')})
    minShippingDays?: number;

    @IsOptional()
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @Min(0, {message: i18nValidationMessage('validation.min')})
    maxShippingDays?: number;
}
