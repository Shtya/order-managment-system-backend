import { PartialType } from "@nestjs/mapped-types";
import { IsBoolean, IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString } from "class-validator";

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
    @IsNumber()
    amount: number;

    @IsOptional()
    @IsString()
    description?: string;

    @IsOptional()
    @IsString()
    attachment?: string;

    @IsNumber()
    categoryId: number;

    @IsOptional()
    @IsDateString()
    collectionDate?: string;

}
export class UpdateManualExpenseDto extends PartialType(CreateManualExpenseDto) { }


export class CloseSupplierPeriodDto {
    @IsNumber()
    @IsNotEmpty()
    supplierId: number;

    @IsDateString()
    @IsNotEmpty()
    startDate: string;

    @IsDateString()
    @IsNotEmpty()
    endDate: string;
}