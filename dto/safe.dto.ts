import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { AccountType, TransactionDirection, TransactionReferenceType } from 'entities/safe.entity';
import { i18nValidationMessage } from "nestjs-i18n";


export class CreateAccountDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    name: string;

    @IsEnum(AccountType,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(AccountType).join(', ')], }); }})
    type: AccountType;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    currency?: string = 'EGP';

    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @Min(0, {message: i18nValidationMessage('validation.min')})
    @IsOptional()
    initialBalance?: number = 0;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    bankName?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    accountOwnerName?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    accountNumber?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    iban?: string;

    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @IsOptional()
    commissionRate?: number;

    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    @IsOptional()
    managedById?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    notes?: string;
}

export class UpdateAccountDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    name?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    currency?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    bankName?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    accountOwnerName?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    accountNumber?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    iban?: string;

    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @IsOptional()
    commissionRate?: number;

    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    @IsOptional()
    managedById?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    notes?: string;
}

export class CreateTransactionDto {
    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    accountId: string;

    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @Min(0.01, {message: i18nValidationMessage('validation.min')})
    amount: number;

    @IsEnum(TransactionReferenceType,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(TransactionReferenceType).join(', ')], }); }})
    referenceType: TransactionReferenceType;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    referenceId?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    counterparty?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    notes?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    attachmentUrl?: string;

    @IsOptional()
    transactionDate?: Date;

    @IsOptional()
    referenceMeta?: Record<string, any>;
}

export class CreateTransferDto {
    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    fromAccountId: string;

    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    toAccountId: string;

    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @Min(0.01, {message: i18nValidationMessage('validation.min')})
    amount: number;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    notes?: string;
}

export class AccountFilterDto {
    @IsOptional()
    @IsEnum(AccountType,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(AccountType).join(', ')], }); }})
    type?: AccountType;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    search?: string;

    @IsOptional()
    @Transform(({ value }) => (value !== undefined ? Number(value) : value))
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    page?: number;

    @IsOptional()
    @Transform(({ value }) => (value !== undefined ? Number(value) : value))
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    limit?: number;
}

export class TransactionFilterDto {
    @IsOptional()
    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    accountId?: string;

    @IsOptional()
    @IsEnum(TransactionDirection,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(TransactionDirection).join(', ')], }); }})
    direction?: TransactionDirection;

    @IsOptional()
    @IsEnum(TransactionReferenceType,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(TransactionReferenceType).join(', ')], }); }})
    referenceType?: TransactionReferenceType;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    search?: string;

    @IsOptional()
    startDate?: string;

    @IsOptional()
    endDate?: string;

    @IsOptional()
    @Transform(({ value }) => (value !== undefined ? Number(value) : value))
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    page?: number;

    @IsOptional()
    @Transform(({ value }) => (value !== undefined ? Number(value) : value))
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    limit?: number;
}

export class TransferFilterDto {
    @IsOptional()
    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    fromAccountId?: string;

    @IsOptional()
    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    toAccountId?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    search?: string;

    @IsOptional()
    startDate?: string;

    @IsOptional()
    endDate?: string;

    @IsOptional()
    @Transform(({ value }) => (value !== undefined ? Number(value) : value))
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    page?: number;

    @IsOptional()
    @Transform(({ value }) => (value !== undefined ? Number(value) : value))
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    limit?: number;
}
