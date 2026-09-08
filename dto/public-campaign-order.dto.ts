import { Transform } from "class-transformer";
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { i18nValidationMessage } from "nestjs-i18n";

export class PublicCampaignOrderSubmitDto {
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @IsNotEmpty({ message: i18nValidationMessage("validation.is_not_empty") })
  @MinLength(1)
  @MaxLength(200)
  customerName: string;

  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @IsNotEmpty({ message: i18nValidationMessage("validation.is_not_empty") })
  @MaxLength(1000)
  address: string;

  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @IsNotEmpty({ message: i18nValidationMessage("validation.is_not_empty") })
  @MaxLength(100)
  city: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (value === "" ? undefined : value))
  cityId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  area?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  areaId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  landmark?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MaxLength(4000)
  customerNotes?: string;
}
