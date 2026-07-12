import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, Matches, Max, MinLength } from 'class-validator';
import { Language } from 'entities/clientSettings.entity';
import { i18nValidationMessage } from 'nestjs-i18n';

export class CheckEmailDto {
  @IsEmail({}, {message: i18nValidationMessage('validation.is_email')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  email: string;
}

export class RegisterDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  name: string;

  @IsEmail({}, {message: i18nValidationMessage('validation.is_email')})
  email: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @MinLength(8, {message: i18nValidationMessage('validation.min_length')})
  /**
   * This Regex ensures the password has at least:
   * 1. One uppercase letter
   * 2. One lowercase letter
   * 3. One number
   * (Matching your frontend "score" logic)
   */
  @Matches(/((?=.*\d)(?=.*[a-z])(?=.*[A-Z]))/, {
    message: i18nValidationMessage('validation.password_week'),
  })
  password: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  phone: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  companyName: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  businessType: string;

}

export class LoginDto {

  @IsEmail({}, { message: i18nValidationMessage('validation.is_email') })
  email: string;

  @IsString({message: i18nValidationMessage('validation.is_string')}) 
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  password: string;
}

export class ForgotPasswordDto {
  @IsEmail({}, {message: i18nValidationMessage('validation.is_email')})
  email: string;
}

export class VerifyOtpDto {
  @IsEmail({}, {message: i18nValidationMessage('validation.is_email')})
  email: string;

  @IsString({message: i18nValidationMessage('validation.is_string')}) 
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  otp: string;
}

export class ResetPasswordDto {
  @IsEmail({}, {message: i18nValidationMessage('validation.is_email')})
  email: string;

  @IsString({message: i18nValidationMessage('validation.is_string')}) 
  @MinLength(6, { message: i18nValidationMessage('validation.min_length') })
  newPassword: string;
}

// Google
export class GoogleLoginDto {
  @IsString({message: i18nValidationMessage('validation.is_string')}) @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  idToken: string;

  @IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')})
  name?: string;
}
