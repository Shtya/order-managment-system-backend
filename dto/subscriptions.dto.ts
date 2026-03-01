
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
    @IsNumber()
    price?: number; // amount actually paid

    @IsOptional()
    payed?: boolean; // true if already paid

    @IsOptional()
    @IsEnum(TransactionPaymentMethod)
    paymentMethod?: TransactionPaymentMethod;

    @IsOptional()
    @IsNumber()
    amount?: number; // amount actually paid
}


export class UpdateSubscriptionDto {
    @IsOptional()
    @IsInt({ message: 'planId must be an integer' })
    planId?: number;

    @IsOptional()
    @IsNumber()
    price?: number; // amount actually paid

    @IsOptional()
    @IsEnum(SubscriptionStatus, { message: 'status must be a valid SubscriptionStatus' })
    status?: SubscriptionStatus;
}