
import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsEnum, IsInt, IsOptional, IsNumber, IsString, Min } from 'class-validator';
import { PlanDuration, SubscriptionStatus } from 'entities/plans.entity';



export class CreateSubscriptionDto {
    @IsInt()
    userId: number;

    @IsInt()
    planId: number;

    @IsEnum(SubscriptionStatus)
    status: SubscriptionStatus;

    @IsEnum(PlanDuration)
    duration: PlanDuration;


    @IsOptional()
    @IsInt()
    @Min(1)
    durationIndays?: number;

    @IsOptional()
    @IsInt()
    @Min(0)
    includedOrders?: number | null; // null for unlimited

    @IsOptional()
    @IsNumber()
    @Min(0)
    extraOrderFee?: number | null;

    @IsOptional()
    @IsInt()
    @Min(1)
    usersLimit?: number | null;

    @IsOptional()
    @IsInt()
    @Min(1)
    storesLimit?: number | null;

    @IsOptional()
    @IsInt()
    @Min(0)
    shippingCompaniesLimit?: number | null;

    @IsOptional()
    @IsInt()
    @Min(0)
    bulkUploadPerMonth?: number;

    @IsOptional()
    @IsNumber()
    price?: number; // amount actually paid


    @IsOptional()
    @IsString()
    paymentMethod?: string;

}


export class UpdateSubscriptionDto extends PartialType(
    OmitType(CreateSubscriptionDto, ['userId'] as const)
) { }