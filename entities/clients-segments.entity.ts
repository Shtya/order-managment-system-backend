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
} from "typeorm";
import { ClientAudienceFilter } from "common/client-audience-filter.types";
import { User } from "./user.entity";
import { ClientEntity } from "./clients.entity";
import { CustomerEntity } from "./customers.entity";

export enum ClientSegmentTemplateStatus {
  ACTIVE = "active",
  INACTIVE = "inactive",
}

@Index(["name"], { unique: true })
@Index(["status"])
@Entity("client_segment_templates")
export class ClientSegmentTemplateEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 160 })
  name: string;

  @Column({ type: "text", nullable: true })
  description?: string | null;

  @Column({
    type: "enum",
    enum: ClientSegmentTemplateStatus,
    default: ClientSegmentTemplateStatus.ACTIVE,
  })
  status: ClientSegmentTemplateStatus;

  @Column({ type: "jsonb" })
  audienceFilter: ClientAudienceFilter;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}

export enum ClientSegmentStatus {
  ACTIVE = "active",
  INACTIVE = "inactive",
}

export enum ClientSegmentType {
  DYNAMIC = "dynamic",
  FROZEN = "frozen",
  FREEZING = "freezing",
  FREEZE_FAILED = "freeze_failed",
}

export type ClientSegmentAudienceFilter = ClientAudienceFilter;

@Index(["adminId", "name"], { unique: true })
@Index(["adminId", "status"])
@Index(["adminId", "type"])
@Entity("client_segments")
export class ClientSegmentEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  adminId: string;

  @ManyToOne(() => User, { onDelete: "SET NULL" })
  @JoinColumn({ name: "adminId" })
  admin: User;

  @Column({ type: "varchar", length: 160 })
  name: string;

  @Column({ type: "text", nullable: true })
  description?: string | null;

  @Column({
    type: "enum",
    enum: ClientSegmentStatus,
    default: ClientSegmentStatus.ACTIVE,
  })
  status: ClientSegmentStatus;

  @Column({
    type: "enum",
    enum: ClientSegmentType,
    default: ClientSegmentType.DYNAMIC,
  })
  type: ClientSegmentType;

  @Column({ type: "jsonb" })
  audienceFilter: ClientSegmentAudienceFilter;

  @Column({ type: "int", default: 0 })
  estimatedRecipientsCount: number;

  @Column({ type: "int", default: 0 })
  frozenRecipientsCount: number;

  @Column({ type: "timestamptz", nullable: true })
  frozenAt?: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;

  @OneToMany(() => ClientSegmentRecipientEntity, (recipient) => recipient.segment)
  recipients: Relation<ClientSegmentRecipientEntity[]>;
}

@Index(["adminId", "clientId"])
@Index(["adminId", "customerId"])
@Index("IDX_client_segment_recipients_segment_client", ["segmentId", "clientId"], {
  unique: true,
})
@Entity("client_segment_recipients")
export class ClientSegmentRecipientEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  adminId: string;

  @ManyToOne(() => User, { onDelete: "SET NULL" })
  @JoinColumn({ name: "adminId" })
  admin: User;

  @Index()
  @Column({ type: "uuid" })
  segmentId: string;

  @ManyToOne(() => ClientSegmentEntity, (segment) => segment.recipients, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "segmentId" })
  segment: Relation<ClientSegmentEntity>;

  @Index()
  @Column({ type: "uuid", nullable: true })
  clientId?: string | null;

  @ManyToOne(() => ClientEntity, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "clientId" })
  client?: Relation<ClientEntity | null>;

  @Index()
  @Column({ type: "uuid", nullable: true })
  customerId?: string | null;

  @ManyToOne(() => CustomerEntity, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "customerId" })
  customer?: Relation<CustomerEntity | null>;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
