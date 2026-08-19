import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiRequestSummaryEntity, AiRequestSummaryStatus, AiWriteToolCallEntity, AiWriteToolCallStatus } from '../../../entities/ai.entity';

export interface RequestSummaryInput {
	adminId: string;
	sessionId: string;
	conversationId?: string;
	requestId: string;
	providerId?: string;
	modelId?: string;
	status: 'ok' | 'error' | 'partial';
	usagePromptTokens: number;
	usageCompletionTokens: number;
	usageTotalTokens: number;
	rounds: number;
	durationMs: number;
	errorCode?: string;
	error?: string;
	summary?: unknown;
	progress?: unknown;
	providersUsed?: string[];
	modelsUsed?: string[];
}

@Injectable()
export class AiAuditService {
	private readonly logger = new Logger(AiAuditService.name);

	constructor(
		@InjectRepository(AiRequestSummaryEntity)
		private readonly requestSummaryRepo: Repository<AiRequestSummaryEntity>,
		@InjectRepository(AiWriteToolCallEntity)
		private readonly writeToolCallRepo: Repository<AiWriteToolCallEntity>,
	) {}

	async createRequestSummary(input: RequestSummaryInput): Promise<AiRequestSummaryEntity> {
		try {
			const entity = this.requestSummaryRepo.create({
				adminId: input.adminId,
				sessionId: input.sessionId,
				conversationId: input.conversationId,
				requestId: input.requestId,
				providerId: input.providerId,
				modelId: input.modelId,
				status: input.status as AiRequestSummaryStatus,
				usagePromptTokens: input.usagePromptTokens,
				usageCompletionTokens: input.usageCompletionTokens,
				usageTotalTokens: input.usageTotalTokens,
				rounds: input.rounds,
				durationMs: input.durationMs,
				errorCode: input.errorCode,
				error: input.error,
				summary: input.summary,
				progress: input.progress,
				providersUsed: input.providersUsed,
			});
			const saved = await this.requestSummaryRepo.save(entity);
			return saved as any;
		} catch (error) {
			this.logger.error('Failed to persist AI request summary', error);
			return null as any;
		}
	}

	// ---------- Idempotency record helpers (race-safe) ----------

	async findWriteCall(adminId: string, toolName: string, toolCallId: string): Promise<AiWriteToolCallEntity | null> {
		return this.writeToolCallRepo.findOne({
			where: { adminId: adminId || null, toolName, toolCallId } as any,
		});
	}

	/**
	 * Atomic claim of a PENDING idempotency row keyed by (adminId, toolCallId).
	 * - Fresh rows are claimed via INSERT ... ON CONFLICT DO NOTHING.
	 * - When a row already exists it may only be re-claimed (stolen) if its status
	 *   is STALE or FAILED; a fresh PENDING row is owned by another in-flight request.
	 * Returns true when THIS caller may execute the write.
	 */
	async claimWriteCall(input: {
		adminId: string;
		toolName: string;
		toolCallId: string;
		dedupKey: string;
		argsHash: string;
		args: unknown;
		requestId: string;
		sessionId: string;
	}): Promise<boolean> {
		try {
			const inserted = await this.writeToolCallRepo
				.createQueryBuilder()
				.insert()
				.into(AiWriteToolCallEntity)
				.values({
					adminId: input.adminId || null,
					toolName: input.toolName,
					toolCallId: input.toolCallId,
					dedupKey: input.dedupKey,
					argsHash: input.argsHash,
					args: input.args as any,
					requestId: input.requestId,
					sessionId: input.sessionId,
					status: AiWriteToolCallStatus.PENDING,
				})
				.orIgnore()
				.execute();

			if (inserted.identifiers?.length) return true;

			const stolen = await this.writeToolCallRepo
				.createQueryBuilder()
				.update(AiWriteToolCallEntity)
				.set({
					status: AiWriteToolCallStatus.PENDING,
					args: input.args as any,
					argsHash: input.argsHash,
					error: null,
					completedAt: null,
					requestId: input.requestId,
					sessionId: input.sessionId,
				})
				.where('adminId = :adminId', { adminId: input.adminId || null })
				.andWhere('toolName = :toolName', { toolName: input.toolName })
				.andWhere('toolCallId = :toolCallId', { toolCallId: input.toolCallId })
				.andWhere('status IN (:...statuses)', { statuses: ['STALE', 'FAILED'] })
				.execute();

			return (stolen.affected ?? 0) > 0;
		} catch (error) {
			this.logger.error(`claimWriteCall failed for ${input.toolName}`, error);
			return false;
		}
	}

	async updateWriteCallStatus(
		adminId: string,
		toolName: string,
		toolCallId: string,
		status: AiWriteToolCallStatus,
		extra: Partial<Pick<AiWriteToolCallEntity, 'result' | 'error' | 'completedAt'>> = {},
	): Promise<void> {
		try {
			await this.writeToolCallRepo.update(
				{ adminId: adminId || null, toolName, toolCallId } as any,
				{
					status,
					...(extra.result !== undefined ? { result: extra.result as any } : {}),
					...(extra.error !== undefined ? { error: extra.error } : {}),
					...(status === AiWriteToolCallStatus.COMPLETED ? { completedAt: new Date() } : {}),
				},
			);
		} catch (error) {
			this.logger.error(`updateWriteCallStatus failed for ${toolName}`, error);
		}
	}

	async completeWriteCall(adminId: string, toolName: string, toolCallId: string, result: unknown): Promise<void> {
		return this.updateWriteCallStatus(adminId, toolName, toolCallId, AiWriteToolCallStatus.COMPLETED, { result, completedAt: new Date() });
	}

	async failWriteCall(adminId: string, toolName: string, toolCallId: string, error: string): Promise<void> {
		return this.updateWriteCallStatus(adminId, toolName, toolCallId, AiWriteToolCallStatus.FAILED, { error });
	}

	async markStale(adminId: string, toolName: string, toolCallId: string): Promise<void> {
		return this.updateWriteCallStatus(adminId, toolName, toolCallId, AiWriteToolCallStatus.STALE);
	}
}
