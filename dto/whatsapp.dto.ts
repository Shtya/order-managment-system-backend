
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
import { i18nValidationMessage } from "nestjs-i18n";




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

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    @MaxLength(25, { message: i18nValidationMessage('validation.max_length') })
    text: string;

    // URL
    @IsOptional()
    @IsUrl({}, {message: i18nValidationMessage('validation.is_url')})
    url?: string;

    @IsOptional()
    @IsEnum(["Static", "Dynamic"],{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(["Static", "Dynamic"]).join(', ')], }); }})
    urlType?: "Static" | "Dynamic";

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    urlExample?: string;

    // Active for days
    @IsOptional()
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @Min(1, {message: i18nValidationMessage('validation.min')})
    @Max(30, {message: i18nValidationMessage('validation.max')})
    activeForDays?: number;

    // Phone
    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @MaxLength(10, { message: i18nValidationMessage('validation.max_length') })
    countryCode?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @MaxLength(20, { message: i18nValidationMessage('validation.max_length') })
    phoneNumber?: string;

    // COPY_CODE example
    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @MaxLength(20, { message: i18nValidationMessage('validation.max_length') })
    example?: string;
}


export class TemplateConfigDto {
    @IsOptional()
    @IsEnum(["TEXT", "IMAGE", "VIDEO", "DOCUMENT", "LOCATION"],{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(["TEXT", "IMAGE", "VIDEO", "DOCUMENT", "LOCATION"]).join(', ')], }); }})
    headerType?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";

    // TEXT HEADER
    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @MaxLength(60, { message: i18nValidationMessage('validation.max_length') })
    headerText?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    headerNamedKey?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    headerExample?: string;

    // MEDIA HEADER
    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    headerUrl?: string;

    @IsOptional()
    @IsEnum(["positional", "named"],{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(["positional", "named"]).join(', ')], }); }})
    @Transform(({ value }) =>
        ["positional", "named"].includes(value) ? value : "positional",
    )
    parameterFormat?: "positional" | "named";

    // BODY
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    @MaxLength(1024, { message: i18nValidationMessage('validation.max_length') })
    bodyText: string;

    // FOOTER
    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @MaxLength(60, { message: i18nValidationMessage('validation.max_length') })
    footerText?: string;

    // VARIABLES
    @IsOptional()
    @IsObject({message: i18nValidationMessage('validation.is_object')})
    examples?: Record<string, string>;

    // BUTTONS
    @IsOptional()
    @IsArray({message: i18nValidationMessage('validation.is_array')})
    @ArrayMaxSize(10, {message: i18nValidationMessage('validation.array_max_size')})
    @ValidateNested({ each: true })
    @Type(() => TemplateButtonDto)
    buttons?: TemplateButtonDto[];

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    uiSubcategory?: string;

    @IsOptional()
    @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
    useCustomValidity?: boolean;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    validityPeriod?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    authMethod?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @MaxLength(25, { message: i18nValidationMessage('validation.max_length') })
    otpCopyButtonText?: string;

    @IsOptional()
    @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
    addSecurityRecommendation?: boolean;

    @IsOptional()
    @IsBoolean({message: i18nValidationMessage('validation.is_boolean')})
    addExpirationTime?: boolean;

    @IsOptional()
    @IsNumber({}, {message: i18nValidationMessage('validation.is_number')})
    @Min(1, {message: i18nValidationMessage('validation.min')})
    @Max(90, {message: i18nValidationMessage('validation.max')})
    expirationMinutes?: number;
}

export class CreateWhatsappTemplateDto {
    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    @IsOptional()
    accountId?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    @MaxLength(512, { message: i18nValidationMessage('validation.max_length') })
    name: string;

    @IsEnum(TemplateCategory,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(TemplateCategory).join(', ')], }); }})
    category: TemplateCategory;

    @IsEnum(TemplateSubCategory,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(TemplateSubCategory).join(', ')], }); }})
    subCategory: TemplateSubCategory;

    // @IsIn(["ar", "en"])
    @IsString({message: i18nValidationMessage('validation.is_string')})
    language: string;

    @ValidateNested()
    @Type(() => TemplateConfigDto)
    templateConfig: TemplateConfigDto;
}

export class UpdateWhatsappTemplateDto {

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    @MaxLength(512, { message: i18nValidationMessage('validation.max_length') })
    name: string;

    @IsEnum(TemplateCategory,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(TemplateCategory).join(', ')], }); }})
    @IsOptional()
    category: TemplateCategory;

    @IsEnum(TemplateSubCategory,{ message: (args) => { return i18nValidationMessage('validation.is_enum')({...args, constraints: [Object.values(TemplateSubCategory).join(', ')], }); }})
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
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    phoneNumber: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    name?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    email?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    profilePicture?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    initialMessage?: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsOptional()
    notes?: string;

    @IsUUID('4', {message: i18nValidationMessage('validation.is_uuid')})
    @IsOptional()
    accountId?: string;
}

export class EmbeddedSignupDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    code: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    wabaId: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    phoneNumberId: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    businessId: string;
}

export class ManualAddAccountDto {
    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    name: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    phoneNumber: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    phoneNumberId: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    businessId: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    accessToken: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    wabaId: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    appId: string;

    @IsString({message: i18nValidationMessage('validation.is_string')})
    @IsNotEmpty({message: i18nValidationMessage('validation.is_not_empty')})
    appSecret: string;
}



export class UpdateManualAccountDto {
    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    name?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    phoneNumber?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    phoneNumberId?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    businessId?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    accessToken?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    wabaId?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    appId?: string;

    @IsOptional()
    @IsString({message: i18nValidationMessage('validation.is_string')})
    appSecret?: string;
}