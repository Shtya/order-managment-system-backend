import { OmitType } from "@nestjs/mapped-types";
import { Type } from "class-transformer";
import { ArrayMinSize, ArrayNotEmpty, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, Min, Validate, ValidateNested, ValidationArguments, ValidatorConstraint, ValidatorConstraintInterface } from "class-validator";
import { AssignmentStrategy, AutoAssignRuleType } from "entities/assignment.entity";
import { PaymentStatus } from "entities/order.entity";
import { WeekDayHelper } from "common/bitmask.helper";


@ValidatorConstraint({ name: 'ValidTimeWindow', async: false })
export class ValidTimeWindowConstraint implements ValidatorConstraintInterface {
    validate(_: any, args: ValidationArguments) {
        const dto = args.object as CreateAutoAssignRuleDto;
        if (dto.startTime && dto.endTime) {
            return dto.startTime < dto.endTime;
        }
        return true;
    }

    defaultMessage() {
        return 'startTime must be before endTime';
    }
}

@ValidatorConstraint({ name: 'ValidDateRange', async: false })
export class ValidDateRangeConstraint implements ValidatorConstraintInterface {
    validate(_: any, args: ValidationArguments) {
        const dto = args.object as CreateAutoAssignRuleDto;
        if (dto.activeFrom && dto.activeUntil) {
            const from = new Date(dto.activeFrom);
            const until = new Date(dto.activeUntil);
            return from <= until;
        }
        return true;
    }

    defaultMessage() {
        return 'activeFrom must be before or equal to activeUntil';
    }
}

@ValidatorConstraint({ name: 'ValidWeekDays', async: false })
export class ValidWeekDaysConstraint implements ValidatorConstraintInterface {
    validate(weekDays: number) {
        return WeekDayHelper.isValid(weekDays);
    }

    defaultMessage() {
        return 'Invalid weekDays bitmask';
    }
}

@ValidatorConstraint({ name: 'ValidAmountRange', async: false })
export class ValidAmountRangeConstraint implements ValidatorConstraintInterface {
    validate(_: any, args: ValidationArguments) {
        const dto = args.object as CreateAutoAssignRuleDto;
        if (dto.minAmount != null && dto.maxAmount != null) {
            return dto.minAmount <= dto.maxAmount;
        }
        return true;
    }

    defaultMessage() {
        return 'minAmount must be less than or equal to maxAmount';
    }
}

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

  // ======================
  // Time Window
  // ======================

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/, {
    message: "startTime must be in HH:mm or HH:mm:ss format",
  })
  startTime?: string;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/, {
    message: "endTime must be in HH:mm or HH:mm:ss format",
  })
  endTime?: string;

  // ======================
  // Days Of Week Bitmask
  // ======================

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(127) // 1+2+4+8+16+32+64
  @Validate(ValidWeekDaysConstraint)
  weekDays?: number;

  // ======================
  // Date Range
  // ======================

  @IsOptional()
  @IsDateString()
  activeFrom?: Date;

  @IsOptional()
  @IsDateString()
  activeUntil?: Date;

  @IsOptional()
  @IsString()
  timezone?: string;
  
  @IsOptional()
  @Validate(ValidTimeWindowConstraint)
  @Validate(ValidDateRangeConstraint)
  @Validate(ValidAmountRangeConstraint)
  @Validate(ValidWeekDaysConstraint)
  private readonly _validation?: never;
}

export class UpdateAutoAssignRuleDto extends OmitType(CreateAutoAssignRuleDto, ['ruleType'] as const,) {
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