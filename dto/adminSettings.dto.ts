import {
  IsEmail,
  IsEmpty,
  isEmpty,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
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
}
