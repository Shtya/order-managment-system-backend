import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { User } from "./user.entity";
import { OrderEntity, OrderStatusEntity } from "./order.entity";

export enum CancelCauseSource {
  ADMIN = "admin",
  EMPLOYEE = "employee",
}

export enum CancelCauseReviewStatus {
  APPROVED = "approved",
  PENDING = "pending",
  REJECTED = "rejected",
}

@Entity({ name: "cancel_causes" })
@Index(["adminId"])
@Index(["adminId", "reviewStatus", "isActive"])
@Index(["adminId", "normalizedName"])
@Index(["adminId", "code"])
export class CancelCauseEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  adminId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "adminId" })
  admin: User;

  @Column({ type: "varchar", length: 200 })
  name: string;

  @Column({ type: "varchar", length: 200 })
  normalizedName: string;

  @Column({ type: "varchar", length: 200 })
  code: string;

  @Column({ type: "text", nullable: true })
  description?: string | null;

  @Column({
    type: "varchar",
    length: 20,
    default: CancelCauseSource.ADMIN,
  })
  source: CancelCauseSource;

  @Column({
    type: "varchar",
    length: 20,
    default: CancelCauseReviewStatus.APPROVED,
  })
  reviewStatus: CancelCauseReviewStatus;

  @Column({ type: "boolean", default: true })
  isActive: boolean;

  @Column({ type: "int", default: 0 })
  sortOrder: number;

  @Column({ type: "uuid", nullable: true })
  submittedByEmployeeId?: string | null;

  @ManyToOne(() => User, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "submittedByEmployeeId" })
  submittedByEmployee?: User | null;

  @Column({ type: "uuid", nullable: true })
  reviewedById?: string | null;

  @ManyToOne(() => User, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "reviewedById" })
  reviewedBy?: User | null;

  @Column({ type: "timestamptz", nullable: true })
  reviewedAt?: Date | null;

  @Column({ type: "varchar", length: 500, nullable: true })
  reviewNote?: string | null;

  @Column({ type: "uuid", nullable: true })
  mergedIntoCauseId?: string | null;

  @ManyToOne(() => CancelCauseEntity, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "mergedIntoCauseId" })
  mergedIntoCause?: CancelCauseEntity | null;

  @OneToMany(() => OrderCancelCauseEntity, (occ) => occ.cancelCause)
  orderEvents: OrderCancelCauseEntity[];

  @CreateDateColumn({ type: "timestamptz" })
  created_at: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at: Date;
}

@Entity({ name: "order_cancel_causes" })
@Index(["adminId", "created_at"])
@Index(["adminId", "cancelCauseId"])
@Index(["orderId"])
@Index(["adminId", "submittedByEmployeeId"])
export class OrderCancelCauseEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  adminId: string;

  @Column({ type: "uuid" })
  orderId: string;

  @ManyToOne(() => OrderEntity, (order) => order.cancelCauses, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "orderId" })
  order: OrderEntity;

  @Column({ type: "uuid" })
  cancelCauseId: string;

  @ManyToOne(() => CancelCauseEntity, (cause) => cause.orderEvents, {
    onDelete: "RESTRICT",
  })
  @JoinColumn({ name: "cancelCauseId" })
  cancelCause: CancelCauseEntity;

  @Column({ type: "varchar", length: 200 })
  causeNameSnapshot: string;

  @Column({ type: "varchar", length: 200, nullable: true })
  causeCodeSnapshot?: string | null;

  @Column({ type: "boolean", default: false })
  isCustomSubmission: boolean;

  @Column({ type: "uuid", nullable: true })
  submittedByEmployeeId?: string | null;

  @ManyToOne(() => User, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "submittedByEmployeeId" })
  submittedByEmployee?: User | null;

  @Column({ type: "uuid", nullable: true })
  statusHistoryId?: string | null;

  @Column({ type: "uuid" })
  toStatusId: string;

  @ManyToOne(() => OrderStatusEntity, { nullable: true })
  @JoinColumn({ name: "toStatusId" })
  toStatus?: OrderStatusEntity | null;

  @CreateDateColumn({ type: "timestamptz" })
  created_at: Date;
}
