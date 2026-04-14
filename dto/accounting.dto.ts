import { PartialType } from "@nestjs/mapped-types";
import { Type } from "class-transformer";
import { IsBoolean, IsDateString, IsNotEmpty, IsNumber, IsOptional, isString, IsString } from "class-validator";

export class AccountingStatsDto {
    @IsOptional()
    @IsDateString()
    startDate?: string;

    @IsOptional()
    @IsDateString()
    endDate?: string;
}


export class CreateManualExpenseCategoryDto {
    @IsString()
    name: string;

    @IsOptional()
    @IsString()
    description?: string;

    @IsOptional()
    @IsBoolean()
    isActive?: boolean;
}

export class UpdateManualExpenseCategoryDto extends PartialType(CreateManualExpenseCategoryDto) { }
export class CreateManualExpenseDto {
    @Type(() => Number) // Convert string to number
    @IsNumber()
    amount: number;

    @IsString()
    categoryId: string;

    @IsOptional()
    @IsString()
    description?: string;

    @IsOptional()
    @IsString()
    attachment?: string;

    @IsOptional()
    @IsDateString()
    collectionDate?: string;

}
export class UpdateManualExpenseDto extends PartialType(CreateManualExpenseDto) { }


export class CloseSupplierPeriodDto {
    @IsNotEmpty()
    supplierId: string;

    @IsDateString()
    @IsNotEmpty()
    startDate: string;

    @IsDateString()
    @IsNotEmpty()
    endDate: string;
}