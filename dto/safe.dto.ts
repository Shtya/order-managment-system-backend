import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { AccountType, TransactionDirection, TransactionReferenceType } from 'entities/safe.entity';

export class CreateAccountDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsEnum(AccountType)
    type: AccountType;

    @IsString()
    @IsOptional()
    currency?: string = 'EGP';

    @IsNumber()
    @Min(0)
    @IsOptional()
    initialBalance?: number = 0;

    @IsString()
    @IsOptional()
    bankName?: string;

    @IsString()
    @IsOptional()
    accountOwnerName?: string;

    @IsString()
    @IsOptional()
    accountNumber?: string;

    @IsString()
    @IsOptional()
    iban?: string;

    @IsNumber()
    @IsOptional()
    commissionRate?: number;

    @IsUUID()
    @IsOptional()
    managedById?: string;

    @IsString()
    @IsOptional()
    notes?: string;
}

export class UpdateAccountDto {
    @IsString()
    @IsOptional()
    name?: string;

    @IsString()
    @IsOptional()
    currency?: string;

    @IsString()
    @IsOptional()
    bankName?: string;

    @IsString()
    @IsOptional()
    accountOwnerName?: string;

    @IsString()
    @IsOptional()
    accountNumber?: string;

    @IsString()
    @IsOptional()
    iban?: string;

    @IsNumber()
    @IsOptional()
    commissionRate?: number;

    @IsUUID()
    @IsOptional()
    managedById?: string;

    @IsString()
    @IsOptional()
    notes?: string;
}

export class CreateTransactionDto {
    @IsUUID()
    @IsNotEmpty()
    accountId: string;

    @IsNumber()
    @Min(0.01)
    amount: number;

    @IsEnum(TransactionReferenceType)
    referenceType: TransactionReferenceType;

    @IsString()
    @IsOptional()
    referenceId?: string;

    @IsString()
    @IsOptional()
    counterparty?: string;

    @IsString()
    @IsOptional()
    notes?: string;

    @IsString()
    @IsOptional()
    attachmentUrl?: string;

    @IsOptional()
    transactionDate?: Date;

    @IsOptional()
    referenceMeta?: Record<string, any>;
}

export class CreateTransferDto {
    @IsUUID()
    @IsNotEmpty()
    fromAccountId: string;

    @IsUUID()
    @IsNotEmpty()
    toAccountId: string;

    @IsNumber()
    @Min(0.01)
    amount: number;

    @IsString()
    @IsOptional()
    notes?: string;
}

export class AccountFilterDto {
    @IsOptional()
    @IsEnum(AccountType)
    type?: AccountType;

    @IsOptional()
    @IsString()
    search?: string;

    @IsOptional()
    @Transform(({ value }) => (value !== undefined ? Number(value) : value))
    @IsNumber()
    page?: number;

    @IsOptional()
    @Transform(({ value }) => (value !== undefined ? Number(value) : value))
    @IsNumber()
    limit?: number;
}

export class TransactionFilterDto {
    @IsOptional()
    @IsUUID()
    accountId?: string;

    @IsOptional()
    @IsEnum(TransactionDirection)
    direction?: TransactionDirection;

    @IsOptional()
    @IsEnum(TransactionReferenceType)
    referenceType?: TransactionReferenceType;

    @IsOptional()
    @IsString()
    search?: string;

    @IsOptional()
    startDate?: string;

    @IsOptional()
    endDate?: string;

    @IsOptional()
    @Transform(({ value }) => (value !== undefined ? Number(value) : value))
    @IsNumber()
    page?: number;

    @IsOptional()
    @Transform(({ value }) => (value !== undefined ? Number(value) : value))
    @IsNumber()
    limit?: number;
}

export class TransferFilterDto {
    @IsOptional()
    @IsUUID()
    fromAccountId?: string;

    @IsOptional()
    @IsUUID()
    toAccountId?: string;

    @IsOptional()
    @IsString()
    search?: string;

    @IsOptional()
    startDate?: string;

    @IsOptional()
    endDate?: string;

    @IsOptional()
    @Transform(({ value }) => (value !== undefined ? Number(value) : value))
    @IsNumber()
    page?: number;

    @IsOptional()
    @Transform(({ value }) => (value !== undefined ? Number(value) : value))
    @IsNumber()
    limit?: number;
}
