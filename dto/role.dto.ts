import { IsArray, IsOptional, IsString } from 'class-validator';

export class CreateRoleDto {
	@IsString() name: string; // unique
	@IsOptional() @IsString() description?: string;

	@IsOptional()
	@IsArray()
	permissionNames?: string[];

	@IsOptional() adminId?: number;
	@IsOptional() global?: boolean

}

export class UpdateRoleDto {
	@IsOptional() @IsString() description?: string;
	@IsOptional() name?: string; // unique

	@IsOptional()
	@IsArray()
	permissionNames?: string[];
}
