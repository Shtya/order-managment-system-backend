import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Min, MinLength } from 'class-validator';

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
	@IsOptional() @IsInt() roleId?: string;
	@IsOptional() isActive?: boolean;

	// ✅ NEW (عشان تعديل الخطة من Edit)
	@IsOptional()
	planId?: any | null;

	@IsOptional() @IsString() phone?: string;
	@IsOptional() @IsString() employeeType?: string;
}

export class UpdateMeUserDto {
	@IsOptional() @IsString() name?: string;
	@IsOptional() isActive?: boolean;

	@IsOptional() @IsString() phone?: string;
}



export class UpsertCompanyDto {
	@IsString()
	@IsNotEmpty()
	name: string;

	@IsString()
	@IsNotEmpty()
	country: string;

	@IsString()
	@IsNotEmpty()
	currency: string;

	@IsOptional()
	@IsString()
	tax?: string;

	@IsOptional()
	@IsString()
	commercial?: string;

	@IsString()
	@IsOptional()
	phone: string;

	@IsOptional()
	@IsUrl()
	website?: string;

	@IsString()
	@IsOptional()
	address: string;

	@IsString()
	@IsOptional()
	businessType: string;
}

export class ChangePasswordDto {
	@IsString()
	@IsNotEmpty()
	oldPassword: string;

	@IsString()
	@MinLength(6)
	newPassword: string;
}

export class RequestEmailChangeDto {
	@IsEmail()
	newEmail: string;
}

export class VerifyEmailChangeDto {
	@IsString()
	@IsNotEmpty()
	otp: string;
}

export class AdminCreateAvatarDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail({}, { message: 'Invalid email format' })
  email: string;

  @IsString()
  @IsNotEmpty()
  roleId: string;

  @IsOptional()
  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters' })
  password?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  employeeType?: string;
}


export class AdminCreateDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail({}, { message: 'Invalid email format' })
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  roleId: string;

  @IsOptional()
  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters' })
  password?: string;
}