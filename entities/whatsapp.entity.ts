import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    Index,
    ManyToOne,
    JoinColumn
} from 'typeorm';
import { User } from './user.entity';


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

    @Index({ unique: true, where: `"wabaId" IS NOT NULL` })
    @Column({ type: 'varchar', length: 100, nullable: true })
    phoneNumberId: string;

    @Index({ unique: true, where: `"wabaId" IS NOT NULL` })
    @Column({ type: 'varchar', length: 100, nullable: true })
    wabaId: string;

    @Column({ type: 'boolean', default: true })
    isActive: boolean;

    // في ملف whatsapp-account.entity.ts
    @Column({ type: 'text', nullable: true })
    accessToken: string; // التوكن الخاص بـ Meta Graph API

    @CreateDateColumn({ type: 'timestamp' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamp' })
    updatedAt: Date;
}

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
    @Column({ type: 'uuid' })
    accountId: string;

    // العلاقة مع حساب الواتساب
    @ManyToOne(() => WhatsappAccountEntity, { onDelete: 'SET NULL' })
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
    language: "ar" | "en"; // مثال: 'ar' أو 'en'

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

    @CreateDateColumn({ type: 'timestamp' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamp' })
    updatedAt: Date;
}