import { bigintTransformer } from "common/typeorm/bigint.transformer";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

export enum AiUsageSource {
  WHATSAPP_AGENT = "whatsapp_agent",
  ADDRESS_CORRECTION = "address_correction",
  ADDRESS_CHECK = "address_check",
  MEDIA = "media",
  PLAYGROUND = "playground",
  COMPACTION = "compaction",
}

export enum AiUsageActor {
  SYSTEM = "system",
  DEVELOPER = "developer",
  CUSTOMER = "customer",
}

export enum AiUsageBilledBy {
  MADAR = "madar",
  MERCHANT = "merchant",
}

export enum AiUsageStatus {
  OK = "ok",
  FAILED = "failed",
  RELEASED = "released",
}

@Index("IDX_ai_usages_admin_createdAt", ["adminId", "createdAt"])
@Index("IDX_ai_usages_admin_source", ["adminId", "source"])
@Index("IDX_ai_usages_admin_billedBy", ["adminId", "billedBy"])
@Index("IDX_ai_usages_admin_modelCode", ["adminId", "modelCode"])
@Index("UQ_ai_usages_admin_idempotency", ["adminId", "idempotencyKey"], {
  unique: true,
  where: `"idempotencyKey" IS NOT NULL`,
})
@Index("UQ_ai_usages_chargeId", ["chargeId"], {
  unique: true,
  where: `"chargeId" IS NOT NULL`,
})
@Entity("ai_usages")
export class AiUsageEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  adminId: string;

  @Column({ type: "varchar", length: 40 })
  source: AiUsageSource;

  @Column({ type: "varchar", length: 80 })
  api: string;

  @Column({ type: "varchar", length: 20 })
  actor: AiUsageActor;

  @Column({ type: "varchar", length: 20 })
  billedBy: AiUsageBilledBy;

  @Column({ type: "varchar", length: 80, nullable: true })
  providerCode: string | null;

  @Column({ type: "varchar", length: 200, nullable: true })
  modelCode: string | null;

  @Column({ type: "int", default: 0 })
  inputTokens: number;

  @Column({ type: "int", default: 0 })
  outputTokens: number;

  @Column({ type: "int", default: 0 })
  audioSeconds: number;

  @Column({ type: "int", default: 1 })
  rounds: number;

  @Column({ type: "varchar", length: 20, default: AiUsageStatus.OK })
  status: AiUsageStatus;

  @Column({ type: "bigint", transformer: bigintTransformer, default: 0 })
  grossAmount: bigint;

  @Column({ type: "bigint", transformer: bigintTransformer, default: 0 })
  payableAmount: bigint;

  @Column({ type: "bigint", transformer: bigintTransformer, default: 0 })
  freeUnits: bigint;

  @Column({ type: "varchar", length: 8, default: "USD" })
  currency: string;

  @Column({ type: "uuid", nullable: true })
  chargeId: string | null;

  @Column({ type: "varchar", length: 200, nullable: true })
  idempotencyKey: string | null;

  @Column({ type: "uuid", nullable: true })
  requestId: string | null;

  @Column({ type: "uuid", nullable: true })
  sessionId: string | null;

  @Column({ type: "uuid", nullable: true })
  turnId: string | null;

  @Column({ type: "uuid", nullable: true })
  mediaUsageId: string | null;

  @Column({ type: "uuid", nullable: true })
  hostedModelId: string | null;

  @Column({ type: "uuid", nullable: true })
  agentId: string | null;

  @Column({ type: "uuid", nullable: true })
  conversationId: string | null;

  @Column({ type: "uuid", nullable: true })
  orderId: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
