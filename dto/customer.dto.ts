import { IsString, IsOptional, IsEmail, MaxLength } from 'class-validator';
import { i18nValidationMessage } from "nestjs-i18n";


export class UpdateCustomerDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    @MaxLength(255, { message: i18nValidationMessage('validation.max_length') })
    name?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    @MaxLength(50, { message: i18nValidationMessage('validation.max_length') })
    phoneNumber?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    @MaxLength(255, { message: i18nValidationMessage('validation.max_length') })
    profilePicture?: string;

    @IsEmail({}, {message: i18nValidationMessage('validation.is_email')})
    @IsOptional()
    email?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    notes?: string;
}
