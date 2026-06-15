import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    Index,
    ManyToOne,
    JoinColumn,
    OneToMany,
    Relation
} from 'typeorm';
import { User } from './user.entity';
import { CustomerEntity } from './customers.entity';


export enum TemplateCategory {
    MARKETING = 'marketing',
    UTILITY = 'utility',
    AUTHENTICATION = 'authentication'
}

export enum TemplateSubCategory {
    BOOKING_STATUS = 'booking_status',
    CALL_PERMISSIONS_REQUEST = 'call_permissions_request',
    FLIGHT_DELAY_AND_GATE_CHANGE_ALERT = 'flight_delay_and_gate_change_alert',
    FRAUD_ALERT = 'fraud_alert',
    ORDER_DETAILS = 'order_details',
    ORDER_STATUS = 'order_status',
    RICH_ORDER_STATUS = 'rich_order_status',
}

//UNKNOWN , low , medium , high
export enum TemplateQuality {
    HIGH = 'high',
    MEDIUM = 'medium',
    LOW = 'low',
    UNKNOWN = 'unknown'
}

export enum TemplateStatus {
    PENDING = 'pending',
    IN_REVIEW = 'in_review',
    REJECTED = 'rejected',
    APPROVED = 'approved',
    ARCHIVED = 'archived',
    UNARCHIVED = 'unarchived',
    PAUSED = 'paused',
    DISABLED = 'disabled',
    LOCKED = 'locked',
    APPEAL_REQUESTED = 'appeal_requested',
    PENDING_DELETION = 'pending_deletion'
}

export type TemplateConfig = {
    headerType?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";
    headerText?: string;
    headerExample?: string;
    headerUrl?: string;
    bodyText: string;

    footerText?: string;

    examples?: Record<string, string>;

    /** UI subcategory id for edit/preview (e.g. MARKETING_CALL_PERMISSIONS) */
    uiSubcategory?: string;

    useCustomValidity?: boolean;
    validityPeriod?: string;

    authMethod?: string;
    /** Label for Meta OTP / copy-code button (optional; default applied server-side) */
    otpCopyButtonText?: string;

    addSecurityRecommendation?: boolean;
    addExpirationTime?: boolean;
    expirationMinutes?: number;

    buttons?: Array<{
        type:
        | "CUSTOM"
        | "PHONE_NUMBER"
        | "VISIT_WEBSITE"
        | "WHATSAPP_CALL"

        text: string; // max 25
        url?: string;
        urlType?: "Static" | "Dynamic";
        urlExample?: string;
        activeForDays?: number;
        countryCode?: string;
        phoneNumber?: string; // max 20
    }>;
};

export enum MessageDirection {
    INBOUND = 'inbound',   // من العميل إلى النظام (رسالة واردة)
    OUTBOUND = 'outbound'  // من النظام إلى العميل (رسالة صادرة)
}

export enum MessageStatus {
    ACCEPTED = 'accepted',   // تم القبول من Meta
    SENT = 'sent',           // تم الإرسال للشبكة
    DELIVERED = 'delivered', // وصلت لهاتف العميل
    READ = 'read',           // العميل قرأ الرسالة
    PLAYED = 'played',       // تم تشغيل الرسالة الصوتية
    FAILED = 'failed',       // فشل الإرسال
    RECEIVED = 'received',    // رسالة واردة جديدة من العميل
    DELETED = 'deleted',      // تم الحذف من Meta
    UNSUPPORTED = 'unsupported', // الرسالة غير مدعم من Meta
}

export enum WhatsappMessageType {
    TEXT = 'text',
    IMAGE = 'image',
    AUDIO = 'audio',
    VIDEO = 'video',
    DOCUMENT = 'document',
    STICKER = 'sticker',
    CONTACTS = 'contacts',
    LOCATION = 'location',
    REACTION = 'reaction',
    TEMPLATE = 'template',
    INTERACTIVE = 'interactive',
    BUTTON = 'button',
    ORDER = 'order',
    SYSTEM = 'system',
    UNKNOWN = 'unknown',
    UNSUPPORTED = 'unsupported'
}

