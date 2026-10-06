import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf, ValidateNested } from "class-validator";
import { i18nValidationMessage } from "nestjs-i18n";
import { AgentCapability, AgentGender, AgentLanguage } from "entities/agent.entity";
import { IssuePriority } from "entities/issue.entity";

const languageEnumMessage = (args: any) =>
  i18nValidationMessage("validation.is_enum")({
    ...args,
    constraints: [Object.values(AgentLanguage).join(", ")],
  });

const capabilityEnumMessage = (args: any) =>
  i18nValidationMessage("validation.is_enum")({
    ...args,
    constraints: [Object.values(AgentCapability).join(", ")],
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

  @IsOptional()
  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @IsEnum(AgentCapability, { each: true, message: capabilityEnumMessage })
  capabilities?: AgentCapability[];

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  acceptImage?: boolean;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  acceptVideo?: boolean;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  acceptDocument?: boolean;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  acceptAudio?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  handoffAssignedRoleId?: string | null;

  @IsOptional()
  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @IsUUID("4", { each: true, message: i18nValidationMessage("validation.is_uuid") })
  @ArrayMaxSize(100, { message: i18nValidationMessage("validation.array_max_size") })
  handoffEmployeeIds?: string[];

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt({ message: i18nValidationMessage("validation.is_int") })
  @IsPositive({ message: i18nValidationMessage("validation.is_positive") })
  handoffEstimatedMinutes?: number | null;

  @IsOptional()
  @IsEnum(IssuePriority, { message: i18nValidationMessage("validation.is_enum") })
  handoffPriority?: IssuePriority;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  handoffStatusId?: string | null;
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

  @IsOptional()
  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @IsEnum(AgentCapability, { each: true, message: capabilityEnumMessage })
  capabilities?: AgentCapability[];

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  acceptImage?: boolean;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  acceptVideo?: boolean;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  acceptDocument?: boolean;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage("validation.is_boolean") })
  acceptAudio?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  handoffAssignedRoleId?: string | null;

  @IsOptional()
  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @IsUUID("4", { each: true, message: i18nValidationMessage("validation.is_uuid") })
  @ArrayMaxSize(100, { message: i18nValidationMessage("validation.array_max_size") })
  handoffEmployeeIds?: string[];

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt({ message: i18nValidationMessage("validation.is_int") })
  @IsPositive({ message: i18nValidationMessage("validation.is_positive") })
  handoffEstimatedMinutes?: number | null;

  @IsOptional()
  @IsEnum(IssuePriority, { message: i18nValidationMessage("validation.is_enum") })
  handoffPriority?: IssuePriority;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  handoffStatusId?: string | null;
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

export class TryMeKnowledgeDraftDto {
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(1, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(255, { message: i18nValidationMessage("validation.max_length") })
  title: string;

  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(1, { message: i18nValidationMessage("validation.min_length") })
  @MaxLength(2000, { message: i18nValidationMessage("validation.max_length") })
  content: string;
}

export class TryMeSessionDto extends CreateAgentDto {
  @IsOptional()
  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  id?: string;

  @IsOptional()
  @IsUUID("4", { message: i18nValidationMessage("validation.is_uuid") })
  customerId?: string;

  @IsOptional()
  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @ValidateNested({ each: true })
  @Type(() => TryMeKnowledgeDraftDto)
  @ArrayMaxSize(100, { message: i18nValidationMessage("validation.array_max_size") })
  knowledgeDrafts?: TryMeKnowledgeDraftDto[];
}

export class TryMeMediaDto {
  @IsIn(["image", "video", "document", "audio"])
  kind: "image" | "video" | "document" | "audio";

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MinLength(1, { message: i18nValidationMessage("validation.min_length") })
  base64?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  mimeType?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  filename?: string;
}

export class TryMeLocationDto {
  @Type(() => Number)
  @IsNumber({}, { message: i18nValidationMessage("validation.is_number") })
  latitude: number;

  @Type(() => Number)
  @IsNumber({}, { message: i18nValidationMessage("validation.is_number") })
  longitude: number;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  name?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  address?: string;
}

export class TryMeMessageDto {
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @Matches(/^[a-f0-9]{64}$/i, { message: i18nValidationMessage("validation.is_string") })
  hashId: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage("validation.is_string") })
  @MaxLength(4096, { message: i18nValidationMessage("validation.max_length") })
  text?: string;

  @IsOptional()
  @Transform(({ value }) => (value ? value : undefined))
  @IsIn(["image", "video", "document", "audio"])
  kind?: "image" | "video" | "document" | "audio";

  @IsOptional()
  @IsArray({ message: i18nValidationMessage("validation.is_array") })
  @ValidateNested({ each: true })
  @Type(() => TryMeMediaDto)
  @ArrayMaxSize(1, { message: i18nValidationMessage("validation.array_max_size") })
  media?: TryMeMediaDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => TryMeLocationDto)
  location?: TryMeLocationDto;
}
