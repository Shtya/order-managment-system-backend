import { bigintTransformer } from "common/typeorm/bigint.transformer";
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  Relation,
  UpdateDateColumn,
} from "typeorm";

export interface PricingSnapshot {
  version: string;
  capturedAt: string;
  rawSettings: unknown;
}

export type DecisionReplay = {
  answers: unknown;
  modelVersion: string;
};

export type AuthorizeResult =
  | {
      authorized: true;
      authorizationId: string;
      reservationId: string;
      replay?: true;
      replayPayload?: DecisionReplay;
    }
  | {
      authorized: false;
      reason: "INSUFFICIENT_BALANCE";
      required: Micros;
      available: Micros;
    };

export interface AuthorizeInput {
  adminId: string;
  service: BillingServiceKey;
  operation: BillingOperationKey;
  idempotencyKey: string;
  estimatedUsage: unknown;
  context?: Record<string, string>;
}

export interface FinalizeInput {
  authorizationId: string;
  usage: unknown;
}

export interface ReleaseInput {
  authorizationId: string;
  reason?: string;
}


export enum BillingServiceKey {
  AI_DECISION = "ai_decision",
}

export enum BillingOperationKey {
  EVALUATE = "evaluate",
}

export enum BillingUnit {
  TOKEN = "token",
  ORDER = "order",
}

export enum AuthorizationStatus {
  AUTHORIZED = "authorized",
  AUTHORIZING = "authorizing",
  DECLINED = "declined",
  FINALIZED = "finalized",
  RELEASED = "released",
  EXPIRED = "expired",
}

export enum CollectionStatus {
  COLLECTED = "collected",
  UNCOLLECTED = "uncollected",
}

// 1 currency unit = 1,000,000 micros. 1 token at $1/1M = exactly 1 micro-dollar.
export type Micros = bigint;

export interface AllowanceGrant {
  unit: BillingUnit;
  remainingUnits: bigint;
}

export interface AuthorizationRequirement {
  maxAmount: Micros;
  maxUnits: { unit: BillingUnit; quantity: bigint };
}

export interface ChargeLine {
  meter: string;
  unit: BillingUnit;
  quantity: bigint;
  freeQuantity: bigint;
  unitPricePerMillion: Micros;
  amount: Micros;
}

export interface ChargeResult {
  lines: ChargeLine[];
  grossAmount: Micros;
  payableAmount: Micros;
  allowanceUnitsConsumed: bigint;
}

@Entity({ name: "billing_authorizations" })
@Index("UQ_billing_authorizations_tenant_idempotency", ["adminId", "idempotencyKey"], {
  unique: true,
})
@Index("IDX_billing_authorizations_status_expiresAt", ["status", "expiresAt"])
@Check(`"reservedAmount" >= 0`)
export class BillingAuthorizationEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  adminId: string;

  @Column({
    type: "enum",
    enum: BillingServiceKey,
  })
  service: BillingServiceKey;

  @Column({
    type: "enum",
    enum: BillingOperationKey,
  })
  operation: BillingOperationKey;

  @Column({ type: "varchar" })
  idempotencyKey: string;

  @Column({
    type: "enum",
    enum: AuthorizationStatus,
  })
  status: AuthorizationStatus;

  @Column({ type: "varchar" })
  pricingVersion: string;

  @Column({ type: "jsonb" })
  pricingSnapshot: Record<string, unknown>;

  @Column({ type: "jsonb" })
  estimatedUsage: unknown;

  @Column({ type: "bigint", transformer: bigintTransformer, default: 0 })
  estimatedAmount: Micros;

  @Column({ type: "bigint", transformer: bigintTransformer, default: 0 })
  reservedAmount: Micros;

  @Column({ type: "varchar", nullable: true })
  reservationId: string | null;

  @Column({ type: "bigint", transformer: bigintTransformer, default: 0 })
  allowanceReservedUnits: bigint;

  @Column({ type: "jsonb", nullable: true })
  context: Record<string, string> | null;

  @Column({ type: "timestamptz" })
  expiresAt: Date;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  finalizedAt: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  releasedAt: Date | null;

  @Column({ type: "varchar", nullable: true })
  releaseReason: string | null;

  @OneToOne(() => BillingChargeEntity, (charge) => charge.authorization)
  charge?: Relation<BillingChargeEntity>;
}

@Entity({ name: "billing_charges" })
export class BillingChargeEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index("UQ_billing_charges_authorizationId", { unique: true })
  @Column({ type: "uuid" })
  authorizationId: string;

  @OneToOne(() => BillingAuthorizationEntity, (auth) => auth.charge, {
    onDelete: "RESTRICT",
  })
  @JoinColumn({ name: "authorizationId" })
  authorization: Relation<BillingAuthorizationEntity>;

  @Index()
  @Column({ type: "uuid" })
  adminId: string;

  @Column({
    type: "enum",
    enum: BillingServiceKey,
  })
  service: BillingServiceKey;

  @Column({
    type: "enum",
    enum: BillingOperationKey,
  })
  operation: BillingOperationKey;

  @Column({ type: "jsonb" })
  actualUsage: unknown;

  @Column({ type: "jsonb" })
  chargeLines: ChargeLine[];

  @Column({ type: "bigint", transformer: bigintTransformer, default: 0 })
  grossAmount: Micros;

  @Column({ type: "bigint", transformer: bigintTransformer, default: 0 })
  payableAmount: Micros;

  @Column({ type: "bigint", transformer: bigintTransformer, default: 0 })
  capturedAmount: Micros;

  @Column({ type: "bigint", transformer: bigintTransformer, default: 0 })
  overageAmount: Micros;

  @Column({ type: "bigint", transformer: bigintTransformer, default: 0 })
  allowanceUnitsConsumed: bigint;

  @Column({ type: "varchar", default: "USD" })
  currency: string;

  @Column({
    type: "enum",
    enum: CollectionStatus,
    default: CollectionStatus.COLLECTED,
  })
  collectionStatus: CollectionStatus;

  @Column({ type: "uuid", nullable: true })
  walletTransactionId: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}

@Entity({ name: "billing_allowance_usage" })
@Index("UQ_billing_allowance_usage_admin_op", ["adminId", "service", "operation"], {
  unique: true,
})
@Check(`"usedUnits" >= 0`)
@Check(`"reservedUnits" >= 0`)
export class BillingAllowanceUsageEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  adminId: string;

  @Column({
    type: "enum",
    enum: BillingServiceKey,
  })
  service: BillingServiceKey;

  @Column({
    type: "enum",
    enum: BillingOperationKey,
    enumName: "billing_operation_key",
  })
  operation: BillingOperationKey;

  @Column({ type: "bigint", transformer: bigintTransformer, default: 0 })
  usedUnits: bigint;

  @Column({ type: "bigint", transformer: bigintTransformer, default: 0 })
  reservedUnits: bigint;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}
