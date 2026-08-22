import { Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { i18nValidationMessage } from "nestjs-i18n";
import {
  CancelCauseReviewStatus,
  CancelCauseSource,
} from "entities/cancel-cause.entity";

export class CreateCancelCauseDto {
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(3, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(200, { message: i18nValidationMessage("validation.max_length") })
  name: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MaxLength(1000, { message: i18nValidationMessage("validation.max_length") })
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: i18nValidationMessage("validation.is_int") })
  @Min(0, { message: i18nValidationMessage("validation.min") })
  sortOrder?: number;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  isActive?: boolean;
}

export class UpdateCancelCauseDto {
  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(3, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(200, { message: i18nValidationMessage("validation.max_length") })
  name?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MaxLength(1000, { message: i18nValidationMessage("validation.max_length") })
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: i18nValidationMessage("validation.is_int") })
  @Min(0, { message: i18nValidationMessage("validation.min") })
  sortOrder?: number;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  isActive?: boolean;
}

export class ReviewCancelCauseDto {
  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MaxLength(500, { message: i18nValidationMessage("validation.max_length") })
  reviewNote?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(3, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(200, { message: i18nValidationMessage("validation.max_length") })
  name?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MaxLength(1000, { message: i18nValidationMessage("validation.max_length") })
  description?: string;
}

export class CancelCauseListQueryDto {
  @IsOptional()
  @IsEnum(CancelCauseReviewStatus, {
    message: i18nValidationMessage("validation.is_enum"),
  })
  reviewStatus?: CancelCauseReviewStatus;

  @IsOptional()
  @IsEnum(CancelCauseSource, {
    message: i18nValidationMessage("validation.is_enum"),
  })
  source?: CancelCauseSource;
}
