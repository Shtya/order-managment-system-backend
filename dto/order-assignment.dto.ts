import { OmitType } from "@nestjs/mapped-types";
import { Type } from "class-transformer";
import { ArrayMinSize, ArrayNotEmpty, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested } from "class-validator";
import { AssignmentStrategy, AutoAssignRuleType } from "entities/assignment.entity";
import { PaymentStatus } from "entities/order.entity";

export class CreateAutoAssignRuleDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNotEmpty()
  @IsEnum(AutoAssignRuleType)
  ruleType: AutoAssignRuleType;

  @IsNotEmpty()
  @IsEnum(AssignmentStrategy)
  strategy: AssignmentStrategy;
  
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  priority?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  productIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cityIds?: string[];

  @IsOptional()
  @IsNumber()
  minAmount?: number;

  @IsOptional()
  @IsNumber()
  maxAmount?: number;

  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;


  @IsNotEmpty()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  employeeIds: string[];
}

export class UpdateAutoAssignRuleDto extends  OmitType(CreateAutoAssignRuleDto, ['ruleType'] as const,) {
  @IsOptional()
  @IsString()
  name: string;

  @IsOptional()
  @IsEnum(AutoAssignRuleType)
  ruleType: AutoAssignRuleType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  employeeIds: string[];
}

export class ManualAssignItemDto {
  @IsNotEmpty()
  @IsString()
  userId: string;

  @IsNotEmpty()
  @IsArray()
  @ArrayMinSize(1, {
    message: "You must select at least one order for each employee",
  })
  orderIds: string[];
}

export class ManualAssignManyDto {
  @IsNotEmpty()
  @IsArray()
  @ArrayMinSize(1, {
    message: "You must provide at least one assignment block",
  })
  @ValidateNested({ each: true })
  @Type(() => ManualAssignItemDto)
  assignments: ManualAssignItemDto[];
}

export class AutoAssignDto {
  @IsArray()
  @ArrayNotEmpty()
  statusIds?: string[];

  @IsNotEmpty()
  @IsInt()
  @Min(1)
  employeeCount: number; // How many employees should participate (e.g., 5)

  @IsNotEmpty()
  @IsInt()
  @Min(1)
  orderCount: number; // How many employees should participate (e.g., 5)

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class AutoPreviewDto {
  @IsArray()
  @ArrayNotEmpty()
  statusIds: string[];

  @IsInt()
  @Type(() => Number)
  requestedOrderCount: number;

  @IsInt()
  @Type(() => Number)
  requestedEmployeeCount: number;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class GetFreeOrdersDto {
  @IsArray()
  @ArrayNotEmpty()
  statusIds?: string[];

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  // cursor = created_at of last item from previous page
  @IsOptional()
  @IsDateString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

export class RunAutoAssignmentDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  orderIds: string[];
}