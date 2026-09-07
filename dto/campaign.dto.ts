import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { plainToInstance, Transform, Type } from "class-transformer";
import {
  CampaignAudienceType,
  CampaignCategory,
  CampaignChannel,
  CampaignExclusionType,
  CampaignScheduleMode,
} from "entities/campaigns.entity";
import { ClientAudienceFilterDto } from "dto/client-segment.dto";

/** Nested filter trees must not use enableImplicitConversion — it turns rule objects into []. */
export function toCampaignAudienceFilterDto(value: any) {
  if (value == null) return value;
  return plainToInstance(ClientAudienceFilterDto, value, {
    enableImplicitConversion: false,
  });
}

// ──────────────────────────────────────────────────────────────
// Channel-specific message data.
// Mirrors frontend TemplateMessageModal.jsx + backend
// WhatsappService.sendTemplate() input shape.
// SMS/Email reserve their own config here so core never branches
// with `if (channel === ...)` outside validation/registry.
// ──────────────────────────────────────────────────────────────

export class CampaignWhatsappVariableDto {
  @IsString()
  type: string;

  @IsString()
  value: string;

  @IsOptional()
  @IsString()
  example?: string;
}

export class CampaignWhatsappConfigDto {
  @IsUUID()
  templateId: string;

  @IsUUID()
  accountId: string;

  // Snapshot of WhatsappTemplateEntity.templateConfig subset used at send
  // time so later template edits do not change a launched campaign.
  // Built from TemplateMessageModal state: templateData, headerUrl,
  // headerVariables, bodyVariables, buttonVariables, locationData.
  @IsObject()
  templateData: Record<string, any>;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  headerUrl?: string;

  @IsOptional()
  @IsBoolean()
  useOrderFirstItemImage?: boolean;

  @IsOptional()
  @IsObject()
  headerVariables?: Record<string, CampaignWhatsappVariableDto>;

  @IsOptional()
  @IsObject()
  bodyVariables?: Record<string, CampaignWhatsappVariableDto>;

  @IsOptional()
  @IsObject()
  buttonVariables?: Record<string, CampaignWhatsappVariableDto>;

  @IsOptional()
  @IsObject()
  locationData?: Record<string, any>;
}

export class CampaignSmsConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(1600)
  body?: string;
}

export class CampaignEmailConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @IsOptional()
  @IsString()
  body?: string;
}

// ──────────────────────────────────────────────────────────────
// Audience / products / exclusions
// ──────────────────────────────────────────────────────────────

export class CampaignManualRecipientDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  phoneNumber: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

export class CampaignProductDto {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  image?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class CampaignExclusionDto {
  @IsEnum(CampaignExclusionType)
  type: CampaignExclusionType;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

// ──────────────────────────────────────────────────────────────
// Create / Update
// ──────────────────────────────────────────────────────────────

export class CreateCampaignDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  // When true, runs start() inline after a successful create
  // (now or scheduled, per scheduleMode/scheduledAt).
  @IsOptional()
  @IsBoolean()
  autoStart?: boolean;

  @IsOptional()
  @IsEnum(CampaignCategory)
  category?: CampaignCategory;

  @IsOptional()
  @IsEnum(CampaignChannel)
  channel?: CampaignChannel;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  shippingPrice?: number;

  @IsOptional()
  @IsBoolean()
  enablePurchasePage?: boolean;

  @IsEnum(CampaignAudienceType)
  audienceType: CampaignAudienceType;

  @IsOptional()
  @IsUUID()
  audienceSegmentId?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Transform(({ value }) => toCampaignAudienceFilterDto(value))
  audienceFilter?: ClientAudienceFilterDto;

  // Duplicate flow only: reference to a stored audience file owned by the
  // same admin. Honored only together with duplicateAudienceFile; the
  // backend copies it to a fresh path instead of reusing the URL.
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  audienceFileUrl?: string;

  @IsOptional()
  @IsBoolean()
  duplicateAudienceFile?: boolean;

  // audienceType=manual input. Normalized + deduped into
  // campaigns.audienceManualSnapshot at create/update; consumed once
  // at start/materialize (next step).
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CampaignManualRecipientDto)
  manualRecipients?: CampaignManualRecipientDto[];

  // ── Channel-specific data (polymorphic, one per channel) ──
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignWhatsappConfigDto)
  whatsapp?: CampaignWhatsappConfigDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignSmsConfigDto)
  sms?: CampaignSmsConfigDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignEmailConfigDto)
  email?: CampaignEmailConfigDto;

  @IsOptional()
  @IsEnum(CampaignScheduleMode)
  scheduleMode?: CampaignScheduleMode;

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: "workingHoursStart must be HH:MM",
  })
  workingHoursStart?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: "workingHoursEnd must be HH:MM",
  })
  workingHoursEnd?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  workingHoursTimezone?: string;

  @IsOptional()
  @IsInt()
  @Min(4)
  delayMinSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(4)
  delayMaxSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxMessagesPerHour?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CampaignProductDto)
  products?: CampaignProductDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CampaignExclusionDto)
  excludedRecipients?: CampaignExclusionDto[];

  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  orphanFileIds?: string[];
}

export class StartCampaignDto {
  @IsOptional()
  @IsBoolean()
  startNow?: boolean;
}

export class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsEnum(CampaignCategory)
  category?: CampaignCategory;

  @IsOptional()
  @IsEnum(CampaignChannel)
  channel?: CampaignChannel;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  shippingPrice?: number;

  @IsOptional()
  @IsBoolean()
  enablePurchasePage?: boolean;

  @IsOptional()
  @IsEnum(CampaignAudienceType)
  audienceType?: CampaignAudienceType;

  @IsOptional()
  @IsUUID()
  audienceSegmentId?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Transform(({ value }) => toCampaignAudienceFilterDto(value))
  audienceFilter?: ClientAudienceFilterDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CampaignManualRecipientDto)
  manualRecipients?: CampaignManualRecipientDto[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignWhatsappConfigDto)
  whatsapp?: CampaignWhatsappConfigDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignSmsConfigDto)
  sms?: CampaignSmsConfigDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignEmailConfigDto)
  email?: CampaignEmailConfigDto;

  @IsOptional()
  @IsEnum(CampaignScheduleMode)
  scheduleMode?: CampaignScheduleMode;

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: "workingHoursStart must be HH:MM",
  })
  workingHoursStart?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: "workingHoursEnd must be HH:MM",
  })
  workingHoursEnd?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  workingHoursTimezone?: string;

  @IsOptional()
  @IsInt()
  @Min(4)
  delayMinSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(4)
  delayMaxSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxMessagesPerHour?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CampaignProductDto)
  products?: CampaignProductDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CampaignExclusionDto)
  excludedRecipients?: CampaignExclusionDto[];

  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  orphanFileIds?: string[];
}
