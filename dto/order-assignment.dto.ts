import { OmitType } from "@nestjs/mapped-types";
import { Type } from "class-transformer";
import { ArrayMinSize, ArrayNotEmpty, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, Min, Validate, ValidateNested, ValidationArguments, ValidatorConstraint, ValidatorConstraintInterface } from "class-validator";
import { AssignmentStrategy, AutoAssignRuleType } from "entities/assignment.entity";
import { PaymentStatus } from "entities/order.entity";
import { WeekDayHelper } from "common/bitmask.helper";
import { i18nValidationMessage } from "nestjs-i18n";



@ValidatorConstraint({ name: 'ValidTimeWindow', async: false })
export class ValidTimeWindowConstraint implements ValidatorConstraintInterface {
  validate(_: any, args: ValidationArguments) {
    const dto = args.object as CreateAutoAssignRuleDto;
    if (dto.startTime && dto.endTime) {
      // Split "01:00" into [1, 0] and "02:00" into [2, 0]
      const [startHours, startMinutes] = dto.startTime.split(':').map(Number);
      const [endHours, endMinutes] = dto.endTime.split(':').map(Number);

      // Convert both to total minutes from midnight
      const totalStartMinutes = (startHours * 60) + startMinutes;
      const totalEndMinutes = (endHours * 60) + endMinutes;

      // Ensure start time comes before end time
      return totalStartMinutes < totalEndMinutes;
    }
    return true;
  }

  defaultMessage(args: ValidationArguments) {
    return i18nValidationMessage('validation.valid_time_window')(args);
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

  defaultMessage(args: ValidationArguments) {
    return i18nValidationMessage('validation.valid_date_range')(args);
  }
}

@ValidatorConstraint({ name: 'ValidWeekDays', async: false })
export class ValidWeekDaysConstraint implements ValidatorConstraintInterface {
  validate(_: any, args: ValidationArguments) {
    const dto = args.object as CreateAutoAssignRuleDto;
    if(!!dto.weekDays) {
      return WeekDayHelper.isValid(dto.weekDays);
    }
     return true;
  }

  defaultMessage(args: ValidationArguments) {
    return i18nValidationMessage('validation.valid_week_days')(args);
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

  defaultMessage(args: ValidationArguments) {
    return i18nValidationMessage('validation.valid_amount_range')(args);
  }
}

export class CreateAutoAssignRuleDto {

  @Validate(ValidTimeWindowConstraint)
  @Validate(ValidDateRangeConstraint)
  @Validate(ValidAmountRangeConstraint)
  @Validate(ValidWeekDaysConstraint)
  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  name: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  description?: string;

  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  @IsEnum(AutoAssignRuleType, { message: (args) => { return i18nValidationMessage('validation.is_enum')({ ...args, constraints: [Object.values(AutoAssignRuleType).join(', ')], }); } })
  ruleType: AutoAssignRuleType;

  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  @IsEnum(AssignmentStrategy, { message: (args) => { return i18nValidationMessage('validation.is_enum')({ ...args, constraints: [Object.values(AssignmentStrategy).join(', ')], }); } })
  strategy: AssignmentStrategy;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.is_boolean') })
  isActive?: boolean;

  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.is_int') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  priority?: number;

  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.is_array') })
  @IsString({ each: true })
  productIds?: string[];

  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.is_array') })
  @IsString({ each: true })
  cityIds?: string[];

  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.is_array') })
  @IsString({ each: true })
  storeIds?: string[];

  @IsOptional()
  @IsNumber({}, { message: i18nValidationMessage('validation.is_number') })
  minAmount?: number;

  @IsOptional()
  @IsNumber({}, { message: i18nValidationMessage('validation.is_number') })
  maxAmount?: number;

  @IsOptional()
  @IsEnum(PaymentStatus, { message: (args) => { return i18nValidationMessage('validation.is_enum')({ ...args, constraints: [Object.values(PaymentStatus).join(', ')], }); } })
  paymentStatus?: PaymentStatus;


  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  @IsArray({ message: i18nValidationMessage('validation.is_array') })
  @ArrayNotEmpty()
  @IsString({ each: true })
  employeeIds: string[];

  // ======================
  // Time Window
  // ======================

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/, {
    message: i18nValidationMessage('validation.time_format'),
  })
  startTime?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/, {
    message: i18nValidationMessage('validation.time_format'),
  })
  endTime?: string;

