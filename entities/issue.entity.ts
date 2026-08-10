import { BeforeInsert, BeforeUpdate, Column, CreateDateColumn, DeleteDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, Relation, UpdateDateColumn } from 'typeorm';
import { Role, User } from './user.entity';
import { OrderEntity, slugify } from './order.entity';
import { CustomerEntity } from './customers.entity';


export enum IssueStatus {
  OPEN = "open",
  IN_PROGRESS = "in_progress",

  WAITING_FOR_EMPLOYEE = "waiting_for_employee",
  WAITING_FOR_CUSTOMER = "waiting_for_customer",
  WAITING_FOR_SHIPPING_COMPANY = "waiting_for_shipping_company",
  WAITING_FOR_WAREHOUSE = "waiting_for_warehouse",

  SOLVED = "solved",
  CANCELLED = "cancelled",
}

@Entity('issue_statuses')
@Index(['adminId', 'code'], { unique: true })
@Index(['adminId', 'nameEn'], { unique: true })
@Index(['adminId', 'nameAr'], { unique: true })
export class IssueStatusEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  adminId?: string | null; // Tenant owner – null for global system statuses

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Column({ type: 'varchar', length: 50 })
  nameEn: string; // e.g., "Under Investigation"

  @Column({ type: 'varchar', length: 50 })
  nameAr: string; // e.g., "قيد التحقيق"

  @Column({ type: 'varchar', length: 50 })
  code: string; // Slug, e.g., "under-investigation"

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'boolean', default: false })
  system: boolean; // If true, tenant cannot delete/edit this status

  @Column({ type: 'int', default: 0 })
  sortOrder: number; // For ordering in UI dropdowns

  @Column({ type: 'varchar', length: 7, default: '#6C5CE7' })
  color: string; // Hex colour for visual cues

  @OneToMany(() => IssueEntity, (issue) => issue.status)
  issues: IssueEntity[];

  @BeforeInsert()
  @BeforeUpdate()
  generateSlug() {
    if (this.nameEn && !this.system) {
      this.code = slugify(this.nameEn).slice(0, 50);
    }
  }

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

@Entity('issue_causes')
@Index(['adminId', 'nameEn'], { unique: true })
@Index(['adminId', 'nameAr'], { unique: true })
export class IssueCauseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  adminId?: string | null; // Tenant owner – null for global system causes

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Column({ type: 'varchar', length: 200 })
  nameEn: string; // e.g., "Client Not Responding"

  @Column({ type: 'varchar', length: 200 })
  nameAr: string; // e.g., "العميل لا يرد"

  @Column({ type: 'boolean', default: false })
  system: boolean; // If true, tenant cannot delete/edit this cause

  @Column({ type: 'int', default: 0 })
  sortOrder: number; // For ordering in UI dropdowns

  @OneToMany(() => IssueEntity, (issue) => issue.cause)
  issues: IssueEntity[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

export enum IssuePriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  URGENT = 'urgent',
}

