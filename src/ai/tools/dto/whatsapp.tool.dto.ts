import {
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class ListWhatsappTemplatesToolArgsDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class SendWhatsappTextToolArgsDto {
  @IsString()
  @MinLength(8)
  @MaxLength(20)
  phoneNumber: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  text: string;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  orderId?: string;
}

export class SendWhatsappTemplateToolArgsDto {
  @IsString()
  @MinLength(8)
  @MaxLength(20)
  phoneNumber: string;

  @IsString()
  @MinLength(1)
  templateId: string;

  @IsOptional()
  @IsObject()
  headerVariables?: Record<string, any>;

  @IsOptional()
  @IsObject()
  bodyVariables?: Record<string, any>;

  @IsOptional()
  @IsObject()
  buttonVariables?: Record<string, any>;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  orderId?: string;
}
