import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from './user.entity';

export enum AiProviderCode {
    OPENAI = 'openai',
    ANTHROPIC = 'anthropic',
    GOOGLE = 'google',
    DEEPSEEK = 'deepseek',
    // Aggregator / system providers
    LLM7 = 'llm7',
    POLLINATIONS = 'pollinations',
}


export enum AiEntityScope {
    SYSTEM = 'system',
    CUSTOM = 'custom',
}

export enum AiProviderProtocol {
    OPENAI_COMPATIBLE = 'openai_compatible'
}

export enum AiAuthType {
    API_KEY = 'api_key',
    BEARER = 'bearer',
    NONE = 'none',
}

export enum AiModelTier {
    FREE = 'free',
    PRO = 'pro',
}

export enum AiWriteToolCallStatus {
    PENDING = 'pending',
    COMPLETED = 'completed',
    FAILED = 'failed',
    STALE = 'stale',
}

export enum AiRequestSummaryStatus {
    OK = 'ok',
    ERROR = 'error',
    PARTIAL = 'partial',
}

export type AiWriteToolCallStatusType = 'pending' | 'completed' | 'failed' | 'stale';

export type AiRequestSummaryStatusType = 'ok' | 'error' | 'partial';


@Entity('ai_providers')
@Index(['adminId', 'code'], { unique: true })
@Index(['adminId', 'name'], { unique: true })
export class AiProviderEntity {

    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId?: string | null;

    @ManyToOne(
        () => User,
        { nullable: true, onDelete: 'CASCADE' },
    )
    @JoinColumn({ name: 'adminId' })
    admin?: User;

    @Column({
        type: 'enum',
        enum: AiEntityScope,
        default: AiEntityScope.SYSTEM,
    })
    scope: AiEntityScope;

    /**
     * Stable internal identifier (system providers only).
     *
     * Example:
     * openai
     * anthropic
     * google
     * llm7
     */
    @Column({ type: 'varchar', length: 100 })
    code: string;

    @Column({ type: 'varchar', length: 150 })
    name: string;

    @Column({ type: 'varchar', nullable: true })
    website?: string;

    @Column({ type: 'varchar', nullable: true })
    logoUrl?: string;

    /**
     * Can tenants connect directly to this provider?
     *
     * Example:
     * OpenAI = true
     * Anthropic = true
     * LLM7 = false in your main UX
     */
    @Column({ default: false })
    tenantIntegrationAllowed: boolean;

    @Column({ default: true })
    isActive: boolean;

    @Column({ type: 'text', nullable: true })
    description?: string;

    @Column({ type: 'text', nullable: true })
    descriptionAr?: string;

    /**
     * Protocol identifier (custom providers only).
     */

    @Column({
        type: 'enum',
        enum: AiAuthType,
        default: AiAuthType.API_KEY,
    })
    authType: AiAuthType;

    @Column({
        type: 'enum',
        enum: AiProviderProtocol,
        nullable: true,
    })
    protocol?: AiProviderProtocol;

    @OneToMany(
        () => AiModelEntity,
        model => model.provider,
    )
    models: AiModelEntity[];

    @OneToMany(
        () => AiIntegrationEntity,
        integration => integration.provider,
    )
    integrations: AiIntegrationEntity[];

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at: Date;
}

export enum AiModelType {
    TEXT = 'text',
    IMAGE = 'image',
    AUDIO = 'audio',
    VIDEO = 'video',
}

@Entity('ai_models')
@Index(['providerId', 'modelCode'], { unique: true })
export class AiModelEntity {

    @PrimaryGeneratedColumn('uuid')
    id!: string;

    // related admin custom provider id
    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId?: string | null;

    @ManyToOne(
        () => User,
        { nullable: true, onDelete: 'CASCADE' },
    )
    @JoinColumn({ name: 'adminId' })
    admin?: User;

    // "AiEntityScope.SYSTEM" This integration is system-level and cannot be configured by individual admins.
    // Only the super admin can manage and configure it. 
    @Column({
        type: 'enum',
        enum: AiEntityScope,
        default: AiEntityScope.SYSTEM,
    })
    scope: AiEntityScope;

    @Column({ type: 'uuid' })
    providerId: string;

    @ManyToOne(
        () => AiProviderEntity,
        provider => provider.models,
        { onDelete: 'CASCADE' },
    )
    @JoinColumn({ name: 'providerId' })
    provider: AiProviderEntity;

    /**
     * Actual provider model ID.
     *
     * Example:
     * gpt-5
     * claude-sonnet-4
     * gemini-2.5-flash
     */
    @Column({ type: 'varchar', length: 255 })
    modelCode: string;

    @Column({ type: 'varchar', length: 255 })
    name: string;

    @Column({ type: 'text', nullable: true })
    description?: string;

    @Column({ type: 'text', nullable: true })
    descriptionAr?: string;

    @Column({
        type: 'enum',
        enum: AiModelType,
        default: AiModelType.TEXT,
    })
    modelType: AiModelType;

    // =========================
    // PROVIDER METADATA
    // =========================

    @Column({
        type: 'enum',
        enum: AiModelTier,
        nullable: true,
    })
    tier?: AiModelTier;

    @Column({ type: 'jsonb', nullable: true })
    modalities?: Record<string, any>;

    @Column({ type: 'jsonb', nullable: true })
    metadata?: Record<string, any>;

    @Column({ type: 'jsonb', nullable: true })
    contextWindow?: {
        maxInputTokens?: number;
        maxOutputTokens?: number;
    };

    @Column({ type: 'boolean', nullable: true })
    stream?: boolean;

    @Column({ type: 'boolean', nullable: true })
    jsonMode?: boolean;

    @Column({ type: 'boolean', nullable: true })
    reasoning?: boolean;

