import { IsString, IsNumber, IsOptional, Min, IsBoolean, IsEnum } from 'class-validator';
import { FeatureAvailability, SubscriptionStatus } from 'entities/plans.entity';
import { i18nValidationMessage } from "nestjs-i18n";


export class UpdateFeatureDto {
    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    name?: string;

    @IsOptional()
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @Min(0, {message: i18nValidationMessage('validation.min')})
    price?: number;

    @IsOptional()
    @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
    isActive?: boolean;

    @IsOptional()
    @IsEnum(FeatureAvailability,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(FeatureAvailability).join(', ')], }); }})
    availability?: FeatureAvailability = FeatureAvailability.READY;
}

export class AssignUserFeatureDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    userId: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    featureId: string;

    @IsEnum(SubscriptionStatus,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(SubscriptionStatus).join(', ')], }); }})
    @IsOptional()
    status?: SubscriptionStatus = SubscriptionStatus.ACTIVE;

    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @IsOptional()
    @Min(0, {message: i18nValidationMessage('validation.min')})
    price?: number; // للسماح بتعديل السعر عن السعر الافتراضي

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    paymentMethod?: string = 'cash';
}