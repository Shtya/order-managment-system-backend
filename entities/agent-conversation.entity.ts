import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { bigintTransformer } from "common/typeorm/bigint.transformer";

export enum AgentSessionStatus {
  ACTIVE = "active",
  ENDED = "ended",
}

export enum AgentSummaryStatus {
  NONE = "none",
  PENDING = "pending",
  READY = "ready",
  FAILED = "failed",
}

export enum AgentTurnStatus {
  RUNNING = "running",
  OK = "ok",
  SILENT = "silent",
  FAILED = "failed",
  SKIPPED = "skipped",
}

export enum AgentPendingActionStatus {
  PENDING = "pending",
  EXECUTED = "executed",
  CANCELLED = "cancelled",
  REPLACED = "replaced",
  EXPIRED = "expired",
  FAILED = "failed",
}

export enum AgentPendingActionType {
  CAMPAIGN_ORDER = "campaign_order",
  ORDER = "order",
  ADDRESS_CORRECTION = "address_correction",
  ADD_ORDER_ITEMS = "add_order_items",
  REPLACE_ORDER_ITEMS = "replace_order_items",
  UPDATE_ORDER_ITEMS = "update_order_items",
  UPDATE_ORDER_INFO = "update_order_info",
  CANCEL_ORDER = "cancel_order",
  POSTPONE_ORDER = "postpone_order",
  CONFIRM_ORDER = "confirm_order",
  ADD_CUSTOMER_ADDRESS = "add_customer_address",
  REMOVE_CUSTOMER_ADDRESS = "remove_customer_address",
  UPDATE_CUSTOMER_ADDRESS = "update_customer_address",
  SET_DEFAULT_ADDRESS = "set_default_address",
  UPDATE_CUSTOMER = "update_customer",
}

export enum AgentTaskType {
  ADDRESS_CORRECTION = "address_correction",
}

export enum AgentTaskStatus {
  OPEN = "open",
  SUBMITTED = "submitted",
  COMPLETED = "completed",
  CLOSED = "closed",
}

@Index(["adminId", "conversationId", "status"])
@Entity("agent_sessions")
export class AgentSessionEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  adminId: string;

  @Index()
  @Column({ type: "uuid" })
  conversationId: string;

  @Column({ type: "uuid", nullable: true })
  customerId?: string | null;

  @Column({ type: "uuid", nullable: true })
  agentId?: string | null;

  @Column({ type: "varchar", length: 20, default: AgentSessionStatus.ACTIVE })
  status: AgentSessionStatus;

  @Column({ type: "timestamptz" })
  startedAt: Date;

  @Column({ type: "timestamptz" })
  lastMessageAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  endedAt?: Date | null;

  /** Business and customer information assembled once when the session starts. */
  @Column({ type: "text", nullable: true })
  bootstrap?: string | null;

  /** Running summary of this session's compacted turns (and, once ended, of the whole session). */
  @Column({ type: "text", nullable: true })
  summary?: string | null;

  /** Turns with seq <= this value are covered by `summary` and are no longer sent verbatim. */
  @Column({ type: "int", default: 0 })
  summarizedThroughSeq: number;

  /** Status of the end-of-session summary. */
  @Column({ type: "varchar", length: 20, default: AgentSummaryStatus.NONE })
  summaryStatus: AgentSummaryStatus;

  @Column({ type: "uuid", nullable: true })
  previousSessionId?: string | null;

  @Column({ type: "text", nullable: true })
  previousSummary?: string | null;

  @Column({ type: "int", default: 0 })
  turnCount: number;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}

@Index(["sessionId", "seq"])
@Entity("agent_turns")
export class AgentTurnEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  adminId: string;

  @Index()
  @Column({ type: "uuid" })
  sessionId: string;

  @Index()
  @Column({ type: "uuid" })
  conversationId: string;

  @Column({ type: "int" })
  seq: number;

  @Column({ type: "uuid", nullable: true })
  agentId?: string | null;

  @Column({ type: "uuid", nullable: true })
  accountId?: string | null;

  /** `whatsapp_messages.id` of every customer message batched into this turn. */
  @Column({ type: "jsonb", default: () => "'[]'" })
  messageIds: string[];

  @Column({ type: "varchar", length: 20, default: AgentTurnStatus.RUNNING })
  status: AgentTurnStatus;

  @Column({ type: "varchar", length: 40, nullable: true })
  endedBy?: string | null;

  @Column({ type: "varchar", length: 120, nullable: true })
  provider?: string | null;

  @Column({ type: "varchar", length: 200, nullable: true })
  model?: string | null;

  @Column({ type: "int", default: 0 })
  promptTokens: number;

  @Column({ type: "int", default: 0 })
  completionTokens: number;

  @Column({ type: "int", default: 0 })
  totalTokens: number;

  @Column({ type: "int", nullable: true })
  durationMs?: number | null;

  @Column({ type: "text", nullable: true })
  error?: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  finishedAt?: Date | null;
}

