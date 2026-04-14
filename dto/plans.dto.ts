import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { IsString, IsNumber, IsArray, IsEnum, IsBoolean, IsOptional, Min, IsInt } from 'class-validator';
import { PlanColor, PlanDuration, PlanType, } from 'entities/plans.entity';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/* =========================
 * Plan DTOs
 * ========================= */

export class CreatePlanDto {
	@IsString()
	name: string;

	@IsOptional()
	@IsEnum(PlanType)
	type?: PlanType;

	@IsEnum(PlanDuration)
	duration: PlanDuration;

	@IsOptional()
	@IsInt()
	@Min(1)
	durationIndays?: number;

	@IsNumber()
	@Min(0)
	price: number;

	@IsOptional()
	@IsInt()
	@Min(0)
	includedOrders?: number | null; // null for unlimited

	@IsOptional()
	@IsNumber()
	@Min(0)
	extraOrderFee?: number;

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
	@IsString()
	description?: string;

	@IsArray()
	@IsString({ each: true })
	@IsOptional()
	features?: string[];

	@IsString()
	@IsOptional()
	color?: string;

	@IsOptional()
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@IsBoolean()
	isPopular?: boolean;
}

export class UpdatePlanDto extends PartialType(CreatePlanDto) {


}


@Entity('bulk_upload_usage')
export class BulkUploadUsage {
	@PrimaryGeneratedColumn('uuid')
	Id: string;

	@Column()
	adminId: string;

	@Column()
	month: string; // Format: "YYYY-MM"

	@Column({ default: 0 })
	count: number;
}

export class ManualCreateTransactionDto {
	@IsNumber()
	@Type(() => Number)
	subscriptionId: string;

	@IsString()
	paymentMethod: string;

	@IsOptional()
	@IsString()
	paymentProof?: string;
}