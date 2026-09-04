import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    OneToMany,
    PrimaryGeneratedColumn,
    Relation,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { ProductEntity, ProductVariantEntity } from './sku.entity';
import { CustomerEntity } from './customers.entity';
import { ClientEntity } from './clients.entity';
import { OrderEntity } from './order.entity';
import { WhatsappMessageEntity, WhatsappTemplateEntity } from './whatsapp.entity';
import type { SendWhatsappTemplateConfig } from './automation.entity';
import { ClientSegmentEntity } from './clients-segments.entity';
import type { ClientAudienceFilter } from 'common/client-audience-filter.types';
export {
    ClientAudienceAssignmentField as CampaignAudienceAssignmentField,
    ClientAudienceClientField as CampaignAudienceClientField,
    ClientAudienceEntity as CampaignAudienceEntity,
    ClientAudienceOrderField as CampaignAudienceOrderField,
    ClientAudienceOrderItemField as CampaignAudienceOrderItemField,
    ClientAudienceProductField as CampaignAudienceProductField,
    ClientAudienceShipmentField as CampaignAudienceShipmentField,
    ClientAudienceUpsellField as CampaignAudienceUpsellField,
    ClientAudienceValueType as CampaignAudienceValueType,
    ClientAudienceVariantField as CampaignAudienceVariantField,
} from 'common/client-audience-filter.types';
export type {
    ClientAudienceGroup as CampaignAudienceGroup,
    ClientAudienceNode as CampaignAudienceNode,
    ClientAudienceRecipient as CampaignAudienceRecipient,
    ClientAudienceRule as CampaignAudienceRule,
} from 'common/client-audience-filter.types';

export type CampaignAudienceFilter = ClientAudienceFilter;

export enum CampaignCategory {
    // --- Existing Types ---
    UPSELL = 'upsell', // Offers customers an upgraded or higher-end version of a product
    CUSTOMER_REACTIVATION = 'customer_reactivation', // Re-engages dormant or churned customers with tailored incentives
    GENERAL_MARKETING = 'general_marketing', // Broad, non-segmented promotional campaigns for general brand awareness

    // --- Found in Screenshots ---
    ANNOUNCEMENT = 'announcement', // Shares company updates, news, or feature releases
    FOLLOW_UP = 'follow_up', // Checks in with customers after an interaction, support ticket, or delivery
    PROMOTIONAL = 'promotional', // General sales messages, seasonal discounts, or flash sales
    REMINDER = 'reminder', // Alerts users about upcoming events, expiring points, or pending actions
    WELCOME = 'welcome', // Greets new subscribers or customers with onboarding details and perks
    WIN_BACK = 'win_back', // Targets lost or highly inactive customers to bring them back into the sales funnel

    // --- Additional Industry-Standard Types ---
    BACK_IN_STOCK = 'back_in_stock', // Notifies customers when a previously out-of-stock item is available again
    VIP_EXCLUSIVE = 'vip_exclusive', // Targets high-value customers with early access to sales or special gifts
    EVENT_INVITATION = 'event_invitation', // Invites recipients to webinars, workshops, or physical store events
    REORDER_REPLENISHMENT = 'reorder_replenishment', // Reminds users to restock consumable goods before they run out
    EDUCATIONAL_NURTURE = 'educational_nurture', // Delivers useful tips, guides, and tutorials without a direct sales push
}
export enum CampaignStatus {
    DRAFT = 'draft',
    SCHEDULED = 'scheduled',
    RUNNING = 'running',
    PAUSED = 'paused',
    COMPLETED = 'completed',
    CANCELLED = 'cancelled',
    FAILED = 'failed',
}

export enum CampaignChannel {
    WHATSAPP = 'whatsapp',
    EMAIL = 'email',
    SMS = 'sms',
}

export enum CampaignAudienceType {
    CUSTOMERS = 'customers',
    SEGMENT = 'segment',
    FILE = 'file',
    MANUAL = 'manual',
}

export enum CampaignExclusionType {
    CLIENT = 'client',
    PHONE_NUMBER = 'phone_number',
}

export enum CampaignScheduleMode {
    NOW = 'now',
    SCHEDULED = 'scheduled',
}

export enum CampaignRecipientDeliveryStatus {
    PENDING = 'pending',
    ACCEPTED = 'accepted',
    SENT = 'sent',
    DELIVERED = 'delivered',
    READ = 'read',
    FAILED = 'failed',
}

export type CampaignTemplateConfigSnapshot = Pick<
    SendWhatsappTemplateConfig,
    | 'templateData'
    | 'headerUrl'
    | 'useOrderFirstItemImage'
    | 'bodyVariables'
    | 'headerVariables'
    | 'buttonVariables'
    | 'locationData'
>;

