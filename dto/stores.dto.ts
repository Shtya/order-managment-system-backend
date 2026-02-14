import { Transform, Type } from "class-transformer";
import { IsBoolean, IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, IsUrl, MaxLength, ValidateNested } from "class-validator";
import { StoreProvider } from "entities/stores.entity";

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

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Transform(({ value }) => value?.trim())
  code: string;

  @IsEnum(StoreProvider)
  provider: StoreProvider;

  @IsObject()
  @ValidateNested()
  @Type((opts) => {
    // This is the magic part: it picks the DTO based on the provider value
    const provider = opts?.object?.provider;

    switch (provider) {
      case StoreProvider.SHOPIFY:
        return ShopifyIntegrationsDto;
      case StoreProvider.EASYORDER:
        return EasyOrderIntegrationsDto;
      default:
        return Object; // Fallback for 'custom' or unknown
    }
  })
  integrations: EasyOrderIntegrationsDto | ShopifyIntegrationsDto | any;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsBoolean()
  @IsOptional()
  autoSync?: boolean;
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

  @IsString()
  @IsOptional()
  @MaxLength(50)
  @Transform(({ value }) => value?.trim())
  code: string;

  @IsObject()
  @IsOptional()
  integrations: any;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsBoolean()
  @IsOptional()
  autoSync?: boolean;
}


export class EasyOrderIntegrationsDto {
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  apiKey: string;


  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  webhookCreateOrderSecret?: string;


  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  webhookUpdateStatusSecret?: string;
}

export class ShopifyIntegrationsDto {
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  clientKey?: string;


  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  clientSecret?: string;

}