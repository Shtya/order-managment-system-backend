import { IsString, IsNumber, IsOptional, Min, IsBoolean, IsEnum } from 'class-validator';
import { SubscriptionStatus } from 'entities/plans.entity';

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
}

export class AssignUserFeatureDto {
    @IsNumber()
    userId: number;

    @IsNumber()
    featureId: number;

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