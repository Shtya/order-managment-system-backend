import { IsString } from 'class-validator';
import { i18nValidationMessage } from "nestjs-i18n";



export class CreatePermissionDto {
  @IsString({message: i18nValidationMessage('validation.is_string')}) name: string; // 'users.read'
}
