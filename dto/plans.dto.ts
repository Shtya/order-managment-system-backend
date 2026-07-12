import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { IsString, IsNumber, IsArray, IsEnum, IsBoolean, IsOptional, Min, IsInt } from 'class-validator';
import { PlanColor, PlanDuration, PlanType, } from 'entities/plans.entity';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { i18nValidationMessage } from "nestjs-i18n";


/* =========================
 * Plan DTOs
 * ========================= */

export class CreatePlanDto {
	@IsString({message: i18nValidationMessage('validation.is_string')})
	name: string;

	@IsOptional()
	@IsEnum(PlanType,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(PlanType).join(', ')], }); }})
	type?: PlanType;

	@IsEnum(PlanDuration,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(PlanDuration).join(', ')], }); }})
	duration: PlanDuration;

	@IsOptional()
	@IsInt({message: i18nValidationMessage('validation.is_int')})
	@Min(1, {message: i18nValidationMessage('validation.min')})
	durationIndays?: number;

	@IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
	@Min(0, {message: i18nValidationMessage('validation.min')})
	price: number;

	@IsOptional()
	@IsInt({message: i18nValidationMessage('validation.is_int')})
	@Min(0, {message: i18nValidationMessage('validation.min')})
	includedOrders?: number | null; // null for unlimited

	@IsOptional()
	@IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
	@Min(0, {message: i18nValidationMessage('validation.min')})
	extraOrderFee?: number;

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
	@IsString({message: i18nValidationMessage('validation.is_string')})
	description?: string;

	@IsArray({message: i18nValidationMessage('validation.is_array')})
	@IsString({ each: true })
	@IsOptional()
	features?: string[];

	@IsString({message: i18nValidationMessage('validation.is_string')})
	@IsOptional()
	color?: string;

	@IsOptional()
	@IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
	isActive?: boolean;

	@IsOptional()
	@IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
	isPopular?: boolean;
}

export class UpdatePlanDto extends PartialType(CreatePlanDto) {
}

export class ManualCreateTransactionDto {
	@IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
	@Type(() => Number)
	subscriptionId: string;

	@IsString({message: i18nValidationMessage('validation.is_string')})
	paymentMethod: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	paymentProof?: string;
}