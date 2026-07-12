import { IsString, IsNotEmpty, IsUUID, IsNumber, IsOptional, IsBoolean, IsEnum, ValidateNested, ArrayMinSize, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { i18nValidationMessage } from "nestjs-i18n";


export enum UpsellHeaderType {
    NONE = 'NONE',
    TEXT = 'TEXT',
    IMAGE = 'IMAGE',
    VIDEO = 'VIDEO',
    DOCUMENT = 'DOCUMENT'
}

export class UpsellButtonDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    text: string;
}

export class UpsellMessageConfigDto {
    @IsEnum(UpsellHeaderType,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(UpsellHeaderType).join(', ')], }); }})
    headerType: UpsellHeaderType;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    headerText?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    headerUrl?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    headerHandle?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    bodyText: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    footerText?: string;

    @ValidateNested({ each: true })
    @Type(() => UpsellButtonDto)
    @ArrayMinSize(1, {message: i18nValidationMessage('validation.array_min_size')})
    @ArrayMaxSize(3, {message: i18nValidationMessage('validation.array_max_size')})
    buttons: UpsellButtonDto[];
}

export class CreateUpsellDto {
    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    triggerProductId: string;

    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    upsellProductId: string;

    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    upsellSkuId: string;

    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    @Type(() => Number)
    upsellPrice: number;

    @IsOptional()
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @Type(() => Number)
    expireTimeM?: number;

    @ValidateNested()
    @Type(() => UpsellMessageConfigDto)
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    messageConfig: UpsellMessageConfigDto;

    @IsOptional()
    @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
    isActive?: boolean;
}

export class UpdateUpsellDto {
    @IsOptional()
    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    triggerProductId?: string;

    @IsOptional()
    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    upsellProductId?: string;

    @IsOptional()
    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    upsellSkuId?: string;

    @IsOptional()
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @Type(() => Number)
    upsellPrice?: number;

    @IsOptional()
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @Type(() => Number)
    expireTimeM?: number;

    @IsOptional()
    @ValidateNested()
    @Type(() => UpsellMessageConfigDto)
    messageConfig?: UpsellMessageConfigDto;

    @IsOptional()
    @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
    isActive?: boolean;
}
