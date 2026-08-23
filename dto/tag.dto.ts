import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { i18nValidationMessage } from "nestjs-i18n";
import {
  TagConditionField,
  TagConditionLogic,
  TagConditionOperator,
} from "entities/tag.entity";

export class TagConditionRuleDto {
  @IsEnum(TagConditionField, {
    message: (args) => {
      return i18nValidationMessage("validation.is_enum")({
        ...args,
        constraints: [Object.values(TagConditionField).join(", ")],
      });
    },
  })
  field: TagConditionField;

  @IsEnum(TagConditionOperator, {
    message: (args) => {
      return i18nValidationMessage("validation.is_enum")({
        ...args,
        constraints: [Object.values(TagConditionOperator).join(", ")],
      });
    },
  })
  operator: TagConditionOperator;

  @IsOptional()
  value?: any;
}

export class TagConditionsDto {
  @IsEnum(TagConditionLogic, {
    message: (args) => {
      return i18nValidationMessage("validation.is_enum")({
        ...args,
        constraints: [Object.values(TagConditionLogic).join(", ")],
      });
    },
  })
  logic: TagConditionLogic;

  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @ArrayMinSize(1, { message: i18nValidationMessage("validation.array_min_size") })
  @ArrayMaxSize(5, { message: i18nValidationMessage("validation.array_max_size") })
  @ValidateNested({ each: true })
  @Type(() => TagConditionRuleDto)
  rules: TagConditionRuleDto[];
}

export class CreateTagDto {
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(1, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(100, { message: i18nValidationMessage("validation.max_length") })
  name: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @Matches(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, {
    message: i18nValidationMessage("validation.is_string"),
  })
  color?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MaxLength(1000, { message: i18nValidationMessage("validation.max_length") })
  description?: string;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  isActive?: boolean;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  allowManualAssignment?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: i18nValidationMessage("validation.is_int") })
  @Min(0, { message: i18nValidationMessage("validation.min") })
  priority?: number;
}

export class UpdateTagDto {
  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(1, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(100, { message: i18nValidationMessage("validation.max_length") })
  name?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @Matches(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, {
    message: i18nValidationMessage("validation.is_string"),
  })
  color?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MaxLength(1000, { message: i18nValidationMessage("validation.max_length") })
  description?: string;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  isActive?: boolean;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  allowManualAssignment?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: i18nValidationMessage("validation.is_int") })
  @Min(0, { message: i18nValidationMessage("validation.min") })
  priority?: number;
}

export class CreateTagAutomationDto {
  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  tagId: string;

  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(1, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(150, { message: i18nValidationMessage("validation.max_length") })
  name: string;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  isEnabled?: boolean;

  @IsObject({ message: i18nValidationMessage("validation.is_object") })
  @ValidateNested()
  @Type(() => TagConditionsDto)
  conditions: TagConditionsDto;
}

export class UpdateTagAutomationDto {
  @IsOptional()
  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  tagId?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(1, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(150, { message: i18nValidationMessage("validation.max_length") })
  name?: string;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  isEnabled?: boolean;

  @IsOptional()
  @IsObject({ message: i18nValidationMessage("validation.is_object") })
  @ValidateNested()
  @Type(() => TagConditionsDto)
  conditions?: TagConditionsDto;
}

export class AssignOrderTagDto {
  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  tagId: string;
}
