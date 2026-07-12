import { Transform, Type } from "class-transformer";
import { IsBoolean, IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, IsUrl, MaxLength, ValidateNested } from "class-validator";
import { StoreProvider } from "entities/stores.entity";
import { i18nValidationMessage } from "nestjs-i18n";


export class IntegrationsDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  apiKey: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  clientSecret?: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  webhookCreateOrderSecret?: string;


  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  webhookUpdateStatusSecret?: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  webhookSecret?: string;
}

export class CreateStoreDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
  @Transform(({ value }) => value?.trim())
  name: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @Transform(({ value }) => value?.trim())
  storeUrl: string;

  @IsEnum(StoreProvider,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(StoreProvider).join(', ')], }); }})
  provider: StoreProvider;

  @IsObject({message: i18nValidationMessage('validation.is_object')})
  @ValidateNested()
  @Type(() => IntegrationsDto)
  credentials: IntegrationsDto;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  isActive?: boolean;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  syncNewProducts?: boolean;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  syncRemoteProducts?: boolean;
}

export class IntegrateDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
  @Transform(({ value }) => value?.trim())
  name: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  @Transform(({ value }) => value?.trim())
  storeUrl: string;

  @IsEnum(StoreProvider,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(StoreProvider).join(', ')], }); }})
  provider: StoreProvider;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  syncNewProducts?: boolean;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  syncRemoteProducts?: boolean;

  @IsOptional()
  @IsObject({message: i18nValidationMessage('validation.is_object')})
  @ValidateNested()
  @Type(() => IntegrationsDto)
  credentials: IntegrationsDto;
}

export class UpdateStoreDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  @MaxLength(120, { message: i18nValidationMessage('validation.max_length') })
  @Transform(({ value }) => value?.trim())
  name: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  storeUrl: string;

  @IsOptional()
  @IsObject({message: i18nValidationMessage('validation.is_object')})
  @ValidateNested()
  @Type(() => IntegrationsDto)
  credentials: IntegrationsDto;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  isActive?: boolean;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  syncNewProducts?: boolean;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  syncRemoteProducts?: boolean;
}



export class EasyOrdersCredentialsDto {
  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  apiKey: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
  storeId: string;
}


