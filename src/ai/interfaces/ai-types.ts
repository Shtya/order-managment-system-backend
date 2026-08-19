import { IsOptional, IsString } from "class-validator";

export type AiMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AiToolCallArg {
	[key: string]: unknown;
}

export interface AiToolCall {
	id: string;
	name: string;
	arguments: AiToolCallArg;
}

export interface AiChatMessage {
	role: AiMessageRole;
	content: string | null;
	toolCallId?: string;
	name?: string;
	toolCalls?: AiToolCall[];
}

export interface AiUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

export interface AiToolCallResponse {
	role: 'assistant';
	toolCalls: AiToolCall[];
	usage?: AiUsage;
	providerModel?: string;
}

export interface AiContentResponse {
	role: 'assistant';
	content: string;
	usage?: AiUsage;
	providerModel?: string;
}

export interface AiProviderRound {
	message: AiChatMessage;
	toolCalls?: AiToolCall[];
	usage?: AiUsage;
	model?: string;
}

export type AiProviderResult = AiToolCallResponse | AiContentResponse;

export type AiStaleRecoveryMode = 'auto_recover' | 'manual_review';

export interface AiExecutionSession {
	sessionId: string;
	conversationId?: string;
	tenantId: string | null;
	userId: string;
	userName?: string;
	userRoleName?: string;
	userPermissionNames?: string[];
	provider?: string;
	model?: string;
	metadata?: Record<string, unknown>;
	allowedToolNames?: string[];
	enforcePiiMasking: boolean;
	acceptWriteOperations: boolean;
}

export interface AiToolExecutionResult {
	ok: boolean;
	code: string;
	data?: unknown;
	error?: string;
	deduplicated?: boolean;
}

export type AiExecutionResult =
	| AiToolExecutionResult
	| Record<string, unknown>
	| unknown
	| void;

export interface AiProgressEvent {
	type:
		| 'provider_start'
		| 'provider_tool_calls'
		| 'provider_content'
		| 'tool_start'
		| 'tool_result'
		| 'tool_skipped_dedup'
		| 'provider_failover'
		| 'round_limit_reached';
	round?: number;
	provider?: string;
	toolName?: string;
	toolNames?: string[];
	toolCalls?: AiToolCall[];
	toolCallId?: string;
	content?: string;
	result?: AiToolExecutionResult;
	error?: string;
}

export interface AiConversationSummary {
	conversationId: string;
	lastTopic?: string;
	lastToolNames?: string[];
	toolUseCount: number;
	usage: AiUsage;
	rounds: number;
	providersUsed: string[];
	modelsUsed: string[];
	createdAt: Date;
}

export interface AiOrchestrationError {
	name: string;
	kind: string;
	provider?: string;
	retryable: boolean;
	message: string;
	status?: number;
}

export interface AiOrchestrationDevInfo {
	phaseTiming: {
		totalMs: number;
		phases: Array<{ name: string; ms: number; pct: string; detail?: Record<string, unknown> }>;
	};
	nodeEnv: string;
	requestedProvider?: string;
	requestedModel?: string;
	tenantId?: string | null;
	userId?: string;
	userRole?: string;
	providersUsed: string[];
	modelsUsed: string[];
	rounds: number;
	progress: AiProgressEvent[];
}

export interface AiOrchestrationResult {
	sessionId: string;
	requestId: string;
	conversationId?: string;
	ok: boolean;
	content?: string;
	toolCalls?: AiToolCall[];
	usage: AiUsage;
	providersUsed?: string[];
	modelsUsed?: string[];
	rounds?: number;
	progress?: AiProgressEvent[];
	conversationSummary?: AiConversationSummary;
	error?: string;
	errorCode?: string;
	errorDetails?: AiOrchestrationError;
	_dev?: AiOrchestrationDevInfo;
}

export interface AiProviderRequest {
	messages: AiChatMessage[];
	tools: AiToolSpec[];
	toolChoice: 'auto' | 'none';
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
}

export interface AiProviderHealth {
	healthy: boolean;
	lastFailureAt?: Date;
	consecutiveFailures: number;
	lastError?: string;
	model?: string;
}

export interface AiToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export class AiProviderCredentials {
	
    @IsString()
    apiKey: string;
}

export interface AiToolRunOptions {
	allowedToolNames?: string[];
	toolCalls?: AiToolCall[];
	progress: (event: AiProgressEvent) => void;
}


