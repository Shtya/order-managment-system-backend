import { IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateSupplierPaymentDto {
    @IsUUID()
    @IsNotEmpty()
    supplierId: string;


    @IsUUID()
    @IsOptional()
    invoiceId?: string;


    @IsUUID()
    @IsNotEmpty()
    safeId: string;


    @IsNumber()
    @Min(0.01)
    @IsNotEmpty()
    amount: number;


    @IsNotEmpty()
    paymentDate: string;


    @IsString()
    @IsOptional()
    notes?: string;
}

export class SupplierPaymentFilterDto {

    @IsOptional()
    @IsUUID()
    supplierId?: string;


    @IsOptional()
    @IsUUID()
    invoiceId?: string;


    @IsOptional()
    @IsString()
    startDate?: string;


    @IsOptional()
    @IsString()
    endDate?: string;


    @IsOptional()
    @IsString()
    page?: string;


    @IsOptional()
    @IsString()
    limit?: string;


    @IsOptional()
    @IsString()
    search?: string;
}
