import { Type } from 'class-transformer';
import {
	IsArray,
	IsBoolean,
	IsDate,
	IsEnum,
	IsIn,
	IsInt,
	IsNotEmpty,
	IsNumber,
	IsObject,
	IsOptional,
	IsString,
	IsUUID,
	MaxLength,
	Min,
	ValidateNested,
} from 'class-validator';
import { i18nValidationMessage } from 'nestjs-i18n';
import {
	AiAuthType,
	AiEntityScope,
	AiIntegrationScope,
	AiModelTier,
	AiModelType,
	AiProviderProtocol,
	AiRequestSummaryStatus,
	AiWriteToolCallStatus,
} from '../entities/ai.entity';
import { AiProviderCredentials } from '../src/ai/interfaces/ai-types';

// ──────────────────────────── DEFAULT MODEL ────────────────────────────

export class SetDefaultModelDto {
	@IsNotEmpty()
	@IsUUID()
	modelId: string;
}

export class DefaultModelResponseDto {
	id: string;
	adminId?: string | null;
	modelId: string;
	isActive: boolean;
	model?: ModelResponseDto;
	provider?: ProviderResponseDto;
	created_at: Date;
	updated_at: Date;
}

// ──────────────────────────── PAGINATION ────────────────────────────

export class PaginationQueryDto {
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	page?: number = 1;

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	limit?: number = 25;

	@IsOptional()
	@IsString()
	search?: string;

	@IsOptional()
	@IsString()
	sortBy?: string;

	@IsOptional()
	@IsIn(['ASC', 'DESC'])
	sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

export class PaginationMetaDto {
	total: number;
	totalPages: number;
	currentPage: number;
	limit: number;

	constructor(total: number, page: number, limit: number) {
		this.total = total;
		this.currentPage = page;
		this.limit = limit;
		this.totalPages = Math.ceil(total / limit);
	}
}

export class PaginatedResponseDto<T> {
	data: T[];
	meta: PaginationMetaDto;

	constructor(data: T[], total: number, page: number, limit: number) {
		this.data = data;
		this.meta = new PaginationMetaDto(total, page, limit);
	}
}

// ──────────────────────────── PROVIDERS ────────────────────────────

export class ListProvidersQueryDto extends PaginationQueryDto {
	@IsOptional()
	@IsEnum({ ...AiEntityScope, ALL: 'all' })
	scope?: AiEntityScope | "all";

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@IsString()
	code?: string;
}

export class CreateProviderDto {
	@IsNotEmpty({ message: i18nValidationMessage('validation.required') })
	@IsString({ message: i18nValidationMessage('validation.is_string') })
	@MaxLength(150)
	name: string;

	@IsNotEmpty({ message: i18nValidationMessage('validation.required') })
	@IsString({ message: i18nValidationMessage('validation.is_string') })
	@MaxLength(100)
	code: string;

	@IsOptional()
	@IsString()
	website?: string;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	isActive?: boolean = true;

	@IsOptional()
	@IsString()
	description?: string;

	@IsOptional()
	@IsString()
	descriptionAr?: string;

	@IsOptional()
	@IsEnum(AiProviderProtocol)
	protocol?: AiProviderProtocol;

	@IsOptional()
	@IsEnum(AiAuthType)
	authType?: AiAuthType;

	@IsOptional()
	@IsString()
	baseUrl?: string;

	@IsObject()
	@Type(() => AiProviderCredentials)
	@ValidateNested()
	credentials: AiProviderCredentials;
}

export class UpdateProviderDto {
	@IsOptional()
	@IsString()
	@MaxLength(150)
	name?: string;

	@IsOptional()
	@IsString()
	@MaxLength(100)
	code?: string;

	@IsOptional()
	@IsString()
	website?: string;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@IsString()
	description?: string;

	@IsOptional()
	@IsString()
	descriptionAr?: string;

	@IsOptional()
	@IsEnum(AiProviderProtocol)
	protocol?: AiProviderProtocol;

	@IsOptional()
	@IsEnum(AiAuthType)
	authType?: AiAuthType;

	@IsOptional()
	@IsString()
	baseUrl?: string;

