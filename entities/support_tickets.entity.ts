import {
    Column,
    CreateDateColumn,
    DeleteDateColumn,
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


export enum SupportTicketStatus {
    OPEN = 'open',
    IN_PROGRESS = 'in_progress',
    WAITING_ON_CUSTOMER = 'waiting_on_customer',
    ON_HOLD = 'on_hold',
    RESOLVED = 'resolved',
    CLOSED = 'closed',
    REOPENED = 'reopened',
    CANCELED = 'canceled',
}

export enum SupportTicketPriority {
    LOW = 'low',
    MEDIUM = 'medium',
    HIGH = 'high',
    URGENT = 'urgent',
}

export enum SupportTicketAttachmentType {
    IMAGE = 'image',
    VIDEO = 'video',
    DOCUMENT = 'document',
}

export enum SupportTicketActivityType {
    CREATED = 'created',
    // MESSAGE_ADDED = 'message_added',
    STATUS_CHANGED = 'status_changed',
    PRIORITY_CHANGED = 'priority_changed',
    ASSIGNED = 'assigned',
    UNASSIGNED = 'unassigned',
    RESOLVED = 'resolved',
    CLOSED = 'closed',
    REOPENED = 'reopened',
    CANCELED = 'canceled',
    // ATTACHMENT_ADDED = 'attachment_added',
    // ATTACHMENT_DELETED = 'attachment_deleted',
}



@Entity({ name: 'support_tickets' })
@Index(['adminId', 'status'])
@Index(['adminId', 'created_at'])
@Index(['assignedSupportUserId', 'status'])
export class SupportTicketEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * Tenant owner of the ticket.
     *
     * This remains the tenant admin ID even when the ticket
     * is created by one of the admin's employees.
     */
    @Index()
    @Column({ type: 'uuid', nullable: false })
    adminId: string;

    @ManyToOne(() => User, {
        nullable: false,
        onDelete: 'RESTRICT',
    })
    @JoinColumn({ name: 'adminId' })
    admin: User;

    /**
     * The actual user who opened the ticket.
     * It may be the admin or one of their employees.
     */
    @Index()
    @Column({ type: 'uuid', nullable: false })
    createdByUserId: string;

    @ManyToOne(() => User, {
        nullable: false,
        onDelete: 'RESTRICT',
    })
    @JoinColumn({ name: 'createdByUserId' })
    createdByUser: User;

    /**
     * Super admin/support employee responsible for this ticket.
     * Null means the ticket has not been assigned yet.
     */
    @Index()
    @Column({ type: 'uuid', nullable: true })
    assignedSupportUserId?: string | null;

    @ManyToOne(() => User, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'assignedSupportUserId' })
    assignedSupportUser?: User | null;

    @Column({
        type: 'varchar',
        length: 250,
    })
    title: string;

    @Column({
        type: 'enum',
        enum: SupportTicketStatus,
        default: SupportTicketStatus.OPEN,
    })
    status: SupportTicketStatus;

    @Column({
        type: 'enum',
        enum: SupportTicketPriority,
        default: SupportTicketPriority.MEDIUM,
    })
    priority: SupportTicketPriority;

    @Column({ type: 'int', default: 0 })
    unreadUserCount: number;

    @Column({ type: 'int', default: 0 })
    unreadSupportCount: number;

    @Column({
        type: 'timestamptz',
        nullable: true,
    })
    lastMessageAt?: Date | null;
    
    @Column({
        type: 'uuid',
        nullable: true,
    })
    lastMessageByUserId?: string | null;

    @ManyToOne(() => User, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'lastMessageByUserId' })
    lastMessageByUser?: User | null;

    @Column({
        type: 'uuid',
        nullable: true,
    })
    lastMessageId?: string | null;

    @ManyToOne(() => SupportTicketMessageEntity, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'lastMessageId' })
    lastMessage?: Relation<SupportTicketMessageEntity | null> ;

    @Column({
        type: 'timestamptz',
        nullable: true,
    })
    solved_at?: Date | null;

    @Column({
        type: 'uuid',
        nullable: true,
    })
    solvedByUserId?: string | null;

    @ManyToOne(() => User, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'solvedByUserId' })
    solvedByUser?: User | null;

    @Column({
        type: 'timestamptz',
        nullable: true,
    })
    closed_at?: Date | null;

    @Column({
        type: 'uuid',
        nullable: true,
    })
    closedByUserId?: string | null;

    @ManyToOne(() => User, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'closedByUserId' })
    closedByUser?: User | null;

    @OneToMany(
        () => SupportTicketMessageEntity,
        (message) => message.ticket,
    )
    messages: SupportTicketMessageEntity[];

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at: Date;

    @DeleteDateColumn({ type: 'timestamptz' })
    deleted_at?: Date | null;
}

