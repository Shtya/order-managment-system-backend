import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type AiWriteToolCallStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'STALE';

export type AiRequestSummaryStatus = 'ok' | 'error' | 'partial';

@Entity('ai_request_summaries')
export class AiRequestSummaryEntity {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Index()
	@Column({ type: 'uuid', nullable: true })
	adminId: string;

	@Index()
	@Column({ type: 'uuid' })
	sessionId: string;

	@Index()
	@Column({ type: 'uuid', nullable: true })
	conversationId: string;

	@Column({ type: 'uuid' })
	requestId: string;

	@Column({ type: 'varchar' })
	provider: string;

	@Column({ type: 'varchar', nullable: true })
	model: string;

	@Column({ type: 'enum', enum: ['ok', 'error', 'partial'], default: 'ok' })
	status: AiRequestSummaryStatus;

	@Column({ type: 'int', default: 0 })
	usagePromptTokens: number;

	@Column({ type: 'int', default: 0 })
	usageCompletionTokens: number;

	@Column({ type: 'int', default: 0 })
	usageTotalTokens: number;

	@Column({ type: 'int', default: 0 })
	rounds: number;

	@Column({ type: 'int', nullable: true })
	durationMs: number;

	@Column({ type: 'varchar', nullable: true })
	errorCode: string;

	@Column({ type: 'text', nullable: true })
	error: string;

	@Column({ type: 'jsonb', nullable: true })
	summary: any;

	@Column({ type: 'jsonb', nullable: true })
	providersUsed: string[];

	@CreateDateColumn({ type: 'timestamptz' })
	createdAt: Date;

	@UpdateDateColumn({ type: 'timestamptz' })
	updatedAt: Date;
}

@Index(['adminId', 'toolCallId'], { unique: true })
@Entity('ai_write_tool_calls')
export class AiWriteToolCallEntity {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Index()
	@Column({ type: 'uuid', nullable: true })
	adminId: string;

	@Column({ type: 'uuid' })
	sessionId: string;

	@Column({ type: 'uuid', nullable: true })
	requestId: string;

	@Index()
	@Column({ type: 'varchar' })
	toolName: string;

	@Column({ type: 'varchar', length: 1024 })
	dedupKey: string;

	@Index()
	@Column({ type: 'varchar', length: 255, nullable: true })
	toolCallId: string;

	@Column({ type: 'varchar' })
	argsHash: string;

	@Column({ type: 'jsonb' })
	args: any;

	@Column({ type: 'enum', enum: ['PENDING', 'COMPLETED', 'FAILED', 'STALE'], default: 'PENDING' })
	status: AiWriteToolCallStatus;

	@Column({ type: 'jsonb', nullable: true })
	result: any;

	@Column({ type: 'text', nullable: true })
	error: string;

	@Column({ type: 'timestamptz', nullable: true })
	completedAt: Date;

	@CreateDateColumn({ type: 'timestamptz' })
	createdAt: Date;

	@UpdateDateColumn({ type: 'timestamptz' })
	updatedAt: Date;
}
