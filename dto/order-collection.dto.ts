// dtos/create-order-collection.dto.ts
import { IsNumber, IsString, IsOptional, IsNotEmpty, Min, IsEnum, IsInt } from 'class-validator';
import { PaymentSource } from 'entities/order-collection.entity';

export class CreateOrderCollectionDto {
    @IsString()
    @IsNotEmpty()
    orderId: string;

    @IsNumber()
    @Min(0.01, { message: 'Amount must be greater than 0' })
    amount: number;

    @IsString()
    shippingCompanyId: string;

    @IsEnum(PaymentSource)
    source: PaymentSource;

    @IsString()
    @IsOptional()
    notes?: string;

}