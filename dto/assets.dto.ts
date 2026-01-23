import { IsOptional, IsString } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';

export class CreateAssetDto {
	@IsOptional()
	@IsString()
	filename?: string;
}

export class UpdateAssetDto extends PartialType(CreateAssetDto) { }
