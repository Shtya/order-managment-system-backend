
import { IsEnum, IsInt, IsOptional, IsNumber } from 'class-validator';
import { TransactionPaymentMethod, SubscriptionStatus } from 'entities/plans.entity';


export class CreateSubscriptionDto {
    @IsInt()
    userId: number;

    @IsInt()
    planId: number;

    @IsEnum(SubscriptionStatus)
    status: SubscriptionStatus;

    @IsOptional()
    payed?: boolean; // true if already paid

    @IsOptional()
    @IsEnum(TransactionPaymentMethod)
    paymentMethod?: TransactionPaymentMethod;

    @IsOptional()
    @IsNumber()
    amount?: number; // amount actually paid
}