  // ======================
  // Days Of Week Bitmask
  // ======================

  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.is_int') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(127, { message: i18nValidationMessage('validation.max') }) // 1+2+4+8+16+32+64
  @Validate(ValidWeekDaysConstraint)
  weekDays?: number;

  // ======================
  // Date Range
  // ======================

  @IsOptional()
  @IsDateString({}, { message: i18nValidationMessage('validation.is_date_string') })
  activeFrom?: Date;

  @IsOptional()
  @IsDateString({}, { message: i18nValidationMessage('validation.is_date_string') })
  activeUntil?: Date;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  timezone?: string;


}

export class UpdateAutoAssignRuleDto extends OmitType(CreateAutoAssignRuleDto, ['ruleType'] as const,) {
  @IsOptional()
  @Validate(ValidTimeWindowConstraint)
  @Validate(ValidDateRangeConstraint)
  @Validate(ValidAmountRangeConstraint)
  @Validate(ValidWeekDaysConstraint)
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  name: string;

  @IsOptional()
  @IsEnum(AutoAssignRuleType, { message: (args) => { return i18nValidationMessage('validation.is_enum')({ ...args, constraints: [Object.values(AutoAssignRuleType).join(', ')], }); } })
  ruleType: AutoAssignRuleType;

  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.is_array') })
  @IsString({ each: true })
  employeeIds: string[];
}

export class ManualAssignItemDto {
  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  userId: string;

  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  @IsArray({ message: i18nValidationMessage('validation.is_array') })
  @ArrayMinSize(1, {
    message: i18nValidationMessage('validation.array_min_size'),
  })
  orderIds: string[];
}

export class ManualAssignManyDto {
  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  @IsArray({ message: i18nValidationMessage('validation.is_array') })
  @ArrayMinSize(1, {
    message: i18nValidationMessage('validation.array_min_size'),
  })
  @ValidateNested({ each: true })
  @Type(() => ManualAssignItemDto)
  assignments: ManualAssignItemDto[];
}

export class AutoAssignDto {
  @IsArray({ message: i18nValidationMessage('validation.is_array') })
  @ArrayNotEmpty()
  statusIds?: string[];

  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  @IsInt({ message: i18nValidationMessage('validation.is_int') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  employeeCount: number; // How many employees should participate (e.g., 5)

  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  @IsInt({ message: i18nValidationMessage('validation.is_int') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  orderCount: number; // How many employees should participate (e.g., 5)

  @IsOptional()
  @IsDateString({}, { message: i18nValidationMessage('validation.is_date_string') })
  startDate?: string;

  @IsOptional()
  @IsDateString({}, { message: i18nValidationMessage('validation.is_date_string') })
  endDate?: string;
}

export class AutoPreviewDto {
  @IsArray({ message: i18nValidationMessage('validation.is_array') })
  @ArrayNotEmpty()
  statusIds: string[];

  @IsInt({ message: i18nValidationMessage('validation.is_int') })
  @Type(() => Number)
  requestedOrderCount: number;

  @IsInt({ message: i18nValidationMessage('validation.is_int') })
  @Type(() => Number)
  requestedEmployeeCount: number;

  @IsOptional()
  @IsDateString({}, { message: i18nValidationMessage('validation.is_date_string') })
  startDate?: string;

  @IsOptional()
  @IsDateString({}, { message: i18nValidationMessage('validation.is_date_string') })
  endDate?: string;
}

export class GetFreeOrdersDto {
  @IsArray({ message: i18nValidationMessage('validation.is_array') })
  @ArrayNotEmpty()
  statusIds?: string[];

  @IsOptional()
  @IsDateString({}, { message: i18nValidationMessage('validation.is_date_string') })
  startDate?: string;

  @IsOptional()
  @IsDateString({}, { message: i18nValidationMessage('validation.is_date_string') })
  endDate?: string;

  // cursor = created_at of last item from previous page
  @IsOptional()
  @IsDateString({}, { message: i18nValidationMessage('validation.is_date_string') })
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: i18nValidationMessage('validation.is_int') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  limit?: number = 20;
}

export class RunAutoAssignmentDto {
  @IsArray({ message: i18nValidationMessage('validation.is_array') })
  @ArrayNotEmpty()
  @IsString({ each: true })
  orderIds: string[];
}