@Entity('issues')
@Index(['adminId', 'statusId'])
@Index(['adminId', 'created_at'])
@Index(['adminId', 'due_at'])
@Index(['assignedRoleId', 'statusId'])
@Index(['orderId'])
@Index(['customerId'])
export class IssueEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ---------- Tenant ----------
  @Index()
  @Column({ type: 'uuid', nullable: false })
  adminId: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'adminId' })
  admin: User;

  // ---------- Creator (any user) ----------
  @Index()
  @Column({ type: 'uuid', nullable: false })
  createdByUserId: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'createdByUserId' })
  createdByUser: User;

  // ---------- Order (required) ----------
  @Column({ type: 'uuid', nullable: false })
  orderId: string;

  @ManyToOne(() => OrderEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'orderId' })
  order: OrderEntity;

  // ---------- Customer (optional) ----------
  @Column({ type: 'uuid', nullable: true })
  customerId?: string | null;

  @ManyToOne(() => CustomerEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'customerId' })
  customer?: CustomerEntity | null;

  // Denormalised customer info (for quick display and when customer is not in DB)
  @Column({ type: 'varchar', length: 100, nullable: true })
  customerName?: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  customerPhone?: string | null;

  // ---------- Assignment ----------
  // Assigned to a team (role) – required for routing
  @Index()
  @Column({ type: 'uuid', nullable: false })
  assignedRoleId: string;

  @ManyToOne(() => Role, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'assignedRoleId' })
  assignedRole: Role;

  // ---------- Issue details ----------
  @Column({ type: 'varchar', length: 250 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  // ---------- Time estimate ----------
  @Column({ type: 'int', nullable: true })
  estimatedMinutes?: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  due_at?: Date | null;

  // ---------- Status (customisable) ----------
  @Index()
  @Column({ type: 'uuid', nullable: false })
  statusId: string;

  @ManyToOne(() => IssueStatusEntity, (status) => status.issues, {eager: true, nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'statusId' })
  status: IssueStatusEntity;

  // ---------- Cause (optional) ----------
  @Index()
  @Column({ type: 'uuid', nullable: true })
  causeId?: string | null;

  @ManyToOne(() => IssueCauseEntity, (cause) => cause.issues, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'causeId' })
  cause?: IssueCauseEntity | null;

  // ---------- Priority ----------
  @Column({ type: 'enum', enum: IssuePriority, default: IssuePriority.MEDIUM })
  priority: IssuePriority;

  // ---------- Last message denormalisation ----------
  @Column({ type: 'timestamptz', nullable: true })
  last_message_at?: Date | null;

  @Column({ type: 'uuid', nullable: true })
  lastMessageByUserId?: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'lastMessageByUserId' })
  lastMessageByUser?: User | null;

  @Column({ type: 'uuid', nullable: true })
  lastMessageId?: string | null;

  @ManyToOne(() => IssueMessageEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'lastMessageId' })
  lastMessage?: Relation<IssueMessageEntity | null>;

  // ---------- Resolution / closure ----------
  @Column({ type: 'timestamptz', nullable: true })
  resolved_at?: Date | null;

  @Column({ type: 'uuid', nullable: true })
  resolvedByUserId?: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'resolvedByUserId' })
  resolvedByUser?: User | null;

  // ---------- Metadata ----------
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown> | null;

  // ---------- Timestamps ----------
  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deleted_at?: Date | null;

  // ---------- Relations ----------
  @OneToMany(() => IssueMessageEntity, (message) => message.issue)
  messages: IssueMessageEntity[];

  @OneToMany(() => IssueUserEntity, (issueUser) => issueUser.issue)
  users: IssueUserEntity[];
}

@Entity("issue_users")
@Index(["issueId", "userId"], { unique: true })
export class IssueUserEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: false })
  adminId: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Column({type: "int", default: 0})
  unreadUserCount: number;

  @Column({ type: "uuid" })
  issueId: string;

  @ManyToOne(() => IssueEntity, (issue) => issue.users, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "issueId" })
  issue: IssueEntity;

  @Column({ type: "uuid" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: User;

  // Per-user read state
  @Column({ type: "timestamptz", nullable: true })
  last_read_at: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  created_at: Date;
}

@Entity('issue_messages')
@Index(['adminId', 'issueId'])
@Index(['issueId', 'created_at'])
export class IssueMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: false })
  adminId: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Index()
  @Column({ type: 'uuid', nullable: false })
  issueId: string;

  @ManyToOne(() => IssueEntity, (issue) => issue.messages, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'issueId' })
  issue: IssueEntity;

  @Index()
  @Column({ type: 'uuid', nullable: false })
  senderId: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'senderId' })
  sender: User;

  // Message content (nullable if only attachments)
  @Column({ type: 'text', nullable: true })
  message?: string | null;

  // Flags
  @Column({ type: 'boolean', default: false })
  isInitialMessage: boolean;

  @Column({ type: 'boolean', default: false })
  isEdited: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  edited_at?: Date | null;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  deleted_at?: Date | null;

  @Column({ type: 'int', default: 0 })
  attachmentCount: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

export enum IssueActivityType {
  CREATED = 'created',
  STATUS_CHANGED = 'status_changed',
  PRIORITY_CHANGED = 'priority_changed',
  ASSIGNED = 'assigned',
  UNASSIGNED = 'unassigned',
  TIME_ESTIMATE_CHANGED = 'time_estimate_changed',
  DUE_DATE_CHANGED = 'due_date_changed',
  RESOLVED = 'resolved',
  CANCELED = 'canceled',
}

@Entity('issue_activities')
@Index(['issueId', 'created_at'])
@Index(['adminId', 'issueId'])
export class IssueActivityEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: false })
  adminId: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Index()
  @Column({ type: 'uuid', nullable: false })
  issueId: string;

  @ManyToOne(() => IssueEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'issueId' })
  issue: IssueEntity;

  @Column({ type: 'uuid', nullable: true })
  performedByUserId?: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'performedByUserId' })
  performedByUser?: User | null;

  @Column({ type: 'enum', enum: IssueActivityType })
  type: IssueActivityType;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}