	@IsOptional()
	@IsObject()
	@Type(() => AiProviderCredentials)
	@ValidateNested()
	credentials?: AiProviderCredentials;
}

export class AiProviderModelSummaryDto {
	id: string;
	modelCode: string;
}

export class ProviderResponseDto {
	id: string;
	code?: string;
	name: string;
	scope: AiEntityScope;
	website?: string;
	logoUrl?: string;
	tenantIntegrationAllowed: boolean;
	isActive: boolean;
	description?: string;
	descriptionAr?: string;
	protocol?: AiProviderProtocol;
	adminId?: string;
	models?: AiProviderModelSummaryDto[];
	integration?: { id: string; baseUrl?: string; credentials?: Record<string, any>; adminId?: string };
	created_at: Date;
	updated_at: Date;
}

export class CreateProviderWithModelsDto extends CreateProviderDto {
	@IsOptional()
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => CreateModelDto)
	models?: CreateModelDto[];
}

export class SyncProviderModelsDto {
	@IsNotEmpty()
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => SyncModelItemDto)
	models: SyncModelItemDto[];
}

export class SyncModelItemDto {
	@IsNotEmpty()
	@IsString()
	@MaxLength(255)
	modelId: string;

	@IsNotEmpty()
	@IsString()
	@MaxLength(255)
	name: string;

	@IsOptional()
	@IsEnum(AiModelType)
	modelType?: AiModelType;

	@IsOptional()
	@IsEnum(AiModelTier)
	tier?: AiModelTier;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	stream?: boolean;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	jsonMode?: boolean;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	reasoning?: boolean;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	toolsCalling?: boolean;

	@IsOptional()
	@IsObject()
	modalities?: Record<string, any>;

	@IsOptional()
	@IsObject()
	contextWindow?: Record<string, any>;
}

export class ProviderSyncResponseDto {
	created: number;
	updated: number;
	total: number;
}

// ──────────────────────────── MODELS ────────────────────────────

export class ListModelsQueryDto {
	@IsOptional()
	@IsUUID()
	providerId?: string;

	@IsOptional()
	@IsString()
	providerCode?: string;

	@IsOptional()
	@IsEnum(AiModelType)
	modelType?: AiModelType;

	@IsOptional()
	@IsEnum(AiModelTier)
	tier?: AiModelTier;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@IsEnum({ ...AiEntityScope, ALL: 'all' })
	scope?: AiEntityScope | "all";

	@IsOptional()
	@IsString()
	search?: string;

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	limit?: number = 50;

	@IsOptional()
	@IsIn(['ASC', 'DESC'])
	sortDir?: 'ASC' | 'DESC' = 'DESC';

	@IsOptional()
	@IsObject()
	cursor?: { value: any; id: string };
}

export class CreateModelDto {
	@IsNotEmpty()
	@IsUUID()
	providerId: string;

	@IsNotEmpty()
	@IsString()
	@MaxLength(255)
	modelCode: string;

	@IsNotEmpty()
	@IsString()
	@MaxLength(255)
	name: string;

	@IsOptional()
	@IsString()
	description?: string;

	@IsOptional()
	@IsString()
	descriptionAr?: string;

	@IsOptional()
	@IsEnum(AiModelType)
	modelType?: AiModelType = AiModelType.TEXT;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	isActive?: boolean = true;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	stream?: boolean;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	jsonMode?: boolean;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	reasoning?: boolean;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	toolsCalling?: boolean;

	@IsOptional()
	@IsObject()
	modalities?: Record<string, any>;

	@IsOptional()
	@IsObject()
	contextWindow?: Record<string, any>;
}

export class UpdateModelDto {
	@IsOptional()
	@IsString()
	@MaxLength(255)
	name?: string;

	@IsOptional()
	@IsString()
	@MaxLength(255)
	modelCode?: string;

	@IsOptional()
	@IsString()
	description?: string;

	@IsOptional()
	@IsString()
	descriptionAr?: string;

	@IsOptional()
	@IsEnum(AiModelType)
	modelType?: AiModelType;

	@IsOptional()
	@IsEnum(AiModelTier)
	tier?: AiModelTier;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	stream?: boolean;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	jsonMode?: boolean;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	reasoning?: boolean;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	toolsCalling?: boolean;

