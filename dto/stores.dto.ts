import { Transform, Type } from "class-transformer";
import { IsBoolean, IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, IsUrl, MaxLength, ValidateNested } from "class-validator";
import { StoreProvider } from "entities/stores.entity";


export class IntegrationsDto {
  @IsString()
  @IsOptional()
  apiKey: string;

  @IsString()
  @IsOptional()
  clientSecret?: string;

  @IsString()
  @IsOptional()
  webhookCreateOrderSecret?: string;


  @IsString()
  @IsOptional()
  webhookUpdateStatusSecret?: string;

  @IsString()
  @IsOptional()
  webhookSecret?: string;
}

export class CreateStoreDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(({ value }) => value?.trim())
  name: string;

  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => value?.trim())
  storeUrl: string;

  @IsEnum(StoreProvider)
  provider: StoreProvider;

  @IsObject()
  @ValidateNested()
  @Type(() => IntegrationsDto)
  credentials: IntegrationsDto;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

}

export class UpdateStoreDto {
  @IsString()
  @IsOptional()
  @MaxLength(120)
  @Transform(({ value }) => value?.trim())
  name: string;

  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  storeUrl: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => IntegrationsDto)
  credentials: IntegrationsDto;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