@Entity({ name: 'support_ticket_messages' })
@Index(['adminId', 'ticketId'])
@Index(['ticketId', 'created_at'])
@Index(['ticketId', 'isInitialMessage'])
export class SupportTicketMessageEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: false })
    adminId: string;

    @ManyToOne(() => User, {
        nullable: false,
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Index()
    @Column({ type: 'uuid', nullable: false })
    ticketId: string;

    @ManyToOne(
        () => SupportTicketEntity,
        (ticket) => ticket.messages,
        {
            nullable: false,
            onDelete: 'CASCADE',
        },
    )
    @JoinColumn({ name: 'ticketId' })
    ticket: SupportTicketEntity;

    /**
     * The actual sender:
     * tenant admin, employee, super admin, or support employee.
     */
    @Index()
    @Column({ type: 'uuid', nullable: false })
    senderId: string;

    @ManyToOne(() => User, {
        nullable: false,
        onDelete: 'RESTRICT',
    })
    @JoinColumn({ name: 'senderId' })
    sender: User;

    /**
     * Message can be null when the user sends attachments only.
     */
    @Column({
        type: 'text',
        nullable: true,
    })
    message?: string | null;

    /**
     * True for the first message created with the ticket.
     */
    @Column({
        type: 'boolean',
        default: false,
    })
    isInitialMessage: boolean;

    /**
     * Can be used for internal support notes that the customer cannot see.
     */
    @Column({
        type: 'boolean',
        default: false,
    })
    isInternalNote: boolean;

    @Column({
        type: 'boolean',
        default: false,
    })
    isEdited: boolean;

    @Column({
        type: 'timestamptz',
        nullable: true,
    })
    edited_at?: Date | null;

    @Column({
        type: 'boolean',
        default: false,
    })
    isDeleted: boolean;

    @Column({
        type: 'timestamptz',
        nullable: true,
    })
    deleted_at?: Date | null;

    @Column({ type: 'int', default: 0 })
    attachmentCount: number;

    @OneToMany(
        () => SupportTicketAttachmentEntity,
        (attachment) => attachment.message,
        {
            cascade: true,
        },
    )
    attachments: SupportTicketAttachmentEntity[];


    @Column({
        type: 'boolean',
        default: false,
    })
    isSupportMessage: boolean;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at: Date;
}

@Entity({ name: 'support_ticket_attachments' })
@Index(['adminId', 'ticketId'])
export class SupportTicketAttachmentEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: false })
    adminId: string;

    @ManyToOne(() => User, {
        nullable: false,
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Index()
    @Column({ type: 'uuid', nullable: false })
    ticketId: string;

    @ManyToOne(() => SupportTicketEntity, {
        nullable: false,
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'ticketId' })
    ticket: SupportTicketEntity;

    @Index()
    @Column({ type: 'uuid', nullable: false })
    messageId: string;

    @ManyToOne(
        () => SupportTicketMessageEntity,
        (message) => message.attachments,
        {
            nullable: false,
            onDelete: 'CASCADE',
        },
    )
    @JoinColumn({ name: 'messageId' })
    message: SupportTicketMessageEntity;

    /**
     * User who uploaded the attachment.
     */
    @Column({ type: 'uuid', nullable: false })
    uploadedByUserId: string;

    @ManyToOne(() => User, {
        nullable: false,
        onDelete: 'RESTRICT',
    })
    @JoinColumn({ name: 'uploadedByUserId' })
    uploadedByUser: User;

    @Column({
        type: 'enum',
        enum: SupportTicketAttachmentType,
        default: SupportTicketAttachmentType.IMAGE,
    })
    type: SupportTicketAttachmentType;

    /**
     * Original filename uploaded by the user.
     */
    @Column({
        type: 'varchar',
        length: 500,
    })
    originalName: string;

    /**
     * Public or signed URL.
     */
    @Column({
        type: 'text',
    })
    url: string;

    /**
     * Examples:
     * image/png
     * video/mp4
     * application/pdf
     */
    @Column({
        type: 'varchar',
        length: 255,
    })
    mimeType: string;

    /**
     * File size in bytes.
     *
     * bigint is returned as a string by PostgreSQL/TypeORM.
     */
    @Column({
        type: 'bigint',
    })
    size: string;

    /**
     * Optional thumbnail for images, screenshots, and videos.
     */
    @Column({
        type: 'text',
        nullable: true,
    })
    thumbnailUrl?: string | null;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;
}

@Entity({ name: 'support_ticket_activities' })
@Index(['ticketId', 'created_at'])
@Index(['adminId', 'ticketId'])
export class SupportTicketActivityEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: false })
    adminId: string;

    @ManyToOne(() => User, {
        nullable: false,
        onDelete: 'RESTRICT',
    })
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Index()
    @Column({ type: 'uuid', nullable: false })
    ticketId: string;

    @ManyToOne(() => SupportTicketEntity, {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'ticketId' })
    ticket: SupportTicketEntity;

    @Column({ type: 'uuid', nullable: true })
    performedByUserId?: string | null;

    @ManyToOne(() => User, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'performedByUserId' })
    performedByUser?: User | null;

    @Column({
        type: 'enum',
        enum: SupportTicketActivityType,
    })
    type: SupportTicketActivityType;

    @Column({ type: 'jsonb', nullable: true })
    metadata?: Record<string, unknown> | null;

    @Column({ type: 'boolean', default: true })
    isPublic: boolean;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;
}