	@IsOptional()
	@IsObject()
	modalities?: Record<string, any>;

	@IsOptional()
	@IsObject()
	contextWindow?: Record<string, any>;
}

export class ModelResponseDto {
	id: string;
	providerId: string;
	adminId?: string;
	scope: AiEntityScope;
	modelCode: string;
	name: string;
	description?: string;
	descriptionAr?: string;
	modelType: AiModelType;
	tier?: AiModelTier;
	isActive: boolean;
	stream?: boolean;
	jsonMode?: boolean;
	reasoning?: boolean;
	toolsCalling?: boolean;
	modalities?: Record<string, any>;
	contextWindow?: Record<string, any>;
	provider?: ProviderResponseDto;
	
	created_t: Date;
	updated_at: Date;
}

// ──────────────────────────── INTEGRATIONS ────────────────────────────

export class ListIntegrationsQueryDto {
	@IsOptional()
	@IsUUID()
	providerId?: string;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@IsEnum(AiIntegrationScope)
	scope?: AiIntegrationScope;

	@IsOptional()
	@IsString()
	search?: string;

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	limit?: number = 50;

	@IsOptional()
	@IsIn(['ASC', 'DESC'])
	sortDir?: 'ASC' | 'DESC' = 'DESC';

	@IsOptional()
	@IsObject()
	cursor?: { value: any; id: string };
}

export class CreateIntegrationDto {
	@IsOptional()
	@IsUUID()
	providerId?: string;

	@IsOptional()
	@IsEnum(AiIntegrationScope)
	scope?: AiIntegrationScope;

	@IsOptional()
	@IsObject()
	@Type(() => AiProviderCredentials)
	@ValidateNested()
	credentials?: AiProviderCredentials;

	@IsOptional()
	@IsString()
	baseUrl?: string;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	isActive?: boolean = true;

	@IsOptional()
	@IsArray()
	@IsUUID('4', { each: true })
	modelIds?: string[];
}

export class UpdateIntegrationDto {
	@IsOptional()
	@IsString()
	baseUrl?: string;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	isActive?: boolean;
}

export class IntegrationResponseDto {
	id: string;
	adminId?: string;
	providerId: string;
	scope: AiIntegrationScope;
	authType: AiAuthType;
	baseUrl?: string;
	credentials?: Record<string, any>;
	lastValidatedAt?: Date;
	lastError?: string;
	provider?: ProviderResponseDto;
	models?: ModelResponseDto[];
	created_t: Date;
	updated_ut: Date;
}

export class AttachModelsToIntegrationDto {
	@IsNotEmpty()
	@IsArray()
	@IsUUID('4', { each: true })
	modelIds: string[];
}

export class SetCredentialsDto {
	@IsNotEmpty()
	@IsObject()
	@Type(() => AiProviderCredentials)
	@ValidateNested()
	credentials: AiProviderCredentials;

	@IsOptional()
	@IsString()
	baseUrl?: string;
}


// ──────────────────────────── AUDIT: REQUEST SUMMARIES ────────────────────────────

export class ListRequestSummariesQueryDto extends PaginationQueryDto {
	@IsOptional()
	@IsUUID()
	sessionId?: string;

	@IsOptional()
	@IsUUID()
	conversationId?: string;

	@IsOptional()
	@IsUUID()
	providerId?: string;

	@IsOptional()
	@IsUUID()
	modelId?: string;

	@IsOptional()
	@IsEnum(AiRequestSummaryStatus)
	status?: AiRequestSummaryStatus;

	@IsOptional()
	@IsString()
	startDate?: string;

	@IsOptional()
	@IsString()
	endDate?: string;

	@IsOptional()
	@IsUUID()
	adminId?: string;
}

export class RequestSummaryResponseDto {
	id: string;
	adminId?: string;
	sessionId: string;
	conversationId?: string;
	requestId: string;
	providerId?: string;
	modelId?: string;
	status: AiRequestSummaryStatus;
	usagePromptTokens: number;
	usageCompletionTokens: number;
	usageTotalTokens: number;
	rounds: number;
	durationMs?: number;
	errorCode?: string;
	error?: string;
	summary?: any;
	progress?: any;
	providersUsed?: string[];
	provider?: ProviderResponseDto;
	model?: ModelResponseDto;
	createdAt: Date;
	updatedAt: Date;
}

