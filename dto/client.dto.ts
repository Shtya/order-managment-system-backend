import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { plainToInstance, Transform, Type } from "class-transformer";
import { PartialType } from "@nestjs/mapped-types";
import { i18nValidationMessage } from "nestjs-i18n";



export class ClientContactInputDto {
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @IsNotEmpty({ message: i18nValidationMessage("validation.is_required") })
  @MaxLength(50, { message: i18nValidationMessage("validation.max_length") })
  phoneNumber: string;

  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  @IsOptional()
  customerId?: string;

  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  @IsOptional()
  isPrimary?: boolean;
}

export class CreateClientDto {
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @IsOptional()
  @MaxLength(255, { message: i18nValidationMessage("validation.max_length") })
  name?: string;

  @IsEmail({}, { message: i18nValidationMessage("validation.is_email") })
  @IsOptional()
  email?: string;

  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @IsOptional()
  notes?: string;

  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @IsOptional()
  @MaxLength(255, { message: i18nValidationMessage("validation.max_length") })
  profilePicture?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return parsed;
    return parsed.map((item) => plainToInstance(ClientContactInputDto, item));
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClientContactInputDto)
  contacts?: ClientContactInputDto[];
}

export class UpdateClientDto extends PartialType(CreateClientDto) {}

export class LinkClientContactDto {
  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  @IsOptional()
  customerId?: string;

  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @IsOptional()
  @MaxLength(50, { message: i18nValidationMessage("validation.max_length") })
  phoneNumber?: string;

  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  @IsOptional()
  isPrimary?: boolean;
}

export class CreateClientAddressDto {
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @IsOptional()
  @MaxLength(100, { message: i18nValidationMessage("validation.max_length") })
  label?: string;

  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @IsNotEmpty({ message: i18nValidationMessage("validation.is_required") })
  address: string;

  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  @IsOptional()
  cityId?: string;

  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  @IsOptional()
  areaId?: string;

  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @IsOptional()
  @MaxLength(200, { message: i18nValidationMessage("validation.max_length") })
  landmark?: string;

  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  @IsOptional()
  isDefault?: boolean;
}

export class UpdateClientAddressDto extends PartialType(CreateClientAddressDto) {}
