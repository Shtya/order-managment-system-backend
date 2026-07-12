import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsObject, IsOptional, IsString, Min, ValidateNested } from "class-validator";
import { AssignmentMode, AutomationMigrationStrategy, Language, NotificationSettings, OrderFlowPath, StockDeductionStrategy, TimeUnit } from "entities/clientSettings.entity";
import { i18nValidationMessage } from "nestjs-i18n";

export class ShippingSettingsDto {

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  shippingCompanyId?: string;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  triggerStatus?: string;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  notifyOnShipment?: boolean;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  autoGenerateLabel?: boolean;

  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  @IsOptional()
  partialPaymentThreshold?: number;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  requireFullPayment?: boolean;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  autoShipAfterWarehouse?: boolean;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  warehouseDefaultShippingCompanyId?: string;
}

export class UpsertClientSettingsDto {
  @IsEnum(AssignmentMode,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(AssignmentMode).join(', ')], }); }})
  @IsOptional()
  assignmentMode?: AssignmentMode;

  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @Min(1, {message: i18nValidationMessage('validation.min')})
  @IsOptional()
  assignmentDelay?: number;

  @IsEnum(TimeUnit,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(TimeUnit).join(', ')], }); }})
  @IsOptional()
  assignmentDelayUnit?: TimeUnit;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  enabled?: boolean;

  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  @IsOptional()
  maxRetries?: number;

  @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
  @IsOptional()
  retryInterval?: number;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  autoMoveStatus?: string;

  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @IsString({ each: true })
  @IsOptional()
  retryStatuses?: string[];

  @IsArray({message: i18nValidationMessage('validation.is_array')})
  @IsString({ each: true })
  @IsOptional()
  confirmationStatuses?: string[];

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  notifyEmployee?: boolean;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  notifyAdmin?: boolean;

  @IsObject({message: i18nValidationMessage('validation.is_object')})
  @IsOptional()
  notificationSettings?: Partial<NotificationSettings>;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  notifyLowStock?: boolean;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  notifyMarketing?: boolean;

  @IsEnum(StockDeductionStrategy,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(StockDeductionStrategy).join(', ')], }); }})
  @IsOptional()
  stockDeductionStrategy?: StockDeductionStrategy;

  @IsEnum(OrderFlowPath,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(OrderFlowPath).join(', ')], }); }})
  @IsOptional()
  orderFlowPath?: OrderFlowPath;

  @IsEnum(Language,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(Language).join(', ')], }); }})
  @IsOptional()
  defaultLang?: Language;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  storeOrderSkuFallback?: boolean;

  @IsObject({message: i18nValidationMessage('validation.is_object')})
  @IsOptional()
  workingHours?: {
    enabled: boolean;
    start: string;
    end: string;
  };

  @IsOptional()
  @ValidateNested()
  @Type(() => ShippingSettingsDto)
  shipping?: ShippingSettingsDto;

  @IsEnum(AutomationMigrationStrategy,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(AutomationMigrationStrategy).join(', ')], }); }})
  @IsOptional()
  automationMigrationStrategy?: AutomationMigrationStrategy;

  @IsString({message: i18nValidationMessage('validation.is_string')})
  @IsOptional()
  defaultWhatsAppAccountId?: string;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  reservedEnabled?: boolean;

  @IsInt({message: i18nValidationMessage('validation.is_int')})
  @IsOptional()
  duplicateWindowHours?: number;

  @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
  @IsOptional()
  autoCancelDuplicates?: boolean;
}