    @Column({ type: 'boolean', nullable: true })
    toolsCalling?: boolean;

    // =========================
    // CATALOG STATUS
    // =========================

    /**
     * Your super admin wants this model
     * visible in the system catalog.
     */

    @OneToMany(
        () => AiModelAvailabilityEntity,
        (availability) => availability.model,
    )
    availabilities: AiModelAvailabilityEntity[];

    @Column({ default: true })
    isActive: boolean;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at: Date;
}

@Entity('ai_model_availability')
@Index(['adminId', 'modelId'], { unique: true })
export class AiModelAvailabilityEntity {

    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId?: string | null;

    @ManyToOne(
        () => User,
        { nullable: true, onDelete: 'CASCADE' },
    )
    @JoinColumn({ name: 'adminId' })
    admin?: User;

    @Index()
    @Column({ type: 'uuid' })
    modelId: string;

    @ManyToOne(
        () => AiModelEntity,
        { onDelete: 'CASCADE' },
    )
    @JoinColumn({ name: 'modelId' })
    model: AiModelEntity;

    @Column({ default: true })
    isAvailable: boolean;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at: Date;
}

export enum AiIntegrationScope {
    SYSTEM = 'system',
    TENANT = 'tenant',
}

@Entity('ai_integrations')
@Index(['adminId', 'providerId'], { unique: true })
export class AiIntegrationEntity {

    @PrimaryGeneratedColumn('uuid')
    id!: string;

    /**
     * NULL = system integration
     *
     * NOT NULL = tenant integration
     */
    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId?: string;

    @ManyToOne(
        () => User,
        { nullable: true, onDelete: 'CASCADE' },
    )
    @JoinColumn({ name: 'adminId' })
    admin?: User;

    @Column({ type: 'uuid' })
    providerId: string;

    @ManyToOne(
        () => AiProviderEntity,
        provider => provider.integrations,
        { onDelete: 'CASCADE' },
    )
    @JoinColumn({ name: 'providerId' })
    provider: AiProviderEntity;

    @Column({
        type: 'enum',
        enum: AiIntegrationScope,
    })
    scope: AiIntegrationScope;

    /**
     * Encrypted credentials.
     *
     * NEVER store API keys as plain text.
     */
    @Column({ type: 'jsonb', nullable: true, select: true })
    encryptedCredentials?: Record<string, any>;

    @Column({
        type: 'enum',
        enum: AiAuthType,
        default: AiAuthType.API_KEY,
    })
    authType: AiAuthType;

    @Column({ type: 'varchar', nullable: true })
    baseUrl?: string;

    @Column({ type: 'timestamptz', nullable: true })
    lastValidatedAt?: Date;

    @Column({ type: 'text', nullable: true })
    lastError?: string;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_ut: Date;
}


@Entity('ai_request_summaries')
export class AiRequestSummaryEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string | null;

    @ManyToOne(
        () => User,
        { nullable: true, onDelete: 'SET NULL' },
    )
    @JoinColumn({ name: 'adminId' })
    admin?: User;

    @Index()
    @Column({ type: 'uuid' })
    sessionId: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    conversationId: string;

    @Column({ type: 'uuid' })
    requestId: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    providerId: string | null;

    @ManyToOne(
        () => AiProviderEntity,
        { nullable: true, onDelete: 'SET NULL' },
    )
    @JoinColumn({ name: 'providerId' })
    provider?: AiProviderEntity;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    modelId: string | null;

    @ManyToOne(
        () => AiModelEntity,
        { nullable: true, onDelete: 'SET NULL' },
    )
    @JoinColumn({ name: 'modelId' })
    model?: AiModelEntity;

    @Column({ type: 'enum', enum: AiRequestSummaryStatus, default: AiRequestSummaryStatus.OK })
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
    /** Compact request metadata; may include userMessage/assistantContent for session resume. */
    summary: any;

    @Column({ type: 'jsonb', nullable: true })
    progress: any;

    @Column({ type: 'jsonb', nullable: true })
    providersUsed: string[];

    @Column({ type: 'jsonb', nullable: true })
    modelsUsed: string[];

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt: Date;
}

@Index(['adminId', 'toolName', 'dedupKey'], { unique: true })
@Entity('ai_write_tool_calls')
export class AiWriteToolCallEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string | null;

    @ManyToOne(
        () => User,
        { nullable: true, onDelete: 'SET NULL' },
    )
    @JoinColumn({ name: 'adminId' })
    admin?: User;

    @Column({ type: 'uuid' })
    sessionId: string;

    @Column({ type: 'uuid', nullable: true })
    requestId: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    providerId: string | null;

    @ManyToOne(
        () => AiProviderEntity,
        { nullable: true, onDelete: 'SET NULL' },
    )
    @JoinColumn({ name: 'providerId' })
    provider?: AiProviderEntity;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    modelId: string | null;

    @ManyToOne(
        () => AiModelEntity,
        { nullable: true, onDelete: 'SET NULL' },
    )
    @JoinColumn({ name: 'modelId' })
    model?: AiModelEntity;

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

    @Column({ type: 'enum', enum: AiWriteToolCallStatus, default: AiWriteToolCallStatus.PENDING })
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

@Entity('ai_default_models')
@Index(['adminId'], { unique: true })
export class AiDefaultModelEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'uuid', nullable: true })
    adminId?: string | null;

    @ManyToOne(
        () => User,
        { nullable: true, onDelete: 'CASCADE' },
    )
    @JoinColumn({ name: 'adminId' })
    admin?: User;

    @Column({ type: 'uuid' })
    modelId: string;

    @ManyToOne(
        () => AiModelEntity,
        { onDelete: 'CASCADE' },
    )
    @JoinColumn({ name: 'modelId' })
    model: AiModelEntity;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at: Date;
}