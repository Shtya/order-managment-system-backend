import {
  IsEmail,
  IsEmpty,
  isEmpty,
  IsOptional,
  IsString,
  IsUrl,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

class SocialsDto {
  @IsOptional()
  @IsUrl()
  facebook?: string;
  @IsOptional()
  @IsUrl()
  instagram?: string;
  @IsOptional()
  @IsUrl()
  x?: string;
  @IsOptional()
  @IsUrl()
  linkedin?: string;
  @IsOptional()
  @IsUrl()
  github?: string;
  @IsOptional()
  @IsUrl()
  youtube?: string;
}

export class UpdateAdminSettingsDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  whatsapp?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SocialsDto)
  socials?: SocialsDto;
}
