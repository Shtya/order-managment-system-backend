
import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsEnum, IsInt, IsOptional, IsNumber, IsString, Min } from 'class-validator';
import { PlanDuration, SubscriptionStatus } from 'entities/plans.entity';
import { i18nValidationMessage } from "nestjs-i18n";



export class CreateSubscriptionDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    userId: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    planId: string;

    @IsEnum(SubscriptionStatus,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(SubscriptionStatus).join(', ')], }); }})
    status: SubscriptionStatus;

    @IsEnum(PlanDuration,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(PlanDuration).join(', ')], }); }})
    duration: PlanDuration;


    @IsOptional()
    @IsInt({message: i18nValidationMessage('validation.is_int')})
    @Min(1, {message: i18nValidationMessage('validation.min')})
    durationIndays?: number;

    @IsOptional()
    @IsInt({message: i18nValidationMessage('validation.is_int')})
    @Min(0, {message: i18nValidationMessage('validation.min')})
    includedOrders?: number | null; // null for unlimited

    @IsOptional()
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @Min(0, {message: i18nValidationMessage('validation.min')})
    extraOrderFee?: number | null;

    @IsOptional()
    @IsInt({message: i18nValidationMessage('validation.is_int')})
    @Min(1, {message: i18nValidationMessage('validation.min')})
    usersLimit?: number | null;

    @IsOptional()
    @IsInt({message: i18nValidationMessage('validation.is_int')})
    @Min(1, {message: i18nValidationMessage('validation.min')})
    storesLimit?: number | null;

    @IsOptional()
    @IsInt({message: i18nValidationMessage('validation.is_int')})
    @Min(0, {message: i18nValidationMessage('validation.min')})
    shippingCompaniesLimit?: number | null;

    @IsOptional()
    @IsInt({message: i18nValidationMessage('validation.is_int')})
    @Min(0, {message: i18nValidationMessage('validation.min')})
    bulkUploadPerMonth?: number;

    @IsOptional()
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    price?: number; // amount actually paid


    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    paymentMethod?: string;

}


export class UpdateSubscriptionDto extends PartialType(
    OmitType(CreateSubscriptionDto, ['userId'] as const)
) { }