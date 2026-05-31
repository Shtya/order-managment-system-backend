import { IsString, IsOptional, IsEmail, MaxLength } from 'class-validator';

export class UpdateCustomerDto {
    @IsString()
    @IsOptional()
    @MaxLength(255)
    name?: string;

    @IsString()
    @IsOptional()
    @MaxLength(50)
    phoneNumber?: string;

    @IsString()
    @IsOptional()
    @MaxLength(255)
    profilePicture?: string;

    @IsEmail()
    @IsOptional()
    email?: string;

    @IsString()
    @IsOptional()
    notes?: string;
}
