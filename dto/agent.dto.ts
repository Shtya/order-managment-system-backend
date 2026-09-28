import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from "class-validator";
import { i18nValidationMessage } from "nestjs-i18n";
import { AgentGender, AgentLanguage } from "entities/agent.entity";

const languageEnumMessage = (args: any) =>
  i18nValidationMessage("validation.is_enum")({
    ...args,
    constraints: [Object.values(AgentLanguage).join(", ")],
  });

const genderEnumMessage = (args: any) =>
  i18nValidationMessage("validation.is_enum")({
    ...args,
    constraints: [Object.values(AgentGender).join(", ")],
  });

export class CreateAgentDto {
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(1, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(255, { message: i18nValidationMessage("validation.max_length") })
  name: string;

  @IsEnum(AgentLanguage, { message: languageEnumMessage })
  language: AgentLanguage;

  @IsOptional()
  @IsEnum(AgentGender, { message: genderEnumMessage })
  gender?: AgentGender;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MaxLength(4000, { message: i18nValidationMessage("validation.max_length") })
  customInstructions?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  responseProviderId?: string | null;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  isActive?: boolean;

  @IsOptional()
  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @IsUUID("4", { each: true, message: i18nValidationMessage("validation.is_uuid") })
  @ArrayMaxSize(100, { message: i18nValidationMessage("validation.array_max_size") })
  knowledgeIds?: string[];
}

export class UpdateAgentDto {
  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(1, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(255, { message: i18nValidationMessage("validation.max_length") })
  name?: string;

  @IsOptional()
  @IsEnum(AgentLanguage, { message: languageEnumMessage })
  language?: AgentLanguage;

  @IsOptional()
  @IsEnum(AgentGender, { message: genderEnumMessage })
  gender?: AgentGender;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MaxLength(4000, { message: i18nValidationMessage("validation.max_length") })
  customInstructions?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  responseProviderId?: string | null;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  isActive?: boolean;

  @IsOptional()
  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @IsUUID("4", { each: true, message: i18nValidationMessage("validation.is_uuid") })
  @ArrayMaxSize(100, { message: i18nValidationMessage("validation.array_max_size") })
  knowledgeIds?: string[];
}

export class CreateAgentKnowledgeDto {
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(1, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(255, { message: i18nValidationMessage("validation.max_length") })
  title: string;

  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(1, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(2000, { message: i18nValidationMessage("validation.max_length") })
  content: string;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  isActive?: boolean;

  @IsOptional()
  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @IsUUID("4", { each: true, message: i18nValidationMessage("validation.is_uuid") })
  @ArrayMaxSize(100, { message: i18nValidationMessage("validation.array_max_size") })
  agentIds?: string[];
}

export class UpdateAgentKnowledgeDto {
  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(1, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(255, { message: i18nValidationMessage("validation.max_length") })
  title?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(1, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(2000, { message: i18nValidationMessage("validation.max_length") })
  content?: string;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  isActive?: boolean;
}

export class ResetAgentKnowledgeDto {
  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @IsUUID("4", { each: true, message: i18nValidationMessage("validation.is_uuid") })
  @ArrayMaxSize(100, { message: i18nValidationMessage("validation.array_max_size") })
  knowledgeIds: string[];
}
