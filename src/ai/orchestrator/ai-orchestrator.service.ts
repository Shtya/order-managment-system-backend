import { Inject, Injectable } from '@nestjs/common';
import { randomUUID, createHash } from 'crypto';
import { AI_CONFIG_TOKEN } from '../ai.constants';
import { AiConfig } from '../interfaces/provider-config.interface';
import {
	AiChatMessage,
	AiExecutionSession,
	AiOrchestrationError,
	AiOrchestrationResult,
	AiProgressEvent,
	AiToolCall,
	AiToolExecutionResult,
	AiUsage,
} from '../interfaces/ai-types';
import { AiProviderAbstract } from '../providers/ai-provider.abstract';
import { AiToolRegistryService } from '../tools/ai-tool-registry.service';
import { AiTool } from '../tools/ai-tool.abstract';
import { AiToolContext } from '../tools/ai-tool-context';
import { AiExecutionScope } from './execution-context';
import { AiProviderSelectorService } from './provider-selector.service';
import { AiSystemPromptService } from './ai-system-prompt.service';
import { AiLoggerService } from './ai-logger.service';
import { AiAuditService } from './ai-audit.service';
import { AiPiiMaskerService } from '../security/ai-pii-masker.service';
import { AiWriteToolCallStatus } from 'entities/ai.entity';
import { isAiProviderError } from '../errors/provider.errors';

export interface AiChatOptions {
	conversationId?: string;
	history?: AiChatMessage[];
	provider?: string;
	model?: string;
	acceptWriteOperations?: boolean;
	metadata?: Record<string, unknown>;
}

const FORCE_ANSWER_NOTE =
	'You have already retrieved all the information needed to answer the user\'s request. Do not call any more tools. Provide the final answer now using only the tool results already present in this conversation.';

@Injectable()
export class AiOrchestratorService {
	constructor(
		@Inject(AI_CONFIG_TOKEN) private readonly config: AiConfig,
		private readonly toolRegistry: AiToolRegistryService,
		private readonly providerSelector: AiProviderSelectorService,
		private readonly systemPromptService: AiSystemPromptService,
		private readonly logger: AiLoggerService,
		private readonly auditService: AiAuditService,
		private readonly piiMasker: AiPiiMaskerService,
	) { }

	async chat(me: any, userMessage: string, options: AiChatOptions = {}): Promise<AiOrchestrationResult> {
		const requestId = randomUUID();
		const sessionId = randomUUID();

		const tenantId = this.resolveTenantId(me);
		const session: AiExecutionSession = {
			sessionId,
			conversationId: options.conversationId,
			tenantId,
			userId: me?.id ?? 'unknown',
			userName: me?.name,
			userRoleName: me?.role?.name,
			userPermissionNames: me?.role?.permissionNames ?? [],
			provider: options.provider,
			model: options.model,
			metadata: options.metadata,
			enforcePiiMasking: false,
			acceptWriteOperations: options.acceptWriteOperations ?? false,
		};

		const execution = new AiExecutionScope(session, requestId);
		const ctx = new AiToolContext({ session, requestId, allowedToolNames: session.allowedToolNames });

		const masked = session.enforcePiiMasking ? this.piiMasker.mask(userMessage) : { text: userMessage, pairs: [] };

		let messages: AiChatMessage[] = [];
		if (options.history?.length) {
			messages = messages.concat(options.history);
		}
		messages = messages.concat([
			{ role: 'system', content: this.systemPromptService.build(ctx) },
			{ role: 'user', content: masked.text },
		]);

		try {
			const result = await this.runLoop(ctx, execution, messages);
			return this.finalize(ctx, execution, result, masked.pairs);
		} catch (error: any) {
			let errorDetails: AiOrchestrationError | undefined;
			if (isAiProviderError(error)) {
				errorDetails = {
					name: error.name,
					kind: error.kind,
					provider: error.provider,
					retryable: error.retryable,
					message: error.message,
					status: error.status,
				};
			}
			return this.finalize(ctx, execution, {
				error: error.message ?? String(error),
				errorCode: errorDetails?.kind,
				errorDetails,
			}, masked.pairs);
		}
	}

