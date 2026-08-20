import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class AiChatHistoryMessageDto {
  @IsIn(["system", "user", "assistant", "tool"])
  role: "system" | "user" | "assistant" | "tool";

  @IsOptional()
  @IsString()
  @MaxLength(50_000)
  content?: string | null;

  @IsOptional()
  @IsString()
  toolCallId?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsArray()
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

export class AiChatRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20_000)
  message: string;

  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AiChatHistoryMessageDto)
  history?: AiChatHistoryMessageDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedToolNames?: string[];

  @IsOptional()
  @IsString()
  provider?: string;

  @IsOptional()
  @IsUUID()
  providerId?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsBoolean()
  enforcePiiMasking?: boolean;

  @IsOptional()
  @IsBoolean()
  acceptWriteOperations?: boolean;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class AiStatusProviderDto {
  name: string;
  displayName: string;
  enabled: boolean;
  model: string;
  healthy: boolean;
}

export class AiStatusResponseDto {
  enabled: boolean;
  defaultProvider: string;
  providers: AiStatusProviderDto[];
}
