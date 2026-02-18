import { IsString, IsNumber, IsArray, IsEnum, IsBoolean, IsOptional, Min, IsInt } from 'class-validator';
import { PlanDuration, TransactionStatus } from 'entities/plans.entity';
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

/* =========================
 * Transaction DTOs
 * ========================= */

export class CreateTransactionDto {
	@IsNumber()
	planId: number;

	@IsNumber()
	@IsOptional()
	userId?: number; // If admin creates for specific user

	@IsString()
	@IsOptional()
	paymentMethod?: string;

	@IsString()
	@IsOptional()
	paymentProof?: string;
}

export class UpdateTransactionStatusDto {
	@IsEnum(TransactionStatus)
	status: TransactionStatus;
}

export class FilterTransactionsDto {
	@IsEnum(TransactionStatus)
	@IsOptional()
	status?: TransactionStatus;

	@IsNumber()
	@IsOptional()
	userId?: number;

	@IsNumber()
	@IsOptional()
	planId?: number;

	@IsString()
	@IsOptional()
	dateFrom?: string; // ISO string

	@IsString()
	@IsOptional()
	dateTo?: string; // ISO string

	@IsNumber()
	@Min(0)
	@IsOptional()
	minAmount?: number;

	@IsNumber()
	@Min(0)
	@IsOptional()
	maxAmount?: number;
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