@Index(['adminId', 'name'])
@Index(['adminId', 'status'])
@Index(['adminId', 'category'])
@Index(['adminId', 'channel'])
@Entity('campaigns')
export class CampaignEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' })
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Column({ type: 'varchar', length: 255 })
    name: string;

    @Column({
        type: 'enum',
        enum: CampaignCategory,
        default: CampaignCategory.GENERAL_MARKETING,
    })
    category: CampaignCategory;

    @Column({ type: 'text', nullable: true })
    description?: string;

    @Column({
        type: 'enum',
        enum: CampaignChannel,
        default: CampaignChannel.WHATSAPP,
    })
    channel: CampaignChannel;

    @Column({
        type: 'enum',
        enum: CampaignStatus,
        default: CampaignStatus.DRAFT,
    })
    status: CampaignStatus;

    // ==========================================
    // Offer / shipment snapshot
    // ==========================================

    @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
    shippingPrice: number;

    @Column({ type: 'boolean', default: true })
    enablePurchasePage: boolean;
    // ==========================================
    // Audience
    // ==========================================

    @Column({
        type: 'enum',
        enum: CampaignAudienceType,
        default: CampaignAudienceType.CUSTOMERS,
    })
    audienceType: CampaignAudienceType;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    audienceSegmentId?: string | null;

    @ManyToOne(() => ClientSegmentEntity, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'audienceSegmentId' })
    audienceSegment?: Relation<ClientSegmentEntity | null>;

    @Column({ type: 'varchar', length: 255, nullable: true })
    audienceFileUrl?: string | null;

    @Column({ type: 'jsonb', nullable: true })
    audienceFilter?: CampaignAudienceFilter | null;

    @Column({ type: 'int', default: 0 })
    estimatedRecipientsCount: number;

    @Column({ type: 'int', default: 0 })
    recipientsCount: number;

    @Column({ type: 'int', default: 0 })
    excludedRecipientsCount: number;

    // ==========================================
    // Channel message / WhatsApp template
    // ==========================================

    @Index()
    @Column({ type: 'uuid', nullable: true })
    templateId?: string | null;

    @ManyToOne(() => WhatsappTemplateEntity, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'templateId' })
    template?: WhatsappTemplateEntity | null;

    @Column({ type: 'jsonb', nullable: true })
    templateConfigSnapshot?: CampaignTemplateConfigSnapshot | null;

    // ==========================================
    // Schedule & sending
    // ==========================================

    @Column({
        type: 'enum',
        enum: CampaignScheduleMode,
        default: CampaignScheduleMode.NOW,
    })
    scheduleMode: CampaignScheduleMode;

    @Column({ type: 'timestamptz', nullable: true })
    scheduledAt?: Date | null;

    @Column({ type: 'varchar', length: 8, nullable: true })
    workingHoursStart?: string | null;

    @Column({ type: 'varchar', length: 8, nullable: true })
    workingHoursEnd?: string | null;

    // Minimum allowed: 15 seconds
    @Column({ type: 'int', default: 30 })
    delayMinSeconds: number;

    @Column({ type: 'int', default: 90 })
    delayMaxSeconds: number;

    @Column({ type: 'int', nullable: true })
    maxMessagesPerHour?: number | null;

    @Column({ type: 'timestamptz', nullable: true })
    startedAt?: Date | null;

    @Column({ type: 'timestamptz', nullable: true })
    pausedAt?: Date | null;

    @Column({ type: 'timestamptz', nullable: true })
    completedAt?: Date | null;

    @Column({ type: 'timestamptz', nullable: true })
    cancelledAt?: Date | null;

    @Column({ type: 'timestamptz', nullable: true })
    failedAt?: Date | null;

    @Column({ type: 'text', nullable: true })
    failureReason?: string | null;

    // ==========================================
    // Denormalized results (list + KPI header)
    // ==========================================

    @Column({ type: 'int', default: 0 })
    sentCount: number;

    @Column({ type: 'int', default: 0 })
    deliveredCount: number;

    @Column({ type: 'int', default: 0 })
    readCount: number;

    @Column({ type: 'int', default: 0 })
    repliedCount: number;

    @Column({ type: 'int', default: 0 })
    ordersCount: number;

    @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
    salesAmount: number;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt: Date;

    @OneToMany(() => CampaignProductEntity, (product) => product.campaign, {
        cascade: true,
    })
    products: CampaignProductEntity[];

    @OneToMany(() => CampaignRecipientEntity, (recipient) => recipient.campaign)
    recipients: CampaignRecipientEntity[];

    @OneToMany(() => CampaignExcludedRecipientEntity, (recipient) => recipient.campaign)
    excludedRecipients: CampaignExcludedRecipientEntity[];

    @OneToMany(() => OrderEntity, (order) => order.campaign)
    orders: Relation<OrderEntity[]>;
}

