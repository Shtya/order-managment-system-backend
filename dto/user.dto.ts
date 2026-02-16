import { IsEmail, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class AdminCreateUserDto {
	@IsString() name: string;
	@IsEmail() email: string;

	@IsOptional()
	@MinLength(6)
	@IsString()
	password?: string;
	roleId: any;
	@IsOptional()
	planId?: any;

	@IsOptional() @IsString() phone?: string;
	@IsOptional() @IsString() employeeType?: string;
}

export class UpdateUserDto {
	@IsOptional() @IsString() name?: string;
	@IsOptional() @IsEmail() email?: string;
	@IsOptional() @IsInt() roleId?: number;
	@IsOptional() isActive?: boolean;

	// ✅ NEW (عشان تعديل الخطة من Edit)
	@IsOptional()
	planId?: any | null;

	@IsOptional() @IsString() phone?: string;
	@IsOptional() @IsString() employeeType?: string;
}


