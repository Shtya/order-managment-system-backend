import { IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { i18nValidationMessage } from "nestjs-i18n";


export class CreateSupplierPaymentDto {
    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    supplierId: string;


    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    @IsOptional()
    invoiceId?: string;


    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    safeId: string;


    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @Min(0.01, {message: i18nValidationMessage('validation.min')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    amount: number;


    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    paymentDate: string;


    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    notes?: string;
}

export class SupplierPaymentFilterDto {

    @IsOptional()
    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    supplierId?: string;


    @IsOptional()
    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    invoiceId?: string;


    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    startDate?: string;


    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    endDate?: string;


    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    page?: string;


    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    limit?: string;


    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    search?: string;
}
