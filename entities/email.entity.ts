import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { EmailRequest } from "../src/email/email.types";

@Entity("email_accounts")
@Index(["provider", "providerSubject"], { unique: true })
export class EmailAccountEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column("uuid")
  adminId: string;

  @Column("uuid")
  ownerId: string;

  @Column()
  provider: string;

  @Column()
  providerSubject: string;

  @Column({ default: "" })
  connectionName: string;

  @Column({ default: "oauth2" })
  authType: string;

  @Column()
  email: string;

  @Column({ default: "" })
  senderName: string;

  @Column({ nullable: true })
  smtpHost: string | null;

  @Column("integer", { nullable: true })
  smtpPort: number | null;

  @Column({ nullable: true })
  smtpSecurity: string | null;

  @Column({ nullable: true })
  smtpUsername: string | null;

  @Column({ default: "connected" })
  status: string;

  @Column("jsonb", { default: [] })
  scopes: string[];

  @Column("jsonb", { nullable: true, select: false })
  credentials: {
    ciphertext: string;
    iv: string;
    tag: string;
  } | null;

  @Column({ default: 1 })
  credentialVersion: number;

  @Column({ default: 0 })
  revokeAttempts: number;

  @Column("timestamptz", { nullable: true })
  cooldownUntil: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity("email_oauth_states")
export class EmailOAuthStateEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index({ unique: true })
  @Column()
  stateHash: string;

  @Column("uuid")
  adminId: string;

  @Column("uuid")
  ownerId: string;

  @Column("uuid", { nullable: true })
  accountId: string | null;

  @Column()
  bindingHash: string;

  @Column()
  nonce: string;

  @Column()
  verifier: string;

  @Column()
  returnTo: string;

  @Column("timestamptz")
  expiresAt: Date;
}

@Entity("email_messages")
@Index(["adminId", "idempotencyKey"], { unique: true })
@Index(["accountId", "createdAt"])
export class EmailMessageEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column("uuid")
  adminId: string;

  @Column("uuid")
  actorId: string;

  @Column("uuid")
  accountId: string;

  @Column()
  recipient: string;

  @Column()
  idempotencyKey: string;

  @Column()
  requestHash: string;

  @Column("jsonb", { select: false })
  request: EmailRequest;

  @Column({ default: "queued" })
  status: string;

  @Column({ nullable: true })
  providerMessageId: string | null;

  @Column({ nullable: true })
  reason: string | null;

  @Column({ default: 0 })
  attempts: number;

  /** Every dispatch cycle, including pre-provider deferrals. */
  @Column({ default: 0 })
  dispatchAttempts: number;

  @Column("timestamptz", { nullable: true })
  nextAttemptAt: Date | null;

  @Column("timestamptz", { nullable: true })
  acceptedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity("email_subscriptions")
@Index(["adminId", "email"], { unique: true })
export class EmailSubscriptionEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column("uuid")
  adminId: string;

  @Column()
  email: string;

  @Column({ default: false })
  consented: boolean;

  @Column({ default: false })
  suppressed: boolean;

  @Column({ nullable: true })
  reason: string | null;

  @Column({ nullable: true })
  evidence: string | null;

  @Column("uuid", { nullable: true })
  recordedBy: string | null;

  @Column("timestamptz", { nullable: true })
  consentedAt: Date | null;

  @Index({ unique: true })
  @Column()
  unsubscribeHash: string;

  @UpdateDateColumn()
  updatedAt: Date;
}
