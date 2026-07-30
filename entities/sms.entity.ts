import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    Relation,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

export enum SmsSendStatus {
    PENDING = 'pending',
    SENT = 'sent',
    FAILED = 'failed',
}

export enum SmsProviderType {
    SMSEG = 'smseg',
}
@Index(['code'], { unique: true })
@Entity('sms_providers')
export class SmsProviderEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'enum', enum: SmsProviderType })
    code: SmsProviderType;

    @Column({ type: 'varchar', length: 255 })
    name: string;

    @Column({ type: 'boolean', default: true })
    isActive: boolean;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at: Date;
}

@Index(['adminId', 'providerId'], { unique: true })
@Entity('sms_integrations')
export class SmsIntegrationEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' })
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Index()
    @Column({ type: 'enum', enum: SmsProviderType })
    providerCode: SmsProviderType;

    @Index()
    @Column({ type: 'uuid' })
    providerId: string;

    @ManyToOne(() => SmsProviderEntity, { onDelete: 'SET NULL', eager: true })
    @JoinColumn({ name: 'providerId' })
    provider: Relation<SmsProviderEntity>;

    @Column({ type: 'boolean', default: true })
    isActive: boolean;

    @Column({ type: 'jsonb', nullable: true, select: true })
    credentials?: {
        username: string;
        password: string;
    };

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at: Date;
}

@Index(['adminId', 'integrationId', 'identifier'], { unique: true })
@Index(['adminId', 'integrationId', 'name'], { unique: true })
@Entity("sms_senders")
export class SmsSenderEntity {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' })
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    integrationId: string;

    @ManyToOne(() => SmsIntegrationEntity, {
        onDelete: "CASCADE",
    })
    @JoinColumn({ name: 'integrationId' })
    integration: SmsIntegrationEntity;

    @Column({ length: 100 })
    name: string;
    // Friendly UI name

    @Column({ length: 150 })
    identifier: string;
    // Actual value used by provider
    // MADAR
    // +14155551234
    // MGxxxxxxxxxxxx

    @Column({ default: false })
    isDefault: boolean;

    @Column({ type: 'boolean', default: true })
    isActive: boolean;

    @Column({ nullable: true })
    description?: string;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at: Date;
}


@Index(['adminId', 'created_at'])
@Index(['adminId', 'integrationId', 'created_at'])
@Index(['adminId', 'status', 'created_at'])
@Entity('sms_send_logs')
export class SmsSendLogEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' })
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    integrationId: string;

    @ManyToOne(() => SmsIntegrationEntity, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'integrationId' })
    integration: Relation<SmsIntegrationEntity>;

    @Index()
    @Column({ type: 'enum', enum: SmsProviderType })
    providerCode: SmsProviderType;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    providerId: string;

    @ManyToOne(() => SmsProviderEntity, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'providerId' })
    provider: Relation<SmsProviderEntity>;

    @Index()
    @Column({ type: 'varchar', length: 50 })
    toNumber: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    senderId: string;

    @ManyToOne(() => SmsSenderEntity, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'senderId' })
    sender: Relation<SmsSenderEntity>;

    @Column({ type: 'text' })
    message: string;

    @Column({ type: 'enum', enum: SmsSendStatus, default: SmsSendStatus.PENDING })
    status: SmsSendStatus;

    @Column({ type: 'varchar', length: 255, nullable: true })
    providerMessageId: string;

    @Column({ type: 'jsonb', nullable: true })
    providerResponse?: any;

    @Column({ type: 'text', nullable: true })
    error?: string;

    @Column({ type: 'timestamptz', nullable: true })
    sent_at?: Date;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at: Date;
}