export enum WebhookEventStatus {
    PENDING = 'pending',
    PROCESSED = 'processed',
    FAILED = 'failed'
}

export enum WebhookEventType {
    ACCOUNT_ALERTS = 'account_alerts',
    MESSAGES = 'messages',
    STATUSES = 'statuses',
    MESSAGE_ECHOES = 'message_echoes',
    CALLS = 'calls',
    CONSUMER_PROFILE = 'consumer_profile',
    MESSAGING_HANDOVERS = 'messaging_handovers',
    GROUP_LIFECYCLE_UPDATE = 'group_lifecycle_update',
    GROUP_PARTICIPANTS_UPDATE = 'group_participants_update',
    GROUP_SETTINGS_UPDATE = 'group_settings_update',
    GROUP_STATUS_UPDATE = 'group_status_update',
    SMB_MESSAGE_ECHOES = 'smb_message_echoes',
    SMB_APP_STATE_SYNC = 'smb_app_state_sync',
    HISTORY = 'history',
    ACCOUNT_SETTINGS_UPDATE = 'account_settings_update',
    MESSAGE_TEMPLATE_STATUS_UPDATE = 'message_template_status_update',
    MESSAGE_TEMPLATE_QUALITY_UPDATE = 'message_template_quality_update',
    MESSAGE_TEMPLATE_COMPONENTS_UPDATE = 'message_template_components_update',
    TEMPLATE_CATEGORY_UPDATE = 'template_category_update',
    ACCOUNT_UPDATE = 'account_update',
    ACCOUNT_REVIEW_UPDATE = 'account_review_update'
}


export class MetaTemplateLibraryQueryDto {
    search?: string;
    topic?: string;
    usecase?: string;
    industry?: string;
    language?: string;
    category?: string;
    name?: string;

    // your local account
    accountId?: string;
}
export type MetaTemplateLibraryButtonDto = {
    type: 'CUSTOM' | 'PHONE_NUMBER' | 'URL' | 'WHATSAPP_CALL';
    text: string;
    url?: string;
    phone_number?: string;
    country_code?: string;
};


export type MetaTemplateLibraryItemDto = {
    id: string;
    name: string;
    language: 'ar' | 'en';
    category: string;
    topic?: string;
    usecase?: string;
    industry?: string[];

    header?: string;
    header_type?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
    body?: string;
    footer?: string;

    body_params?: string[];
    body_param_types?: string[];

    buttons?: MetaTemplateLibraryButtonDto[];

    // This perfectly matches the templateConfig column structure in WhatsappTemplateEntity
    templateConfig: TemplateConfig;
};


export enum ConversationStatus {
    OPEN = 'open',
    ARCHIVED = 'archived',
}

@Entity('whatsapp_conversations')
export class ConversationEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid' })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Index()
    @Column({ type: 'uuid' })
    customerId: string;

    @ManyToOne(() => CustomerEntity, {
        onDelete: 'CASCADE', eager: true,
    })
    @JoinColumn({ name: 'customerId' })
    customer: CustomerEntity;

    @Index()
    @Column({
        type: 'enum',
        enum: ConversationStatus,
        default: ConversationStatus.OPEN,
    })
    status: ConversationStatus;

    @Column({ type: 'int', default: 0 })
    unreadCount: number;

    @Column({ type: 'varchar', nullable: true })
    lastMessageId: string;

    @ManyToOne(() => WhatsappMessageEntity, { nullable: true })
    @JoinColumn({ name: 'lastMessageId' })
    lastMessage: Relation<WhatsappMessageEntity>;

    @Column({ type: 'enum', enum: MessageDirection, nullable: true })
    lastMessageDirection: MessageDirection;

    @Column({ type: 'enum', enum: WhatsappMessageType, nullable: true })
    lastMessageType: WhatsappMessageType;

    @Column({ type: 'text', nullable: true })
    lastMessagePreview: string;

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    lastMessageAt: Date;

    @Column({ type: 'timestamptz', nullable: true })
    lastIncomingMessageAt: Date;

    @Column({ type: 'timestamptz', nullable: true })
    lastOutgoingMessageAt: Date;

    @Column({ type: 'jsonb', nullable: true })
    metadata: any;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt: Date;

    // Optional reverse relation
    @OneToMany(() => WhatsappMessageEntity, (m) => m.conversation)
    messages: WhatsappMessageEntity[];
}