@Entity('campaign_products')
@Index(['campaignId', 'sortOrder'])
export class CampaignProductEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid' })
    campaignId: string;

    @ManyToOne(() => CampaignEntity, (campaign) => campaign.products, {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'campaignId' })
    campaign: CampaignEntity;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    productId?: string | null;

    @ManyToOne(() => ProductEntity, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'productId' })
    product?: ProductEntity | null;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    variantId?: string | null;

    @ManyToOne(() => ProductVariantEntity, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'variantId' })
    variant?: ProductVariantEntity | null;

    @Column({ type: 'varchar', length: 200 })
    name: string;

    //snapshot
    @Column({ type: 'varchar', length: 120, nullable: true })
    sku?: string | null;

    //snapshot
    @Column({ type: 'varchar', length: 500, nullable: true })
    image?: string | null;

    @Column({ type: 'int', default: 1 })
    quantity: number;

    @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
    price: number;

    @Column({ type: 'int', default: 0 })
    sortOrder: number;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt: Date;
}

@Index(['campaignId', 'phoneNumber'], { unique: true })
@Index(['campaignId', 'deliveryStatus'])
@Index(['adminId', 'phoneNumber'])
@Entity('campaign_recipients')
export class CampaignRecipientEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid' })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' })
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Index()
    @Column({ type: 'uuid' })
    campaignId: string;

    @ManyToOne(() => CampaignEntity, (campaign) => campaign.recipients, {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'campaignId' })
    campaign: CampaignEntity;

    @Column({
        type: 'enum',
        enum: CampaignAudienceType,
        default: CampaignAudienceType.CUSTOMERS,
    })
    source: CampaignAudienceType;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    customerId?: string | null;

    @ManyToOne(() => CustomerEntity, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'customerId' })
    customer?: CustomerEntity | null;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    clientId?: string | null;

    @ManyToOne(() => ClientEntity, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'clientId' })
    client?: ClientEntity | null;

    //snapshot
    @Column({ type: 'varchar', length: 50 })
    phoneNumber: string;

    //snapshot
    @Column({ type: 'varchar', length: 200, nullable: true })
    name?: string | null;

    @Column({
        type: 'enum',
        enum: CampaignRecipientDeliveryStatus,
        default: CampaignRecipientDeliveryStatus.PENDING,
    })
    deliveryStatus: CampaignRecipientDeliveryStatus;

    @Column({ type: 'boolean', default: false })
    isRead: boolean;

    @Column({ type: 'boolean', default: false })
    hasReplied: boolean;

    //external meta message id
    @Column({ type: 'varchar', length: 255, nullable: true })
    messageId?: string | null;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    whatsappMessageId?: string | null;

    @ManyToOne(() => WhatsappMessageEntity, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'whatsappMessageId' })
    whatsappMessage?: WhatsappMessageEntity | null;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    orderId?: string | null;

    @ManyToOne(() => OrderEntity, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'orderId' })
    order?: Relation<OrderEntity | null>;

    @Column({ type: 'timestamptz', nullable: true })
    sentAt?: Date | null;

    @Column({ type: 'timestamptz', nullable: true })
    deliveredAt?: Date | null;

    @Column({ type: 'timestamptz', nullable: true })
    readAt?: Date | null;

    @Column({ type: 'timestamptz', nullable: true })
    repliedAt?: Date | null;

    @Column({ type: 'timestamptz', nullable: true })
    failedAt?: Date | null;

    @Column({ type: 'text', nullable: true })
    failureReason?: string | null;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt: Date;
}

@Index(['campaignId', 'type', 'clientId'])
@Index(['campaignId', 'type', 'phoneNumber'])
@Index(['adminId', 'clientId'])
@Index(['adminId', 'phoneNumber'])
@Index(['campaignId', 'clientId'], {
    unique: true,
    where: '"clientId" IS NOT NULL',
})
@Index(['campaignId', 'phoneNumber'], {
    unique: true,
    where: '"phoneNumber" IS NOT NULL',
})
@Entity('campaign_excluded_recipients')
export class CampaignExcludedRecipientEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid' })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' })
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Index()
    @Column({ type: 'uuid' })
    campaignId: string;

    @ManyToOne(() => CampaignEntity, (campaign) => campaign.excludedRecipients, {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'campaignId' })
    campaign: CampaignEntity;

    @Column({
        type: 'enum',
        enum: CampaignExclusionType,
    })
    type: CampaignExclusionType;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    clientId?: string | null;

    @ManyToOne(() => ClientEntity, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'clientId' })
    client?: ClientEntity | null;

    @Column({ type: 'varchar', length: 50, nullable: true })
    phoneNumber?: string | null;

    @Column({ type: 'text', nullable: true })
    reason?: string | null;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;
}
