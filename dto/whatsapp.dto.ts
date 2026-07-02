
import {
    IsArray,
    IsBoolean,
    IsEnum,
    IsIn,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    ValidateNested,
    IsUrl,
    IsNumber,
    Min,
    Max,
    ArrayMaxSize,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { TemplateCategory, TemplateSubCategory } from "entities/whatsapp.entity";



export class TemplateButtonDto {
    @IsEnum([
        "CUSTOM",
        "PHONE_NUMBER",
        "VISIT_WEBSITE",
        "WHATSAPP_CALL",
        "COPY_CODE",
    ])
    type:
        | "CUSTOM"
        | "PHONE_NUMBER"
        | "VISIT_WEBSITE"
        | "WHATSAPP_CALL"
        | "COPY_CODE";

    @IsString()
    @IsNotEmpty()
    @MaxLength(25)
    text: string;

    // URL
    @IsOptional()
    @IsUrl()
    url?: string;

    @IsOptional()
    @IsEnum(["Static", "Dynamic"])
    urlType?: "Static" | "Dynamic";

    @IsOptional()
    @IsString()
    urlExample?: string;

    // Active for days
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Max(30)
    activeForDays?: number;

    // Phone
    @IsOptional()
    @IsString()
    @MaxLength(10)
    countryCode?: string;

    @IsOptional()
    @IsString()
    @MaxLength(20)
    phoneNumber?: string;

    // COPY_CODE example
    @IsOptional()
    @IsString()
    @MaxLength(20)
    example?: string;
}


export class TemplateConfigDto {
    @IsOptional()
    @IsEnum(["TEXT", "IMAGE", "VIDEO", "DOCUMENT", "LOCATION"])
    headerType?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";

    // TEXT HEADER
    @IsOptional()
    @IsString()
    @MaxLength(60)
    headerText?: string;

    @IsOptional()
    @IsString()
    headerNamedKey?: string;

    @IsOptional()
    @IsString()
    headerExample?: string;

    // MEDIA HEADER
    @IsOptional()
    @IsString()
    headerUrl?: string;

    @IsOptional()
    @IsEnum(["positional", "named"])
    @Transform(({ value }) =>
        ["positional", "named"].includes(value) ? value : "positional",
    )
    parameterFormat?: "positional" | "named";

    // BODY
    @IsString()
    @IsOptional()
    @MaxLength(1024)
    bodyText: string;

    // FOOTER
    @IsOptional()
    @IsString()
    @MaxLength(60)
    footerText?: string;

    // VARIABLES
    @IsOptional()
    @IsObject()
    examples?: Record<string, string>;

    // BUTTONS
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(10)
    @ValidateNested({ each: true })
    @Type(() => TemplateButtonDto)
    buttons?: TemplateButtonDto[];

    @IsOptional()
    @IsString()
    uiSubcategory?: string;

    @IsOptional()
    @IsBoolean()
    useCustomValidity?: boolean;

    @IsOptional()
    @IsString()
    validityPeriod?: string;

    @IsOptional()
    @IsString()
    authMethod?: string;

    @IsOptional()
    @IsString()
    @MaxLength(25)
    otpCopyButtonText?: string;

    @IsOptional()
    @IsBoolean()
    addSecurityRecommendation?: boolean;

    @IsOptional()
    @IsBoolean()
    addExpirationTime?: boolean;

    @IsOptional()
    @IsNumber()
    @Min(1)
    @Max(90)
    expirationMinutes?: number;
}

export class CreateWhatsappTemplateDto {
    @IsUUID()
    @IsOptional()
    accountId?: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(512)
    name: string;

    @IsEnum(TemplateCategory)
    category: TemplateCategory;

    @IsEnum(TemplateSubCategory)
    subCategory: TemplateSubCategory;

    // @IsIn(["ar", "en"])
    @IsString()
    language: string;

    @ValidateNested()
    @Type(() => TemplateConfigDto)
    templateConfig: TemplateConfigDto;
}

export class UpdateWhatsappTemplateDto {

    @IsString()
    @IsOptional()
    @MaxLength(512)
    name: string;

    @IsEnum(TemplateCategory)
    @IsOptional()
    category: TemplateCategory;

    @IsEnum(TemplateSubCategory)
    @IsOptional()
    subCategory: TemplateSubCategory;

    @IsIn(["ar", "en"])
    @IsOptional()
    language: "ar" | "en";

    @ValidateNested()
    @Type(() => TemplateConfigDto)
    templateConfig: TemplateConfigDto;
}

export class CreateConversationDto {
    @IsString()
    @IsNotEmpty()
    phoneNumber: string;

    @IsString()
    @IsOptional()
    name?: string;

    @IsString()
    @IsOptional()
    email?: string;

    @IsString()
    @IsOptional()
    profilePicture?: string;

    @IsString()
    @IsOptional()
    initialMessage?: string;

    @IsString()
    @IsOptional()
    notes?: string;

    @IsUUID()
    @IsOptional()
    accountId?: string;
}

export class EmbeddedSignupDto {
    @IsString()
    @IsNotEmpty()
    code: string;

    @IsString()
    @IsNotEmpty()
    wabaId: string;

    @IsString()
    @IsNotEmpty()
    phoneNumberId: string;

    @IsString()
    @IsNotEmpty()
    businessId: string;
}

export class ManualAddAccountDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsNotEmpty()
    phoneNumber: string;

    @IsString()
    @IsNotEmpty()
    phoneNumberId: string;

    @IsString()
    @IsNotEmpty()
    businessId: string;

    @IsString()
    @IsNotEmpty()
    accessToken: string;

    @IsString()
    @IsNotEmpty()
    wabaId: string;

    @IsString()
    @IsNotEmpty()
    appId: string;

    @IsString()
    @IsNotEmpty()
    appSecret: string;
}



export class UpdateManualAccountDto {
    @IsOptional()
    @IsString()
    name?: string;

    @IsOptional()
    @IsString()
    phoneNumber?: string;

    @IsOptional()
    @IsString()
    phoneNumberId?: string;

    @IsOptional()
    @IsString()
    businessId?: string;

    @IsOptional()
    @IsString()
    accessToken?: string;

    @IsOptional()
    @IsString()
    wabaId?: string;

    @IsOptional()
    @IsString()
    appId?: string;

    @IsOptional()
    @IsString()
    appSecret?: string;
}