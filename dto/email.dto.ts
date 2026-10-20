import {
  IsEmail,
  IsArray,
  ArrayMaxSize,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  IsIn,
  IsInt,
  IsNotEmpty,
  Min,
  Max,
  MaxLength,
} from "class-validator";
import { Type } from "class-transformer";
import type { EmailDocument, EmailVariables } from "../src/email/email.types";

export class EmailConnectDto {
  @IsOptional() @IsString() @MaxLength(300) returnTo?: string;
  @IsOptional() @IsBoolean() browserRedirect?: boolean;
}
export class SmtpConnectionDto {
  @IsString() @IsNotEmpty() @MaxLength(100) connectionName: string;
  @IsString() @IsNotEmpty() @MaxLength(253) host: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(65535) port: number;
  @IsIn(["starttls", "tls"]) security: "starttls" | "tls";
  @IsString() @IsNotEmpty() @MaxLength(320) username: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) password: string;
  @IsEmail() fromEmail: string;
  @IsString() @IsNotEmpty() @MaxLength(200) fromName: string;
}
export class UpdateSmtpConnectionDto {
  @IsString() @IsNotEmpty() @MaxLength(100) connectionName: string;
  @IsString() @IsNotEmpty() @MaxLength(253) host: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(65535) port: number;
  @IsIn(["starttls", "tls"]) security: "starttls" | "tls";
  @IsString() @IsNotEmpty() @MaxLength(320) username: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(2000) password?: string;
  @IsEmail() fromEmail: string;
  @IsString() @IsNotEmpty() @MaxLength(200) fromName: string;
}
export class SmtpTestConnectionDto extends UpdateSmtpConnectionDto {
  @IsOptional() @IsUUID() accountId?: string;
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