// ──────────────────────────── AUDIT: WRITE TOOL CALLS ────────────────────────────

export class ListWriteToolCallsQueryDto extends PaginationQueryDto {
	@IsOptional()
	@IsUUID()
	sessionId?: string;

	@IsOptional()
	@IsUUID()
	providerId?: string;

	@IsOptional()
	@IsUUID()
	modelId?: string;

	@IsOptional()
	@IsString()
	toolName?: string;

	@IsOptional()
	@IsEnum(AiWriteToolCallStatus)
	status?: AiWriteToolCallStatus;

	@IsOptional()
	@IsString()
	startDate?: string;

	@IsOptional()
	@IsString()
	endDate?: string;

	@IsOptional()
	@IsUUID()
	adminId?: string;
}

export class WriteToolCallResponseDto {
	id: string;
	adminId?: string;
	sessionId: string;
	requestId?: string;
	providerId?: string;
	modelId?: string;
	toolName: string;
	dedupKey: string;
	toolCallId?: string;
	argsHash: string;
	args: any;
	status: AiWriteToolCallStatus;
	result?: any;
	error?: string;
	completedAt?: Date;
	provider?: ProviderResponseDto;
	model?: ModelResponseDto;
	createdAt: Date;
	updatedAt: Date;
}

// ──────────────────────────── HEALTH ────────────────────────────

export class AiHealthResponseDto {
	status: string;
	timestamp: string;
	providers: Array<{
		code: string;
		name: string;
		protocol: string;
		enabled: boolean;
		modelCount: number;
	}>;
}

// ──────────────────────────── EXPORTS ────────────────────────────

export class ExportProvidersQueryDto {
	@IsOptional()
	@IsEnum({ ...AiEntityScope, ALL: 'all' })
	scope?: AiEntityScope | "all";

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@IsUUID()
	adminId?: string;
}

export class ExportModelsQueryDto {
	@IsOptional()
	@IsUUID()
	providerId?: string;

	@IsOptional()
	@IsString()
	providerCode?: string;

	@IsOptional()
	@IsEnum(AiModelType)
	modelType?: AiModelType;

	@IsOptional()
	@IsEnum(AiModelTier)
	tier?: AiModelTier;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@IsEnum({ ...AiEntityScope, ALL: 'all' })
	scope?: AiEntityScope | "all";

	@IsOptional()
	@IsUUID()
	adminId?: string;
}

export class ExportIntegrationsQueryDto {
	@IsOptional()
	@IsUUID()
	providerId?: string;

	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@IsEnum(AiIntegrationScope)
	scope?: AiIntegrationScope;

	@IsOptional()
	@IsUUID()
	adminId?: string;
}

export class ExportRequestSummariesQueryDto {
	@IsOptional()
	@IsUUID()
	sessionId?: string;

	@IsOptional()
	@IsUUID()
	conversationId?: string;

	@IsOptional()
	@IsUUID()
	providerId?: string;

	@IsOptional()
	@IsUUID()
	modelId?: string;

	@IsOptional()
	@IsEnum(AiRequestSummaryStatus)
	status?: AiRequestSummaryStatus;

	@IsOptional()
	@IsString()
	startDate?: string;

	@IsOptional()
	@IsString()
	endDate?: string;

	@IsOptional()
	@IsUUID()
	adminId?: string;
}

export class ExportWriteToolCallsQueryDto {
	@IsOptional()
	@IsUUID()
	sessionId?: string;

	@IsOptional()
	@IsUUID()
	providerId?: string;

	@IsOptional()
	@IsUUID()
	modelId?: string;

	@IsOptional()
	@IsString()
	toolName?: string;

	@IsOptional()
	@IsEnum(AiWriteToolCallStatus)
	status?: AiWriteToolCallStatus;

	@IsOptional()
	@IsString()
	startDate?: string;

	@IsOptional()
	@IsString()
	endDate?: string;

	@IsOptional()
	@IsUUID()
	adminId?: string;
}