	private async runLoop(
		ctx: AiToolContext,
		execution: AiExecutionScope,
		messages: AiChatMessage[],
	): Promise<{ content?: string; error?: string; errorCode?: string }> {
		const toolSpecs = this.toolRegistry.getToolSpecs(ctx);
		const seenToolCalls = new Set<string>();
		const { candidates, userExplicitChoice } = await this.resolveProviders(ctx);

		for (let round = 1; round <= this.config.maxProviderRoundtrips; round++) {
			execution.beginRound();

			const { provider, result } = await this.callProviderWithFailover(
				execution,
				messages,
				toolSpecs,
				round,
				candidates,
				userExplicitChoice,
			);

			execution.trackProvider(provider.kind);
			execution.trackModel(result.providerModel ?? provider.getConfig().model ?? '');
			execution.recordUsage(result.usage);

			if (result.role === 'assistant' && result.toolCalls?.length) {
				const newToolCalls: AiToolCall[] = [];
				for (const toolCall of result.toolCalls) {
					const signature = `${toolCall.name}:${stableJson(toolCall.arguments)}`;
					if (seenToolCalls.has(signature)) {
						execution.emit({
							type: 'tool_skipped_dedup',
							provider: provider.getConfig().name,
							toolName: toolCall.name,
							toolCallId: toolCall.id,
							result: { ok: true, code: 'TOOL_DEDUP_SKIPPED', deduplicated: true },
						});
						continue;
					}
					seenToolCalls.add(signature);
					newToolCalls.push(toolCall);
				}

				execution.emit({
					type: 'provider_tool_calls',
					round,
					provider: provider.kind,
					toolNames: newToolCalls.map((t) => t.name),
					toolCalls: newToolCalls.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments })),
				});


				messages.push({ role: 'assistant', content: null, toolCalls: newToolCalls });

				for (const toolCall of newToolCalls) {
					const toolMessage = await this.executeToolCall(ctx, execution, provider, toolCall, round);
					messages.push(toolMessage);
				}

