 import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { i18nValidationMessage } from "nestjs-i18n";
import { SmsProviderType } from "entities/sms.entity";

export class CreateIntegrationDto {
  @IsEnum(SmsProviderType, { message: i18nValidationMessage('validation.is_enum') })
  providerCode: SmsProviderType;

  @IsString({ message: i18nValidationMessage('validation.is_string') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  username: string;

  @IsString({ message: i18nValidationMessage('validation.is_string') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  password: string;
}

export class UpdateIntegrationDto {
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  username?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  password?: string;
}

export class CreateSenderDto {
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  @MaxLength(100, { message: i18nValidationMessage('validation.max_length') })
  name: string;

  @IsString({ message: i18nValidationMessage('validation.is_string') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  @MaxLength(150, { message: i18nValidationMessage('validation.max_length') })
  identifier: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  integrationId?: string;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.is_boolean') })
  isDefault?: boolean;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  description?: string;
}

export class UpdateSenderDto {
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  @MaxLength(100, { message: i18nValidationMessage('validation.max_length') })
  name?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  @MaxLength(150, { message: i18nValidationMessage('validation.max_length') })
  identifier?: string;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.is_boolean') })
  isDefault?: boolean;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  description?: string;
}

export class SendSmsDto {
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  toNumber: string;

  @IsString({ message: i18nValidationMessage('validation.is_string') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.is_not_empty') })
  message: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.is_string') })
  senderId?: string;
}
