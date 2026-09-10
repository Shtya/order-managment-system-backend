import { OmitType } from "@nestjs/mapped-types";
import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { ShippingAssigningRuleType } from "entities/shipping-assigning.entity";
import { PaymentMethod } from "entities/order.entity";
import { i18nValidationMessage } from "nestjs-i18n";

export class AssigningConditionDto {
  @IsOptional()
  @IsEnum(PaymentMethod, {
    message: (args) => {
      return i18nValidationMessage("validation.is_enum")({
        ...args,
        constraints: [Object.values(PaymentMethod).join(", ")],
      });
    },
  })
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @IsString({ each: true })
  storeIds?: string[];

  @IsOptional()
  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @IsString({ each: true })
  cityIds?: string[];

  @IsOptional()
  @IsNumber({}, { message: i18nValidationMessage("validation.is_number") })
  @Min(0, { message: i18nValidationMessage("validation.min") })
  minAmount?: number | null;

  @IsOptional()
  @IsNumber({}, { message: i18nValidationMessage("validation.is_number") })
  @Min(0, { message: i18nValidationMessage("validation.min") })
  maxAmount?: number | null;
}

@ValidatorConstraint({ name: "ValidAssigningCondition", async: false })
export class ValidAssigningConditionConstraint
  implements ValidatorConstraintInterface
{
  validate(_: any, args: ValidationArguments) {
    const dto = args.object as CreateAssigningRuleDto;
    // On update ruleType is omitted — service validates the merged rule.
    if (!dto.ruleType) return true;
    const condition = (dto as any).condition;
    const targets = dto.targetCompanyIds ?? [];

    switch (dto.ruleType) {
      case ShippingAssigningRuleType.EQUAL_DISTRIBUTION:
        // Many companies, always equally distributed. No condition needed.
        return targets.length >= 1;
      case ShippingAssigningRuleType.PAYMENT_METHOD:
        // One payment method + exactly one company.
        return (
          !!condition?.paymentMethod &&
          targets.length === 1
        );
      case ShippingAssigningRuleType.STORE:
        // Many stores + exactly one company.
        return (
          !!condition?.storeIds?.length &&
          targets.length === 1
        );
      case ShippingAssigningRuleType.CITY:
        // Many cities + exactly one company.
        return (
          !!condition?.cityIds?.length &&
          targets.length === 1
        );
      case ShippingAssigningRuleType.ORDER_TOTAL: {
        // Single min/max + exactly one company.
        if (targets.length !== 1) return false;
        const { minAmount, maxAmount } = condition ?? {};
        if (
          minAmount != null &&
          maxAmount != null &&
          Number(minAmount) > Number(maxAmount)
        ) {
          return false;
        }
        return true;
      }
      default:
        return false;
    }
  }

  defaultMessage(args: ValidationArguments) {
    return i18nValidationMessage("validation.valid_assigning_condition")(args);
  }
}

export class CreateAssigningRuleDto {
  @Validate(ValidAssigningConditionConstraint)
  @IsNotEmpty({ message: i18nValidationMessage("validation.is_not_empty") })
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MaxLength(120, { message: i18nValidationMessage("validation.max_length") })
  name: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  description?: string;

  @IsNotEmpty({ message: i18nValidationMessage("validation.is_not_empty") })
  @IsEnum(ShippingAssigningRuleType, {
    message: (args) => {
      return i18nValidationMessage("validation.is_enum")({
        ...args,
        constraints: [Object.values(ShippingAssigningRuleType).join(", ")],
      });
    },
  })
  ruleType: ShippingAssigningRuleType;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  isActive?: boolean;

  @IsOptional()
  @IsInt({ message: i18nValidationMessage("validation.is_int") })
  @Min(1, { message: i18nValidationMessage("validation.min") })
  priority?: number;

  @IsOptional()
  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @IsString({ each: true })
  targetCompanyIds?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => AssigningConditionDto)
  condition?: AssigningConditionDto;
}

export class UpdateAssigningRuleDto extends OmitType(CreateAssigningRuleDto, [
  "ruleType",
] as const) {
  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  name: string;
}

export class ResolveAssigningDto {
  @IsOptional()
  @IsEnum(PaymentMethod, {
    message: (args) => {
      return i18nValidationMessage("validation.is_enum")({
        ...args,
        constraints: [Object.values(PaymentMethod).join(", ")],
      });
    },
  })
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsNumber({}, { message: i18nValidationMessage("validation.is_number") })
  finalTotal?: number;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  storeId?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  cityId?: string;
}

export class PreviewAssigningItemDto extends ResolveAssigningDto {
  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  label?: string;
}

export class PreviewAssigningDto {
  @IsNotEmpty({ message: i18nValidationMessage("validation.is_not_empty") })
  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @ArrayMinSize(1, {
    message: i18nValidationMessage("validation.array_min_size"),
  })
  @ValidateNested({ each: true })
  @Type(() => PreviewAssigningItemDto)
  orders: PreviewAssigningItemDto[];
}
