// dtos/create-order-collection.dto.ts
import { IsNumber, IsString, IsOptional, IsNotEmpty, Min, IsEnum, IsInt } from 'class-validator';
import { PaymentSource } from 'entities/order-collection.entity';

export class CreateOrderCollectionDto {
    @IsNumber()
    @IsNotEmpty()
    orderId: number;

    @IsNumber()
    @Min(0.01, { message: 'Amount must be greater than 0' })
    amount: number;

    @IsInt()
    shippingCompanyId: number;

    @IsEnum(PaymentSource)
    source: PaymentSource;

    @IsString()
    @IsOptional()
    notes?: string;

    @IsString()
    @IsOptional()
    currency?: string;
}