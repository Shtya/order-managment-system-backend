import { Transform } from 'class-transformer';
import {
	IsArray,
	IsBoolean,
	IsEnum,
	IsInt,
	IsNotEmpty,
	IsOptional,
	IsPositive,
	IsString,
	IsUUID,
	MaxLength,
} from 'class-validator';
import { IssuePriority } from 'entities/issue.entity';

export class CreateIssueDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(250)
	title: string;

	@IsOptional()
	@IsString()
	description?: string;

	@IsUUID()
	@IsNotEmpty()
	orderId: string;

	@IsOptional()
	@IsUUID()
	causeId?: string;

	@IsOptional()
	@IsEnum(IssuePriority)
	priority?: IssuePriority;

	@IsOptional()
	@IsUUID()
	statusId?: string;

	@IsUUID()
	assignedRoleId: string;

	@IsOptional()
	@IsArray()
	@IsUUID('4', { each: true })
	employeeIds?: string[];

	@IsOptional()
	@IsInt()
	@IsPositive()
	estimatedMinutes?: number;
}

export class UpdateIssueDto {
	@IsOptional()
	@IsString()
	@MaxLength(250)
	title?: string;

	@IsOptional()
	@IsString()
	description?: string;

	@IsOptional()
	@IsUUID()
	causeId?: string | null;

	@IsOptional()
	@IsEnum(IssuePriority)
	priority?: IssuePriority;

	@IsUUID()
	assignedRoleId: string;

	@IsOptional()
	@IsArray()
	@IsUUID('4', { each: true })
	employeeIds?: string[];

	@IsOptional()
	@IsArray()
	@IsUUID('4', { each: true })
	assignedEmployeeIds?: string[];

	@IsOptional()
	@IsInt()
	@IsPositive()
	estimatedMinutes?: number;

}

export class CreateIssueStatusDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(50)
	nameEn: string;

	@IsOptional()
	@IsString()
	@MaxLength(50)
	nameAr?: string;

	@IsOptional()
	@IsString()
	description?: string;

	@IsOptional()
	@IsString()
	@MaxLength(7)
	color?: string;

	@IsOptional()
	@IsInt()
	sortOrder?: number;
}

export class UpdateIssueStatusDto {
	@IsOptional()
	@IsString()
	@MaxLength(50)
	nameEn?: string;

	@IsOptional()
	@IsString()
	@MaxLength(50)
	nameAr?: string;

	@IsOptional()
	@IsString()
	description?: string;

	@IsOptional()
	@IsString()
	@MaxLength(7)
	color?: string;

	@IsOptional()
	@IsInt()
	sortOrder?: number;
}

export class CreateIssueCauseDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(200)
	nameEn: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	nameAr?: string;

	@IsOptional()
	@IsInt()
	sortOrder?: number;
}

export class UpdateIssueCauseDto {
	@IsOptional()
	@IsString()
	@MaxLength(200)
	nameEn?: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	nameAr?: string;

	@IsOptional()
	@IsInt()
	sortOrder?: number;
}

export class ReplyIssueDto {
	@IsOptional()
	@IsString()
	@MaxLength(10000)
	message?: string;

	@IsOptional()
	@Transform(({ value }) => value === true || value === 'true')
	@IsBoolean()
	isInternalNote?: boolean;
}

export class UpdateIssueMessageDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(10000)
	message: string;
}

export class ChangeIssueStatusDto {
	@IsUUID()
	statusId: string;

	@IsOptional()
	@IsString()
	@MaxLength(2000)
	reason?: string;
}

export class ChangeIssuePriorityDto {
	@IsEnum(IssuePriority)
	priority: IssuePriority;
}

export class AssignIssueDto {
	@IsOptional()
	@IsUUID()
	assignedRoleId?: string | null;

	@IsOptional()
	@IsArray()
	@IsUUID('4', { each: true })
	employeeIds?: string[];

	@IsOptional()
	@IsArray()
	@IsUUID('4', { each: true })
	assignedEmployeeIds?: string[];
}
