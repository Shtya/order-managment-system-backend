import { IsString, IsNotEmpty, IsUUID, IsNumber, IsOptional, IsBoolean, IsEnum, ValidateNested, ArrayMinSize, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';

export enum UpsellHeaderType {
    NONE = 'NONE',
    TEXT = 'TEXT',
    IMAGE = 'IMAGE',
    VIDEO = 'VIDEO',
    DOCUMENT = 'DOCUMENT'
}

export class UpsellButtonDto {
    @IsString()
    @IsNotEmpty()
    text: string;
}

export class UpsellMessageConfigDto {
    @IsEnum(UpsellHeaderType)
    headerType: UpsellHeaderType;

    @IsOptional()
    @IsString()
    headerText?: string;

    @IsOptional()
    @IsString()
    headerUrl?: string;

    @IsOptional()
    @IsString()
    headerHandle?: string;

    @IsString()
    @IsNotEmpty()
    bodyText: string;

    @IsOptional()
    @IsString()
    footerText?: string;

    @ValidateNested({ each: true })
    @Type(() => UpsellButtonDto)
    @ArrayMinSize(1)
    @ArrayMaxSize(3)
    buttons: UpsellButtonDto[];
}

export class CreateUpsellDto {
    @IsUUID()
    @IsNotEmpty()
    triggerProductId: string;

    @IsUUID()
    @IsNotEmpty()
    upsellProductId: string;

    @IsUUID()
    @IsNotEmpty()
    upsellSkuId: string;

    @IsNumber()
    @IsNotEmpty()
    @Type(() => Number)
    upsellPrice: number;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    expireTimeM?: number;

    @ValidateNested()
    @Type(() => UpsellMessageConfigDto)
    @IsNotEmpty()
    messageConfig: UpsellMessageConfigDto;

    @IsOptional()
    @IsBoolean()
    isActive?: boolean;
}

export class UpdateUpsellDto {
    @IsOptional()
    @IsUUID()
    triggerProductId?: string;

    @IsOptional()
    @IsUUID()
    upsellProductId?: string;

    @IsOptional()
    @IsUUID()
    upsellSkuId?: string;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    upsellPrice?: number;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    timeMs?: number;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    expireTimeM?: number;

    @IsOptional()
    @ValidateNested()
    @Type(() => UpsellMessageConfigDto)
    messageConfig?: UpsellMessageConfigDto;

    @IsOptional()
    @IsBoolean()
    isActive?: boolean;
}