				continue;
			}

			if (result.role === 'assistant' && typeof result.content === 'string') {
				execution.emit({
					type: 'provider_content',
					round,
					provider: provider.kind,
					content: result.content.slice(0, 500),
				});
				return { content: result.content };
			}

			throw new Error('Provider returned neither content nor tool calls');
		}

		return {
			error: 'Reached the maximum number of provider round-trips without a final answer',
			errorCode: 'MAX_PROVIDER_ROUNDTRIPS',
		};
	}

	private async resolveProviders(ctx: AiToolContext): Promise<{ primary: AiProviderAbstract; candidates: AiProviderAbstract[]; userExplicitChoice: boolean }> {
		const userExplicitChoice = !!(ctx.session.provider || ctx.session.model);
		let requested = ctx.session.provider ?? this.config.defaultProvider;
		const requestedModel = ctx.session.model;

		if (!ctx.session.provider && !requestedModel) {
			const resolved = await this.providerSelector.resolveDefaultModel(ctx.session.tenantId);
			if (resolved) {
				requested = resolved.providerEntityId;
				(ctx.session as any).model = resolved.modelCode;
			}
		}

		if (!ctx.session.provider && requestedModel) {
			const providerByModel = await this.providerSelector.resolveProviderByModelId(requestedModel, ctx.session.tenantId);
			if (providerByModel) {
				requested = providerByModel;
			}
		}

		let primary: AiProviderAbstract;
		if (requested && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requested)) {
			primary = await this.providerSelector.selectCustom(requested, ctx.session.tenantId);
		} else {
			primary = await this.providerSelector.select(requested, ctx.session.tenantId);
		}

		if (requestedModel) {
			primary = primary.cloneWithRuntime({ model: requestedModel });
		}

		if (userExplicitChoice) {
			return { primary, candidates: [primary], userExplicitChoice: true };
		}

		const failovers = await this.providerSelector.failoverCandidates(primary.getConfig().name, ctx.session.tenantId);
		return { primary, candidates: [primary, ...failovers], userExplicitChoice: false };
	}

	private async callProviderWithFailover(
		execution: AiExecutionScope,
		messages: AiChatMessage[],
		toolSpecs: ReturnType<AiToolRegistryService['getToolSpecs']>,
		round: number,
		candidates: AiProviderAbstract[],
		userExplicitChoice?: boolean,
	): Promise<{ provider: AiProviderAbstract; result: { role: 'assistant'; content?: string; toolCalls?: AiToolCall[]; usage?: AiUsage; providerModel?: string } }> {
		const toolChoice = toolSpecs.length > 0 ? 'auto' : 'none';
		let lastError: unknown;

		for (const candidate of candidates) {
			execution.emit({ type: 'provider_start', round, provider: candidate.getConfig().name });

			try {
				const result = await candidate.callModel({
					messages,
					tools: toolSpecs,
					toolChoice,
				});
				return { provider: candidate, result };
			} catch (error) {
				lastError = error;
				const message = error instanceof Error ? error.message : String(error);
				execution.emit({
					type: 'provider_failover',
					round,
					provider: candidate.getConfig().name,
					error: message.slice(0, 500),
				});
				if (userExplicitChoice) {
					throw lastError;
				}
			}
		}

		throw lastError ?? new Error('All AI providers failed');
	}

	private async executeToolCall(
		ctx: AiToolContext,
		execution: AiExecutionScope,
		provider: AiProviderAbstract,
		toolCall: AiToolCall,
		round: number,
	): Promise<AiChatMessage> {
		const tool = this.toolRegistry.getTool(toolCall.name);

		if (!tool) {
			return {
				role: 'tool',
				toolCallId: toolCall.id,
				content: JSON.stringify({ ok: false, code: 'UNKNOWN_TOOL', error: `Tool '${toolCall.name}' does not exist` }),
			};
		}

		if (!tool.canRunFor(ctx)) {
			return {
				role: 'tool',
				toolCallId: toolCall.id,
				content: JSON.stringify({ ok: false, code: 'TOOL_NOT_ALLOWED', error: 'You do not have permission to call this tool' }),
			};
		}

		if (tool.isWrite && !ctx.session.acceptWriteOperations) {
			return {
				role: 'tool',
				toolCallId: toolCall.id,
				content: JSON.stringify({
					ok: false,
					code: 'WRITE_OPERATION_NOT_ACCEPTED',
					error: 'Write operations are blocked for this request. The user must explicitly accept them (acceptWriteOperations=true) before data is modified or messages are sent.',
				}),
			};
		}

		let result: AiToolExecutionResult;

		if (tool.isWrite && this.config.writeToolDedup.enabled) {
			result = await this.executeWriteToolIdempotently(ctx, execution, tool, toolCall);
		} else {
			execution.emit({ type: 'tool_start', round, provider: provider.getConfig().name, toolName: tool.name, toolCallId: toolCall.id });
			result = await tool.execute(ctx, toolCall.arguments);
			execution.emit({ type: 'tool_result', round, provider: provider.getConfig().name, toolName: tool.name, toolCallId: toolCall.id, result });
		}

		return { role: 'tool', toolCallId: toolCall.id, content: JSON.stringify(result) };
	}

	private async executeWriteToolIdempotently(
		ctx: AiToolContext,
		execution: AiExecutionScope,
		tool: AiTool,
		toolCall: AiToolCall,
	): Promise<AiToolExecutionResult> {
		const adminId = ctx.session.tenantId ?? ctx.session.userId;
		const toolCallId = toolCall.id;
		const args = toolCall.arguments;
		const argsHash = sha256(stableJson(args));
		const dedupKey = tool.dedup?.key?.(args) ?? argsHash;

		const pending = await this.auditService.findWriteCall(adminId, tool.name, toolCallId);
		if (pending) {
			switch (pending.status) {
				case AiWriteToolCallStatus.COMPLETED:
					execution.emit({
						type: 'tool_skipped_dedup',
						provider: undefined,
						toolName: tool.name,
						toolCallId: toolCall.id,
						result: { ok: true, code: 'TOOL_RESULT_DEDUPLICATED', data: pending.result, deduplicated: true },
					});
					return { ok: true, code: 'TOOL_RESULT_DEDUPLICATED', data: pending.result, deduplicated: true };

				case AiWriteToolCallStatus.PENDING: {
					const ageMs = Date.now() - new Date(pending.createdAt).getTime();
					if (ageMs <= this.config.writeToolDedup.pendingTtlMs) {
						return {
							ok: false,
							code: 'STALE_PENDING',
							error: 'This write operation is still being processed by a previous request. Do not retry it yet.',
						};
					}
					await this.auditService.markStale(adminId, tool.name, toolCallId);
					if (tool.staleRecovery === 'manual_review') {
						return {
							ok: false,
							code: 'STALE_PENDING_REQUIRES_REVIEW',
							error: 'This write operation previously did not complete and requires manual review before it can be retried.',
						};
					}
					break;
				}

				case AiWriteToolCallStatus.STALE:
				case AiWriteToolCallStatus.FAILED:
					if (tool.staleRecovery === 'manual_review') {
						return {
							ok: false,
							code: 'STALE_PENDING_REQUIRES_REVIEW',
							error: 'This write operation did not complete and requires manual review before it can be retried.',
						};
					}
					break;
			}
		}

		const claimed = await this.auditService.claimWriteCall({
			adminId,
			toolName: tool.name,
			toolCallId,
			dedupKey,
			argsHash,
			args,
			requestId: execution.requestId,
			sessionId: execution.session.sessionId,
		});

		if (!claimed) {
			return {
				ok: false,
				code: 'STALE_PENDING',
				error: 'Another request is already processing this write operation. Do not retry it yet.',
			};
		}

		execution.emit({ type: 'tool_start', round: execution.currentRound, toolName: tool.name, toolCallId: toolCall.id });

		let result: AiToolExecutionResult;
		try {
			result = await tool.execute(ctx, args);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.auditService.failWriteCall(adminId, tool.name, toolCallId, message);
			execution.emit({ type: 'tool_result', round: execution.currentRound, toolName: tool.name, toolCallId: toolCall.id, result: { ok: false, code: 'TOOL_EXECUTION_ERROR', error: message } });
			throw error;
		}

		execution.emit({ type: 'tool_result', round: execution.currentRound, toolName: tool.name, toolCallId: toolCall.id, result });
		await this.auditService.completeWriteCall(adminId, tool.name, toolCallId, result);

		return result;
	}

	private finalize(
		ctx: AiToolContext,
		execution: AiExecutionScope,
		result: { content?: string; error?: string; errorCode?: string; errorDetails?: AiOrchestrationError },
		pairs: Array<{ token: string; original: string }>,
	): AiOrchestrationResult {
		const usage = execution.getUsage();
		const ok = !result.error;

		let content: string | undefined;
		if (typeof result.content === 'string') {
			content = ctx.session.enforcePiiMasking ? this.piiMasker.unmask(result.content, pairs) : result.content;
		}

		const progress = execution.getEvents();
		const finalResult: AiOrchestrationResult = {
			sessionId: execution.session.sessionId,
			requestId: execution.requestId,
			conversationId: execution.session.conversationId,
			ok,
			content,
			usage,
			providersUsed: execution.getProvidersUsed(),
			modelsUsed: execution.getModelsUsed(),
			rounds: execution.currentRound,
			progress,
			error: result.error,
			errorCode: result.errorCode,
			errorDetails: result.errorDetails,
		};

		this.persistSummary(ctx, execution, result, usage, ok);

		return finalResult;
	}

	private async persistSummary(
		ctx: AiToolContext,
		execution: AiExecutionScope,
		result: { error?: string; errorCode?: string },
		usage: AiUsage,
		ok: boolean,
	) {
		const adminId = ctx.session.tenantId ?? ctx.session.userId	;

		await this.auditService.createRequestSummary({
			adminId,
			sessionId: execution.session.sessionId,
			conversationId: execution.session.conversationId,
			requestId: execution.requestId,
			status: ok ? 'ok' : 'error',
			usagePromptTokens: usage.promptTokens,
			usageCompletionTokens: usage.completionTokens,
			usageTotalTokens: usage.totalTokens,
			rounds: execution.currentRound,
			durationMs: execution.getDurationMs(),
			errorCode: result.errorCode,
			error: result.error,
			summary: this.config.storeConversationSummaries
				? {
					conversationId: execution.session.conversationId,
					lastError: result.error ?? null,
					lastToolNames: extractToolNames(execution.getEvents()),
					usage,
					rounds: execution.currentRound,
					providersUsed: execution.getProvidersUsed(),
					modelsUsed: execution.getModelsUsed(),
				}
				: undefined,
			progress: execution.getEvents(),
			providersUsed: execution.getProvidersUsed(),
			modelsUsed: execution.getModelsUsed(),
		});
	}

	private resolveTenantId(me: any): string | null {
		if (!me) return null;
		const roleName = me.role?.name;
		if (roleName === 'super_admin') return null;
		if (roleName === 'admin') return me.id ?? null;
		return me.adminId ?? null;
	}
}

function sha256(input: string): string {
	return createHash('sha256').update(input).digest('hex');
}

function stableJson(value: unknown): string {
	try {
		return JSON.stringify(sortObject(value ?? {}));
	} catch {
		return '{}';
	}
}

function sortObject(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortObject);
	if (value && typeof value === 'object') {
		return Object.keys(value)
			.sort()
			.reduce<Record<string, unknown>>((acc, key) => {
				acc[key] = sortObject((value as Record<string, unknown>)[key]);
				return acc;
			}, {});
	}
	return value;
}

function extractToolNames(events: AiProgressEvent[]): string[] {
	const names = new Set<string>();
	for (const event of events) {
		if (event.type === 'tool_start' && event.toolName) names.add(event.toolName);
	}
	return Array.from(names);
}
