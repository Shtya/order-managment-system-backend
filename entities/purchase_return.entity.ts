// entities/purchase_return.entity.ts
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  Index, ManyToOne, JoinColumn, OneToMany,
  Relation
} from "typeorm";
import { User } from "./user.entity";
import { ProductVariantEntity } from "./sku.entity";
import { ApprovalStatus, PurchaseReturnType, ReturnStatus } from "common/enums";
import { MonthlyClosingEntity, SupplierClosingEntity } from "./accounting.entity";

@Entity({ name: "purchase_return_invoices" })
@Index(["adminId", "returnNumber"], { unique: true })
export class PurchaseReturnInvoiceEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  adminId!: string;

  @Column({ type: "varchar", length: 120 })
  returnNumber!: string; // auto or frontend (like SRF56)

  @Column({ type: "int", nullable: true })
  @Index()
  supplierId?: number | null;

  // optional snapshots (because your form has supplierName/code as inputs)
  @Column({ type: "varchar", length: 200, nullable: true })
  supplierNameSnapshot?: string | null;

  @Column({ type: "varchar", length: 120, nullable: true })
  supplierCodeSnapshot?: string | null;

  // reference purchase invoice receiptNumber (your UI: invoiceNumber)
  @Column({ type: "varchar", length: 120, nullable: true })
  invoiceNumber?: string | null;

  @Column({ type: "varchar", length: 80, nullable: true })
  returnReason?: string | null;

  @Column({ type: "text", nullable: true })
  safeId?: any | null;

  @Column({ type: "varchar", length: 40, default: PurchaseReturnType.CASH_REFUND, nullable: true })
  returnType!: PurchaseReturnType;

  @Column({ type: "varchar", length: 20, default: ApprovalStatus.PENDING })
  status!: ApprovalStatus;

  @Column({ type: "text", nullable: true })
  notes?: string;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  subtotal!: number;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  taxTotal!: number;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  totalReturn!: number;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  paidAmount!: number;

  @Column({ type: "varchar", length: 255, nullable: true })
  receiptAsset?: string | null;

  @Column({ type: "int", nullable: true })
  createdByUserId?: number | null;

  @ManyToOne(() => User, { nullable: true, eager: true })
  @JoinColumn({ name: "createdByUserId" })
  createdBy?: User | null;

  @OneToMany(() => PurchaseReturnInvoiceItemEntity, (x) => x.invoice, { cascade: true, eager: true })
  items!: PurchaseReturnInvoiceItemEntity[];

  @ManyToOne(() => SupplierClosingEntity, (closing) => closing.purchases, {
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'closingId' })
  closing: Relation<SupplierClosingEntity>;

  @Column({ nullable: true })
  @Index()
  closingId: number

  @CreateDateColumn({ type: "timestamptz" })
  statusUpdateDate!: Date;
  // Add this to your OrderEntity
  @Column({ nullable: true })
  monthlyClosingId: number | null;

  @ManyToOne(() => MonthlyClosingEntity)
  @JoinColumn({ name: 'monthlyClosingId' })
  monthlyClosing: Relation<MonthlyClosingEntity>;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at!: Date;
}

@Entity({ name: "purchase_return_invoice_items" })
@Index(["adminId", "invoiceId"])
export class PurchaseReturnInvoiceItemEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  adminId!: string;

  @Column({ type: "int" })
  @Index()
  invoiceId!: number;

  @ManyToOne(() => PurchaseReturnInvoiceEntity, (x) => x.items, { onDelete: "CASCADE" })
  @JoinColumn({ name: "invoiceId" })
  invoice!: PurchaseReturnInvoiceEntity;

  @Column({ type: "int" })
  @Index()
  variantId!: number;

  @ManyToOne(() => ProductVariantEntity, { eager: true, onDelete: "RESTRICT" })
  @JoinColumn({ name: "variantId" })
  variant!: ProductVariantEntity;

  @Column({ type: "int" })
  returnedQuantity!: number;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  unitCost!: number;

  @Column({ type: "boolean", default: false })
  taxInclusive!: boolean;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  taxRate!: number;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  lineSubtotal!: number;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  lineTax!: number;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  lineTotal!: number;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}

export enum PurchaseReturnAuditAction {
  CREATED = "created",
  UPDATED = "updated",
  STATUS_CHANGED = "status_changed",
  PAID_AMOUNT_UPDATED = "paid_amount_updated",
  STOCK_APPLIED = "stock_applied",
  STOCK_REMOVED = "stock_removed",
  DELETED = "deleted",
}

@Entity({ name: "purchase_return_audit_logs" })
@Index(["adminId", "invoiceId"])
@Index(["invoiceId", "created_at"])
export class PurchaseReturnAuditLogEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  adminId!: string;

  @Column({ type: "int" })
  @Index()
  invoiceId!: number;

  @ManyToOne(() => PurchaseReturnInvoiceEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "invoiceId" })
  invoice!: PurchaseReturnInvoiceEntity;

  @Column({ type: "int", nullable: true })
  @Index()
  userId?: number | null;

  @ManyToOne(() => User, { eager: true, nullable: true })
  @JoinColumn({ name: "userId" })
  user?: User | null;

  @Column({ type: "varchar", length: 50 })
  @Index()
  action!: PurchaseReturnAuditAction;

  @Column({ type: "jsonb", nullable: true })
  oldData?: any;

  @Column({ type: "jsonb", nullable: true })
  newData?: any;

  @Column({ type: "jsonb", nullable: true })
  changes?: any;

  @Column({ type: "text", nullable: true })
  description?: string;

  @Column({ type: "varchar", length: 50, nullable: true })
  ipAddress?: string;



  @Column({ nullable: true })
  @Index()
  closingId: number;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}
