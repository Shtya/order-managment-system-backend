import { PartialType } from "@nestjs/mapped-types";
import { Type } from "class-transformer";
import { IsBoolean, IsDateString, IsNotEmpty, IsNumber, IsOptional, isString, IsString } from "class-validator";
import { i18nValidationMessage } from "nestjs-i18n";

export class AccountingStatsDto {
    @IsOptional()
    @IsDateString({}, {message: i18nValidationMessage('validation.is_date_string')})
    startDate?: string;

    @IsOptional()
    @IsDateString({}, {message: i18nValidationMessage('validation.is_date_string')})
    endDate?: string;
}


export class CreateManualExpenseCategoryDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    name: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    description?: string;

    @IsOptional()
    @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
    isActive?: boolean;
}

export class UpdateManualExpenseCategoryDto extends PartialType(CreateManualExpenseCategoryDto) { }
export class CreateManualExpenseDto {
    @Type(() => Number) // Convert string to number
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    amount: number;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    categoryId: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    description?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    attachment?: string;

    @IsOptional()
    @IsDateString({}, {message: i18nValidationMessage('validation.is_date_string')})
    collectionDate?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    safeId: string;

}
export class UpdateManualExpenseDto extends PartialType(CreateManualExpenseDto) { }


export class CloseSupplierPeriodDto {
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    supplierId: string;

    @IsDateString({}, {message: i18nValidationMessage('validation.is_date_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    startDate: string;

    @IsDateString({}, {message: i18nValidationMessage('validation.is_date_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    endDate: string;
}