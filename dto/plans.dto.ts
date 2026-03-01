import { Type } from 'class-transformer';
import { IsString, IsNumber, IsArray, IsEnum, IsBoolean, IsOptional, Min, IsInt } from 'class-validator';
import { TransactionPaymentMethod, PlanDuration, TransactionStatus } from 'entities/plans.entity';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/* =========================
 * Plan DTOs
 * ========================= */

export class CreatePlanDto {
	@IsString()
	name: string;

	@IsNumber()
	@Min(0)
	price: number;

	@IsEnum(PlanDuration)
	duration: PlanDuration;

	@IsString()
	@IsOptional()
	description?: string;

	@IsArray()
	@IsString({ each: true })
	features: string[];

	@IsString()
	@IsOptional()
	color?: string;

	@IsBoolean()
	@IsOptional()
	isActive?: boolean;

	@IsBoolean()
	@IsOptional()
	isPopular?: boolean;

	@IsNumber()
	@IsOptional()
	adminId?: number;

	@IsOptional()
	@IsInt()
	@Min(1)
	usersLimit?: number;

	@IsOptional()
	@IsInt()
	@Min(1)
	bulkUploadPerMonth?: number;

	@IsOptional()
	@IsInt()
	@Min(0)
	shippingCompaniesLimit?: number;
}

export class UpdatePlanDto {
	@IsString()
	@IsOptional()
	name?: string;

	@IsNumber()
	@Min(0)
	@IsOptional()
	price?: number;

	@IsEnum(PlanDuration)
	@IsOptional()
	duration?: PlanDuration;

	@IsString()
	@IsOptional()
	description?: string;

	@IsArray()
	@IsString({ each: true })
	@IsOptional()
	features?: string[];

	@IsString()
	@IsOptional()
	color?: string;

	@IsBoolean()
	@IsOptional()
	isActive?: boolean;

	@IsBoolean()
	@IsOptional()
	isPopular?: boolean;


	@IsOptional()
	@IsInt()
	@Min(1)
	bulkUploadPerMonth?: number;

	@IsOptional()
	@IsInt()
	@Min(1)
	usersLimit?: number;

	@IsOptional()
	@IsInt()
	@Min(0)
	shippingCompaniesLimit?: number;

}


@Entity('bulk_upload_usage')
export class BulkUploadUsage {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	adminId: number;

	@Column()
	month: string; // Format: "YYYY-MM"

	@Column({ default: 0 })
	count: number;
}

export class ManualCreateTransactionDto {
	@IsNumber()
	@Type(() => Number)
	subscriptionId: number;

	@IsEnum(TransactionPaymentMethod)
	paymentMethod: TransactionPaymentMethod;

	@IsOptional()
	@IsString()
	paymentProof?: string;
}