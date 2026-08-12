import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import {
  GettingStartedAchievementType,
  GettingStartedEventType,
  GettingStartedTargetType,
} from "entities/getting-started.entity";

// ---------- Request DTOs ----------

export class CreateEventDto {
  @IsUUID()
  @IsNotEmpty()
  itemId: string;

  @IsUUID()
  @IsOptional()
  stepId?: string;

  @IsString()
  @IsOptional()
  stepKey?: string;

  @IsEnum(GettingStartedEventType)
  type: GettingStartedEventType;
}

export class ProcessAchievementJobDto {
  @IsUUID()
  @IsNotEmpty()
  adminId: string;

  @IsEnum(GettingStartedAchievementType)
  type: GettingStartedAchievementType;
}

// ---------- Response DTOs ----------

export class StepResponseDto {
  @IsUUID()
  id: string;

  @IsString()
  key: string;

  @IsObject()
  title: {
    ar: string;
    en: string;
  };

  @IsObject()
  description: {
    ar: string;
    en: string;
  };

  @IsObject()
  target: {
    type: GettingStartedTargetType;
    page: string;
    key: string;
  };

  @IsObject()
  @IsOptional()
  actionConfig?: Record<string, any>;

  @IsInt()
  sortOrder: number;
}

export class ItemResponseDto {
  @IsUUID()
  id: string;

  @IsString()
  key: string;

  @IsObject()
  title: {
    ar: string;
    en: string;
  };

  @IsObject()
  @IsOptional()
  description?: {
    ar: string;
    en: string;
  };

  @IsEnum(GettingStartedAchievementType)
  completionType: GettingStartedAchievementType;

  @IsArray()
  @IsString({ each: true })
  dependsOn: string[];

  @IsInt()
  sortOrder: number;

  @IsBoolean()
  isActive: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StepResponseDto)
  steps: StepResponseDto[];

  @IsBoolean()
  completed: boolean;

  @IsBoolean()
  available: boolean;
}

export class StatusResponseDto {
  [key: string]: boolean;
}

export class ProgressResponseDto {
  @IsInt()
  total: number;

  @IsInt()
  completed: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  percentage: number;
}

// ---------- Super Admin Statistics DTOs ----------

export class AdminOverviewStatsDto {
  @IsInt()
  totalAdmins: number;

  @IsInt()
  startedCount: number;

  @IsInt()
  completedCount: number;

  @IsInt()
  neverStartedCount: number;

  @IsNumber()
  overallCompletionPercentage: number;

  @IsNumber()
  @IsOptional()
  averageDaysToComplete: number | null;
}

export class AdminItemStatsDto {
  @IsUUID()
  id: string;

  @IsString()
  key: string;

  @IsObject()
  title: {
    ar: string;
    en: string;
  };

  @IsEnum(GettingStartedAchievementType)
  completionType: GettingStartedAchievementType;

  @IsInt()
  totalAdmins: number;

  @IsInt()
  completedCount: number;

  @IsInt()
  notCompletedCount: number;

  @IsNumber()
  completionPercent: number;

  @IsInt()
  startedPathCount: number;

  @IsInt()
  finishedPathCount: number;

  @IsInt()
  skippedCount: number;

  @IsInt()
  abandonedCount: number;

  @IsNumber()
  @IsOptional()
  averageDaysToComplete: number | null;
}

export class AdminStepStatsDto {
  @IsUUID()
  id: string;

  @IsString()
  key: string;

  @IsObject()
  title: {
    ar: string;
    en: string;
  };

  @IsUUID()
  itemId: string;

  @IsString()
  itemKey: string;

  @IsObject()
  itemTitle: {
    ar: string;
    en: string;
  };

  @IsInt()
  totalViews: number;

  @IsInt()
  uniqueViewers: number;

  @IsInt()
  dropOffCount: number;

  @IsNumber()
  dropOffPercent: number;
}