@Index(["adminId", "phoneNumberId"], { unique: true, where: `"phoneNumberId" IS NOT NULL` })
@Index(["adminId", "wabaId"], { unique: true, where: `"wabaId" IS NOT NULL` })
@Entity('whatsapp_accounts')
export class WhatsappAccountEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Column({ type: 'varchar', length: 255 })
    name: string;

    @Column({ type: 'varchar', length: 50, nullable: true })
    mobileNumber: string;

    @Column({ type: 'varchar', length: 100, nullable: true })
    phoneNumberId: string;

    @Column({ type: 'varchar', length: 100, nullable: true })
    wabaId: string;

    @Column({ type: 'varchar', nullable: true })
    businessId: string; // المعرف الفريد للقالب من طرف Meta

    @Column({ type: 'varchar', length: 100, nullable: true })
    appId: string;

    @Column({ type: 'varchar', length: 255, nullable: true, select: false })
    appSecret: string;

    @Column({ type: 'boolean', default: true })
    isActive: boolean;

    @Column({ type: 'boolean', default: false })
    isCreatedManual: boolean;

    // في ملف whatsapp-account.entity.ts
    @Column({ type: 'text', nullable: true, select: false })
    accessToken: string; // التوكن الخاص بـ Meta Graph API

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt: Date;
}

@Index(['name', 'language', 'accountId'], { unique: true })
@Index(['metaId'])
@Entity('whatsapp_templates')
export class WhatsappTemplateEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    accountId: string;

    // العلاقة مع حساب الواتساب
    @ManyToOne(() => WhatsappAccountEntity, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'accountId' })
    account: WhatsappAccountEntity;

    @Column({ type: 'varchar', length: 255 })
    name: string; // اسم القالب البرمجي في ميتا

    @Column({ type: 'varchar', length: 50, nullable: true })
    mobileNumber: string;

    @Column({
        type: 'enum',
        enum: TemplateCategory,
        default: TemplateCategory.UTILITY
    })
    category: TemplateCategory;

    @Column({ type: 'enum', enum: TemplateSubCategory, default: TemplateSubCategory.BOOKING_STATUS })
    subCategory: TemplateSubCategory;

    @Column({ type: 'varchar', length: 10 })
    language: "ar" | "en" | any; // مثال: 'ar' أو 'en'

    @Column({
        type: 'enum',
        enum: TemplateStatus,
        default: TemplateStatus.PENDING
    })
    status: TemplateStatus;

    @Column({ type: 'enum', enum: TemplateQuality, default: TemplateQuality.UNKNOWN })
    quality: TemplateQuality;

    @Column({ type: 'varchar', nullable: true })
    metaId: string; // المعرف الفريد للقالب من طرف Meta


    /**
     * Full template configuration object
     */
    @Column({
        type: "jsonb",
        nullable: true,
    })
    templateConfig: TemplateConfig;

    @Column({ type: 'boolean', default: true })
    isActive: boolean;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt: Date;
}

