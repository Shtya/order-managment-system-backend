import { IsOptional, IsString } from 'class-validator';

import { PartialType } from '@nestjs/mapped-types';
import { i18nValidationMessage } from 'nestjs-i18n';

export class CreateAssetDto {
	@IsOptional()
	@IsString({message: i18nValidationMessage('validation.is_string')})
	filename?: string;
}

export class UpdateAssetDto extends PartialType(CreateAssetDto) { }
