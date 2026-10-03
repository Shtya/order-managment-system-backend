import { IsBoolean, IsEnum, IsOptional, IsUUID, ValidateIf } from "class-validator";
import { i18nValidationMessage } from "nestjs-i18n";
import {
  ConversationAiMode,
  WhatsappAiAgentSource,
  WhatsappAiResponses,
} from "entities/whatsapp.entity";

export class UpdateWhatsappAccountAiDto {
  @IsEnum(WhatsappAiResponses, {
    message: (args) =>
      i18nValidationMessage("validation.is_enum")({
        ...args,
        constraints: [Object.values(WhatsappAiResponses).join(", ")],
      }),
  })
  aiResponses: WhatsappAiResponses;

  @IsOptional()
  @IsEnum(WhatsappAiAgentSource, {
    message: (args) =>
      i18nValidationMessage("validation.is_enum")({
        ...args,
        constraints: [Object.values(WhatsappAiAgentSource).join(", ")],
      }),
  })
  aiAgentSource?: WhatsappAiAgentSource;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== "")
  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  aiAgentId?: string | null;
}

export class UpdateConversationAiDto {
  @IsEnum(ConversationAiMode, {
    message: (args) =>
      i18nValidationMessage("validation.is_enum")({
        ...args,
        constraints: [Object.values(ConversationAiMode).join(", ")],
      }),
  })
  aiMode: ConversationAiMode;
}

export class UpdateConversationHandoffDto {
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  humanHandoff: boolean;
}
