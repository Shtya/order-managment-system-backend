import { IsArray, IsOptional, IsString } from 'class-validator';
import { i18nValidationMessage } from "nestjs-i18n";


export class CreateRoleDto {
	@IsString({message: i18nValidationMessage('validation.is_string')}) name: string; // unique
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) description?: string;

	@IsOptional()
	@IsArray({message: i18nValidationMessage('validation.is_array')})
	permissionNames?: string[];

	@IsOptional() adminId?: string;
	@IsOptional() global?: boolean

}

export class UpdateRoleDto {
	@IsOptional() @IsString({message: i18nValidationMessage('validation.is_string')}) description?: string;
	@IsOptional() name?: string; // unique

	@IsOptional()
	@IsArray({message: i18nValidationMessage('validation.is_array')})
	permissionNames?: string[];
}
