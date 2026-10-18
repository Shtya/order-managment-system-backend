import {
  IsEmail,
  IsArray,
  ArrayMaxSize,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";
import type { EmailDocument, EmailVariables } from "../src/email/email.types";

export class EmailConnectDto {
  @IsOptional() @IsString() @MaxLength(300) returnTo?: string;
  @IsOptional() @IsBoolean() browserRedirect?: boolean;
}
export class EmailContentDto {
  @IsString() @MaxLength(200) subject: string;
  @IsOptional() @IsString() @MaxLength(300) preheader?: string;
  @IsObject() document: EmailDocument;
  @IsString() @MaxLength(1000) businessIdentity: string;
  @IsOptional() @IsObject() variables?: EmailVariables;
}
export class EmailTestDto extends EmailContentDto {
  @IsUUID() accountId: string;
  @IsEmail() to: string;
}
export class EmailConsentDto {
  @IsEmail() email: string;
  @IsString() @MaxLength(2000) evidence: string;
}

export class EmailAssetLeaseDto {
  @IsArray() @ArrayMaxSize(300) @IsUUID("4", { each: true }) ids: string[];
}
