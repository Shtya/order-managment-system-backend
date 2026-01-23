// entities/purchase_return.entity.ts
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  Index, ManyToOne, JoinColumn, OneToMany
} from "typeorm";
import { User } from "./user.entity";
import { ProductVariantEntity } from "./sku.entity";
import { PurchaseReturnType, ReturnStatus } from "common/enums";

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

  @Column({ type: "int", nullable: true })
  safeId?: number | null;

  @Column({ type: "varchar", length: 40, default: PurchaseReturnType.CASH_REFUND })
  returnType!: PurchaseReturnType;

  @Column({ type: "varchar", length: 20, default: ReturnStatus.PENDING })
  status!: ReturnStatus;

  @Column({ type: "text", nullable: true })
  notes?: string;

  @Column({ type: "int", default: 0 })
  subtotal!: number;

  @Column({ type: "int", default: 0 })
  taxTotal!: number;

  @Column({ type: "int", default: 0 })
  totalReturn!: number;

  @Column({ type: "int", nullable: true })
  createdByUserId?: number | null;

  @ManyToOne(() => User, { nullable: true, eager: true })
  @JoinColumn({ name: "createdByUserId" })
  createdBy?: User | null;

  @OneToMany(() => PurchaseReturnInvoiceItemEntity, (x) => x.invoice, { cascade: true, eager: true })
  items!: PurchaseReturnInvoiceItemEntity[];

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

  @Column({ type: "int" })
  unitCost!: number;

  @Column({ type: "boolean", default: false })
  taxInclusive!: boolean;

  @Column({ type: "int", default: 5 })
  taxRate!: number;

  @Column({ type: "int", default: 0 })
  lineSubtotal!: number;

  @Column({ type: "int", default: 0 })
  lineTax!: number;

  @Column({ type: "int", default: 0 })
  lineTotal!: number;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}
