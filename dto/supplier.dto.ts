import { IsString, IsOptional, IsEmail, MaxLength, IsArray, IsNumber, IsIn } from "class-validator";

export class CreateSupplierDto {
	@IsString()
	@MaxLength(120)
	name: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	address?: string;

	@IsOptional()
	@IsString()
	description?: string;

	@IsString()
	@MaxLength(30)
	phone: string;

	@IsOptional()
	@IsString()
	@MaxLength(10)
	phoneCountry?: string;

	@IsOptional()
	@IsString()
	@MaxLength(30)
	secondPhone?: string;

	@IsOptional()
	@IsString()
	@MaxLength(10)
	secondPhoneCountry?: string;

	@IsOptional()
	@IsEmail()
	@MaxLength(100)
	email?: string;

	@IsArray()
	@IsNumber({}, { each: true })
	categoryIds: number[];
}

export class UpdateSupplierDto {
	@IsOptional()
	@IsString()
	@MaxLength(120)
	name?: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	address?: string;

	@IsOptional()
	@IsString()
	description?: string;

	@IsOptional()
	@IsString()
	@MaxLength(30)
	phone?: string;

	@IsOptional()
	@IsString()
	@MaxLength(10)
	phoneCountry?: string;

	@IsOptional()
	@IsString()
	@MaxLength(30)
	secondPhone?: string;

	@IsOptional()
	@IsString()
	@MaxLength(10)
	secondPhoneCountry?: string;

	@IsOptional()
	@IsEmail()
	@MaxLength(100)
	email?: string;

	@IsOptional()
	@IsArray()
	@IsNumber({}, { each: true })
	categoryIds?: number[];
}

export class UpdateSupplierFinancialsDto {
	@IsOptional()
	@IsNumber()
	dueBalance?: number;

	@IsOptional()
	@IsNumber()
	purchaseValue?: number;
}


export class CreateSupplierCategoryDto {
	@IsString()
	@MaxLength(100)
	name: string;

	@IsOptional()
	@IsString()
	@MaxLength(500)
	description?: string;
}

export class UpdateSupplierCategoryDto {
	@IsOptional()
	@IsString()
	@MaxLength(100)
	name?: string;

	@IsOptional()
	@IsString()
	@MaxLength(500)
	description?: string;
}