import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { plainToInstance, Transform, Type } from "class-transformer";
import {
  ClientSegmentStatus,
  ClientSegmentTemplateStatus,
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

function transformAudienceNode(item: any):
  | ClientAudienceRuleDto
  | ClientAudienceGroupDto {
  if (item?.field !== undefined && item?.operator !== undefined) {
    return plainToInstance(ClientAudienceRuleDto, item);
  }

  return plainToInstance(ClientAudienceGroupDto, {
    ...item,
    rules: Array.isArray(item?.rules)
      ? item.rules.map(transformAudienceNode)
      : [],
  });
}

function transformAudienceRules(value: any[]) {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.map(transformAudienceNode);
}

export class ClientAudienceGroupDto {
  @IsEnum(ClientAudienceEntity)
  entity: ClientAudienceEntity;

  @IsEnum(ConditionLogic)
  logic: ConditionLogic;

  @IsArray()
  @ValidateNested({ each: true })
  @Transform(
    ({ value }) => transformAudienceRules(value),
    { toClassOnly: true },
  )
  rules: Array<ClientAudienceRuleDto | ClientAudienceGroupDto>;
}

export class ClientAudienceFilterDto {
  @IsOptional()
  @IsEnum(ClientAudienceEntity)
  rootEntity?: ClientAudienceEntity.CLIENT;

  @IsEnum(ConditionLogic)
  logic: ConditionLogic;

  @IsEnum(ClientAudienceEntity)
  entity: ClientAudienceEntity.CLIENT;

  @IsArray()
  @ValidateNested({ each: true })
  @Transform(
    ({ value }) => transformAudienceRules(value),
    { toClassOnly: true },
  )
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
  @IsIn([ClientSegmentType.DYNAMIC, ClientSegmentType.FROZEN])
  type?: ClientSegmentType.DYNAMIC | ClientSegmentType.FROZEN;

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
  @IsIn([ClientSegmentType.DYNAMIC, ClientSegmentType.FROZEN])
  type?: ClientSegmentType.DYNAMIC | ClientSegmentType.FROZEN;
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

  @IsObject()
  @ValidateNested()
  @Type(() => ClientAudienceFilterDto)
  audienceFilter: ClientAudienceFilterDto;
}

export class UpdateClientSegmentTemplateDto extends PartialType(
  CreateClientSegmentTemplateDto,
) {
  @IsOptional()
  @IsEnum(ClientSegmentTemplateStatus)
  status?: ClientSegmentTemplateStatus;
}
