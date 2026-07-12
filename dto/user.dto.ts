import { Transform } from 'class-transformer';
import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Min, MinLength } from 'class-validator';
import { i18nValidationMessage } from 'nestjs-i18n';




export class AdminCreateUserDto {
	@IsString({message: i18nValidationMessage('validation.is_string')}) name: string;
	@IsEmail({}, {message: i18nValidationMessage('validation.is_email')}) email: string;


	@IsString({message: i18nValidationMessage('validation.is_string')}) roleId: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	planId?: string;

	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) phone?: string;
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) employeeType?: string;
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) 
	@MinLength(6, { message: i18nValidationMessage('validation.min_length') }) 
	password?: string;
}

export class UpdateUserDto {
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) name?: string;
	@IsOptional() @IsEmail({}, {message: i18nValidationMessage('validation.is_email')}) email?: string;
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) roleId?: string;
	@IsOptional() isActive?: boolean;

	// ✅ NEW (عشان تعديل الخطة من Edit)
	@IsOptional()
	planId?: any | null;

	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) phone?: string;
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) employeeType?: string;
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) 
	@MinLength(6, { message: i18nValidationMessage('validation.min_length') }) password?: string;
}

export class UpdateMeUserDto {
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) name?: string;
	@IsOptional() isActive?: boolean;

	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) phone?: string;
}



export class UpsertCompanyDto {
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
	name: string;

	@IsString({message: i18nValidationMessage('validation.is_string')})
	@IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
	country: string;

	@IsString({message: i18nValidationMessage('validation.is_string')})
	@IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
	currency: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	tax?: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	commercial?: string;

	@IsString({message: i18nValidationMessage('validation.is_string')})
	@IsOptional()
	phone: string;

	@IsOptional()
	@IsUrl({}, {message: i18nValidationMessage('validation.is_url')})
	website?: string;

	@IsString({message: i18nValidationMessage('validation.is_string')})
	@IsOptional()
	address: string;

	@IsString({message: i18nValidationMessage('validation.is_string')})
	@IsOptional()
	businessType: string;
}

export class ChangePasswordDto {
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
	oldPassword: string;

	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MinLength(6, { message: i18nValidationMessage('validation.min_length') })
	newPassword: string;
}

export class SetPasswordDto {
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MinLength(6, { message: i18nValidationMessage('validation.min_length') })
	newPassword: string;
}

export class RequestEmailChangeDto {
	@IsEmail({}, {message: i18nValidationMessage('validation.is_email')})
	newEmail: string;
}

export class VerifyEmailChangeDto {
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
	otp: string;
}

export class AdminCreateAvatarDto {
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
	name: string;

	@IsEmail({}, {message: i18nValidationMessage('validation.is_email')})
	email: string;

	@IsString({message: i18nValidationMessage('validation.is_string')})
	@IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
	roleId: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MinLength(6, { message: i18nValidationMessage('validation.min_length') })
	password?: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	phone?: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	employeeType?: string;
}


export class AdminCreateDto {
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
	name: string;

	@IsEmail({}, {message: i18nValidationMessage('validation.is_email')})
	@IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
	email: string;

	@IsString({message: i18nValidationMessage('validation.is_string')})
	@IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
	roleId: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	@MinLength(6, { message: i18nValidationMessage('validation.min_length') })
	password?: string;

	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	adminId?: string;
}