@Entity('whatsapp_messages')
export class WhatsappMessageEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
    @JoinColumn({ name: 'adminId' })
    admin: User;

    // 1. العلاقات (Relationships)
    @Index()
    @Column({ type: 'uuid' })
    accountId: string;

    @ManyToOne(() => WhatsappAccountEntity, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'accountId' })
    account: WhatsappAccountEntity;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    automationRunId: string; // 🌟 لربط الرسالة بمسار أتمتة معين إن وُجد

    // 2. معرفات ميتا (Meta Identifiers)
    @Index({ unique: true })
    @Column({ type: 'varchar', length: 255 })
    messageId: string; // الـ wamid الفريد القادم من Meta

    @Index()
    @Column({ type: 'varchar', length: 50 })
    contactNumber: string; // رقم هاتف العميل (سواء كان مرسلاً أو مستقبلاً)

    // 3. تفاصيل التوجيه والحالة (Routing & Status)
    @Column({ type: 'enum', enum: MessageDirection })
    direction: MessageDirection;

    @Index()
    @Column({ type: 'enum', enum: MessageStatus, default: MessageStatus.ACCEPTED })
    status: MessageStatus;

    @Column({ type: 'enum', enum: WhatsappMessageType, default: WhatsappMessageType.TEXT })
    messageType: WhatsappMessageType;

    // 4. المحتوى والأخطاء (Payloads)
    @Column({ type: 'jsonb', nullable: true })
    content: any; // محتوى الرسالة (النص، الزر المضغوط، تفاصيل القالب)

    @Column({ type: 'jsonb', nullable: true })
    metadata: any; // بيانات وصفية إضافية (Pricing, Conversation, Webhook details)

    @Column({ type: 'varchar', nullable: true })
    error: string; // لتخزين أخطاء Meta في حال كانت الحالة FAILED

    // 5. التوقيتات (Timestamps)
    @Column({ type: 'timestamptz', nullable: true })
    deliveredAt: Date; // يتحدث عبر الـ Webhook

    @Column({ type: 'timestamptz', nullable: true })
    readAt: Date; // يتحدث عبر الـ Webhook

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;

    @Column({ type: 'timestamptz', nullable: true })
    sentAt: Date;

    @Column({ type: 'timestamptz', nullable: true })
    failedAt: Date;

    @Column({ type: 'timestamptz', nullable: true })
    playedAt: Date;

    @Column({ type: 'bigint', nullable: true })
    metaTimestamp: number;

    @Column({ type: 'varchar', nullable: true })
    errorCode: string;

    @Column({ type: 'int', default: 0 })
    retryCount: number;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt: Date;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    conversationId: string;

    @ManyToOne(() => ConversationEntity, {
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'conversationId' })
    conversation: ConversationEntity;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    customerId: string;

    @ManyToOne(() => CustomerEntity, {
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'customerId' })
    customer: CustomerEntity;

    // --- New Relations for Reactions and Replies ---
    @Index()
    @Column({ type: 'uuid', nullable: true })
    replyToId: string;

    @ManyToOne(() => WhatsappMessageEntity, (m) => m.replies, { onDelete: 'SET NULL' })
    @JoinColumn({ name: 'replyToId' })
    replyTo: WhatsappMessageEntity;

    @OneToMany(() => WhatsappMessageEntity, (m) => m.replyTo)
    replies: WhatsappMessageEntity[];

    @Index()
    @Column({ type: 'uuid', nullable: true })
    reactionToId: string;

    @ManyToOne(() => WhatsappMessageEntity, (m) => m.reactions, { onDelete: 'SET NULL' })
    @JoinColumn({ name: 'reactionToId' })
    reactionTo: WhatsappMessageEntity;

    @OneToMany(() => WhatsappMessageEntity, (m) => m.reactionTo)
    reactions: WhatsappMessageEntity[];
}


@Entity('whatsapp_webhook_events')
export class WhatsappWebhookEventEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
    @JoinColumn({ name: 'adminId' })
    admin: User;

    // 1. العلاقات (Relationships)
    @Index()
    @Column({ type: 'uuid' })
    accountId: string;

    @ManyToOne(() => WhatsappAccountEntity, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'accountId' })
    account: WhatsappAccountEntity;

    @Index()
    @Column({ type: 'varchar', length: 100, nullable: true })
    wabaId: string; // لمعرفة الحساب التابع له فوراً

    @Index()
    @Column({ type: 'enum', enum: WebhookEventType })
    eventType: WebhookEventType; // 'message', 'delivery', 'read', 'react', etc.

    @Column({ type: 'jsonb' })
    rawPayload: any; // تخزين الـ body القادم من ميتا بالكامل كما هو دون تعديل

    @Column({
        type: 'enum',
        enum: WebhookEventStatus,
        default: WebhookEventStatus.PENDING
    })
    processingStatus: WebhookEventStatus;

    @Column({ type: 'text', nullable: true })
    processingError: string; // لتسجيل سبب الفشل إن حدث خطأ أثناء تشغيل الأتمتة

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;
}
