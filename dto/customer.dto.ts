import { IsString, IsOptional, MaxLength, IsNotEmpty, IsBoolean, IsUUID } from 'class-validator';
import { PartialType } from "@nestjs/mapped-types";
import { i18nValidationMessage } from "nestjs-i18n";

export class CreateCustomerDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_required')})
    @MaxLength(50, { message: i18nValidationMessage('validation.max_length') })
    phoneNumber: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    @MaxLength(255, { message: i18nValidationMessage('validation.max_length') })
    name?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    notes?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    @MaxLength(255, { message: i18nValidationMessage('validation.max_length') })
    profilePicture?: string;
}

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}

// ── Customer Address DTOs ─────────────────────────────────────────────

export class CreateCustomerAddressDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    @MaxLength(100, { message: i18nValidationMessage('validation.max_length') })
    label?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_required')})
    address: string;

    @IsOptional()
    @IsUUID('4', { message: i18nValidationMessage('validation.is_uuid') })
    cityId?: string;

    @IsOptional()
    @IsUUID('4', { message: i18nValidationMessage('validation.is_uuid') })
    areaId?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    @MaxLength(200, { message: i18nValidationMessage('validation.max_length') })
    landmark?: string;

    @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
    @IsOptional()
    isDefault?: boolean;
}

export class UpdateCustomerAddressDto extends PartialType(CreateCustomerAddressDto) {}
