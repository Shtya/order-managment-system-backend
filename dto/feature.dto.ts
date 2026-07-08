import { IsString, IsNumber, IsOptional, Min, IsBoolean, IsEnum } from 'class-validator';
import { FeatureAvailability, SubscriptionStatus } from 'entities/plans.entity';

export class UpdateFeatureDto {
    @IsOptional()
    @IsString()
    name?: string;

    @IsOptional()
    @IsNumber()
    @Min(0)
    price?: number;

    @IsOptional()
    @IsBoolean()
    isActive?: boolean;

    @IsOptional()
    @IsEnum(FeatureAvailability)
    availability?: FeatureAvailability = FeatureAvailability.READY;
}

export class AssignUserFeatureDto {
    @IsString()
    userId: string;

    @IsString()
    featureId: string;

    @IsEnum(SubscriptionStatus)
    @IsOptional()
    status?: SubscriptionStatus = SubscriptionStatus.ACTIVE;

    @IsNumber()
    @IsOptional()
    @Min(0)
    price?: number; // للسماح بتعديل السعر عن السعر الافتراضي

    @IsString()
    @IsOptional()
    paymentMethod?: string = 'cash';
}