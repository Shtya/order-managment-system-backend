import {
  IsArray,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import {
  ClientSegmentStatus,
  ClientSegmentType,
} from "entities/clients-segments.entity";
import {
  ClientAudienceEntity,
} from "common/client-audience-filter.types";
import { ConditionLogic, ConditionOperator } from "common/condition.types";
import { PartialType } from "@nestjs/mapped-types";

// ──────────────────────────────────────────────────────────────
// Shared filter DTOs
// ──────────────────────────────────────────────────────────────

export class ClientAudienceRuleDto {
  @IsString()
  field: string;

  @IsEnum(ConditionOperator)
  operator: ConditionOperator;

  @IsOptional()
  value?: any;
}

export class ClientAudienceGroupDto {
  @IsEnum(ClientAudienceEntity)
  entity: ClientAudienceEntity;

  @IsEnum(ConditionLogic)
  logic: ConditionLogic;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => Object)
  rules: Array<ClientAudienceRuleDto | ClientAudienceGroupDto>;
}

export class ClientAudienceFilterDto extends ClientAudienceGroupDto {
  @IsOptional()
  @IsEnum(ClientAudienceEntity)
  rootEntity?: ClientAudienceEntity.CLIENT;

  @IsEnum(ConditionLogic)
  logic: ConditionLogic;

  @IsEnum(ClientAudienceEntity)
  entity: ClientAudienceEntity.CLIENT;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => Object)
  rules: Array<ClientAudienceRuleDto | ClientAudienceGroupDto>;
}

// ──────────────────────────────────────────────────────────────
// Segment DTOs
// ──────────────────────────────────────────────────────────────

export class CreateClientSegmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsEnum(ClientSegmentType)
  type?: ClientSegmentType;

  @IsObject()
  @ValidateNested()
  @Type(() => ClientAudienceFilterDto)
  audienceFilter: ClientAudienceFilterDto;
}

export class UpdateClientSegmentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsEnum(ClientSegmentStatus)
  status?: ClientSegmentStatus;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ClientAudienceFilterDto)
  audienceFilter?: ClientAudienceFilterDto;
}

export class PreviewClientSegmentAudienceDto {
  @IsObject()
  @ValidateNested()
  @Type(() => ClientAudienceFilterDto)
  audienceFilter: ClientAudienceFilterDto;
}

export class CreateSegmentFromTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsEnum(ClientSegmentType)
  type?: ClientSegmentType;
}

// ──────────────────────────────────────────────────────────────
// Template DTOs (super-admin)
// ──────────────────────────────────────────────────────────────

export class CreateClientSegmentTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsEnum(ClientSegmentType)
  defaultType?: ClientSegmentType;

  @IsObject()
  @ValidateNested()
  @Type(() => ClientAudienceFilterDto)
  audienceFilter: ClientAudienceFilterDto;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateClientSegmentTemplateDto  extends PartialType(CreateClientSegmentTemplateDto) {}
