// dtos/create-order-collection.dto.ts
import { IsNumber, IsString, IsOptional, IsNotEmpty, Min, IsEnum, IsDateString } from 'class-validator';
import { PaymentSource } from 'entities/order-collection.entity';
import { i18nValidationMessage } from "nestjs-i18n";


export class CreateOrderCollectionDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    orderId: string;

    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @Min(0.01, { message: i18nValidationMessage('validation.min') })
    amount: number;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    shippingCompanyId?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    safeId: string;

    @IsEnum(PaymentSource,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(PaymentSource).join(', ')], }); }})
    source: PaymentSource;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    notes?: string;

    @IsDateString({}, {message: i18nValidationMessage('validation.is_date_string')})
    @IsOptional()
    collectedAt?: string;
}