@Index(["turnId", "position"])
@Entity("agent_turn_messages")
export class AgentTurnMessageEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  turnId: string;

  @Index()
  @Column({ type: "uuid" })
  sessionId: string;

  @Column({ type: "int" })
  seq: number;

  @Column({ type: "int" })
  position: number;

  @Column({ type: "varchar", length: 20 })
  role: "user" | "assistant" | "tool";

  @Column({ type: "text", nullable: true })
  content?: string | null;

  @Column({ type: "jsonb", nullable: true })
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null;

  @Column({ type: "varchar", length: 200, nullable: true })
  toolCallId?: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}

@Index(["adminId", "customerId", "status"])
@Index(["adminId", "targetKey", "status"])
@Entity("agent_pending_actions")
export class AgentPendingActionEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  adminId: string;

  @Column({ type: "uuid" })
  conversationId: string;

  @Column({ type: "uuid" })
  customerId: string;

  @Column({ type: "varchar", length: 40 })
  type: AgentPendingActionType;

  /** What the action changes, e.g. `campaign:<recipientId>`; a new request for the same target replaces the old one. */
  @Column({ type: "varchar", length: 200 })
  targetKey: string;

  @Column({ type: "uuid", nullable: true })
  orderId?: string | null;

  @Column({ type: "jsonb", default: () => "'{}'" })
  payload: Record<string, any>;

  @Column({ type: "text" })
  summary: string;

  @Column({ type: "varchar", length: 20, default: AgentPendingActionStatus.PENDING })
  status: AgentPendingActionStatus;

  @Column({ type: "uuid" })
  createdInTurnId: string;

  /** Provider message id (wamid) of the summary + buttons message. */
  @Column({ type: "varchar", length: 255, nullable: true })
  summaryWamid?: string | null;

  @Column({ type: "jsonb", nullable: true })
  result?: Record<string, any> | null;

  @Column({ type: "text", nullable: true })
  error?: string | null;

  @Column({ type: "timestamptz" })
  expiresAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  confirmedAt?: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  executedAt?: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}

@Index(["adminId", "customerId"])
@Entity("agent_memory_facts")
export class AgentMemoryFactEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  adminId: string;

  @Column({ type: "uuid" })
  customerId: string;

  @Column({ type: "text" })
  fact: string;

  @Column({ type: "uuid", nullable: true })
  sourceTurnId?: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}

@Index(["conversationId", "status"])
@Index(["orderId", "status"])
@Index(["automationRunId", "status"])
@Entity("agent_tasks")
export class AgentTaskEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  adminId: string;

  @Index()
  @Column({ type: "uuid" })
  conversationId: string;

  @Column({ type: "uuid" })
  customerId: string;

  @Column({ type: "uuid", nullable: true })
  agentId?: string | null;

  @Column({ type: "uuid" })
  orderId: string;

  @Column({ type: "varchar", length: 40, default: AgentTaskType.ADDRESS_CORRECTION })
  type: AgentTaskType;

  @Column({ type: "varchar", length: 20, default: AgentTaskStatus.OPEN })
  status: AgentTaskStatus;

  @Index()
  @Column({ type: "uuid" })
  automationRunId: string;

  @Column({ type: "varchar", length: 120 })
  automationNodeId: string;

  @Column({ type: "jsonb", default: () => "'{}'" })
  payload: Record<string, any>;

  @Column({ type: "jsonb", nullable: true })
  result?: Record<string, any> | null;

  @Column({ type: "varchar", length: 120, nullable: true })
  closedReason?: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}

export enum AgentMediaUsageStatus {
  OK = "ok",
  FAILED = "failed",
}

export enum AgentMediaKind {
  IMAGE = "image",
  VIDEO = "video",
  DOCUMENT = "document",
  AUDIO = "audio",
}

@Index("UQ_agent_media_usages_messageId", ["messageId"], { unique: true })
@Index(["adminId", "createdAt"])
@Entity("agent_media_usages")
export class AgentMediaUsageEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  adminId: string;

  @Index()
  @Column({ type: "uuid" })
  agentId: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  conversationId?: string | null;

  @Column({ type: "uuid" })
  messageId: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  turnId?: string | null;

  @Column({ type: "varchar", length: 20 })
  kind: AgentMediaKind;

  @Column({ type: "varchar", length: 20 })
  status: AgentMediaUsageStatus;

  @Column({ type: "varchar", length: 80, nullable: true })
  errorCode?: string | null;

  @Column({ type: "varchar", length: 400, nullable: true })
  error?: string | null;

  @Column({ type: "int", default: 0 })
  inputTokens: number;

  @Column({ type: "int", default: 0 })
  outputTokens: number;

  @Column({ type: "int", default: 0 })
  audioSeconds: number;

  @Column({ type: "bigint", transformer: bigintTransformer, default: 0 })
  chargedAmount: bigint;

  @Column({ type: "uuid", nullable: true })
  authorizationId?: string | null;

  @Column({ type: "uuid", nullable: true })
  chargeId?: string | null;

  @Column({ type: "varchar", length: 120, nullable: true })
  visionModel?: string | null;

  @Column({ type: "varchar", length: 120, nullable: true })
  transcribeModel?: string | null;

  @Column({ type: "varchar", length: 120, nullable: true })
  documentModel?: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
