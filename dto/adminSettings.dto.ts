import {
  IsEmail,
  IsEmpty,
  isEmpty,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { WhatsAppIntegrationMode } from "entities/adminSettings.entity";
import { i18nValidationMessage } from "nestjs-i18n";

class SocialsDto {
  @IsOptional()
  @IsUrl({}, {message: i18nValidationMessage('validation.is_url')})
  facebook?: string;
  @IsOptional()
  @IsUrl({}, {message: i18nValidationMessage('validation.is_url')})
  instagram?: string;
  @IsOptional()
  @IsUrl({}, {message: i18nValidationMessage('validation.is_url')})
  x?: string;
  @IsOptional()
  @IsUrl({}, {message: i18nValidationMessage('validation.is_url')})
  linkedin?: string;
  @IsOptional()
  @IsUrl({}, {message: i18nValidationMessage('validation.is_url')})
  github?: string;
  @IsOptional()
  @IsUrl({}, {message: i18nValidationMessage('validation.is_url')})
  youtube?: string;
}

class BillingAllowanceDto {
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.is_string') })
  @Min(0)
  units?: number;

  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.is_string') })
  @Min(0)
  durationDays?: number | null;
}

class AiDecisionBillingDto {
  @IsOptional()
  @IsNumber({}, { message: i18nValidationMessage('validation.is_string') })
  @Min(0)
  tokenPrice?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => BillingAllowanceDto)
  allowance?: BillingAllowanceDto | null;
}

class BillingSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => AiDecisionBillingDto)
  aiDecision?: AiDecisionBillingDto;
}

export class UpdateAdminSettingsDto {
  @IsOptional()
  @IsEmail({}, {message: i18nValidationMessage('validation.is_email')})
  email?: string;

  @IsOptional()
  @IsString({message: i18nValidationMessage('validation.is_string')})
  whatsapp?: string;

  @IsOptional() 
  @ValidateNested()
  @Type(() => SocialsDto)
  socials?: SocialsDto;

  @IsOptional()
  @IsEnum(WhatsAppIntegrationMode,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(WhatsAppIntegrationMode).join(', ')], }); }})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  whatsappIntegrationMode?: WhatsAppIntegrationMode;

  @IsOptional()
  @ValidateNested()
  @Type(() => BillingSettingsDto)
  billing?: BillingSettingsDto;
}
