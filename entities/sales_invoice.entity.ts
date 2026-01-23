// entities/sales_invoice.entity.ts
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  Index, ManyToOne, JoinColumn, OneToMany
} from "typeorm";
import { User } from "./user.entity";
import { ProductVariantEntity } from "./sku.entity";
import { PaymentMethod, PaymentStatus } from "common/enums";

@Entity({ name: "sales_invoices" })
@Index(["adminId", "invoiceNumber"], { unique: true })
export class SalesInvoiceEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  adminId!: string;

  @Column({ type: "varchar", length: 120 })
  invoiceNumber!: string; // your UI shows codes like KJCS5 etc.

  @Column({ type: "varchar", length: 200 })
  customerName!: string;

  @Column({ type: "varchar", length: 50, nullable: true })
  phone?: string | null;

  @Column({ type: "varchar", length: 30, nullable: true })
  paymentMethod?: PaymentMethod | null;

  @Column({ type: "varchar", length: 30, default: PaymentStatus.UNPAID })
  paymentStatus!: PaymentStatus;

  @Column({ type: "int", nullable: true })
  safeId?: number | null;

  @Column({ type: "text", nullable: true })
  notes?: string;

  // totals
  @Column({ type: "int", default: 0 })
  subtotal!: number;

  @Column({ type: "int", default: 0 })
  taxTotal!: number;

  @Column({ type: "int", default: 0 })
  shippingCost!: number;

  @Column({ type: "int", default: 0 })
  discountTotal!: number;

  @Column({ type: "int", default: 0 })
  total!: number;

  @Column({ type: "int", default: 0 })
  paidAmount!: number;

  @Column({ type: "int", default: 0 })
  remainingAmount!: number;

  @Column({ type: "int", nullable: true })
  createdByUserId?: number | null;

  @ManyToOne(() => User, { nullable: true, eager: true })
  @JoinColumn({ name: "createdByUserId" })
  createdBy?: User | null;

  @OneToMany(() => SalesInvoiceItemEntity, (x) => x.invoice, { cascade: true, eager: true })
  items!: SalesInvoiceItemEntity[];

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at!: Date;
}

@Entity({ name: "sales_invoice_items" })
@Index(["adminId", "invoiceId"])
export class SalesInvoiceItemEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  adminId!: string;

  @Column({ type: "int" })
  @Index()
  invoiceId!: number;

  @ManyToOne(() => SalesInvoiceEntity, (x) => x.items, { onDelete: "CASCADE" })
  @JoinColumn({ name: "invoiceId" })
  invoice!: SalesInvoiceEntity;

  @Column({ type: "int" })
  @Index()
  variantId!: number;

  @ManyToOne(() => ProductVariantEntity, { eager: true, onDelete: "RESTRICT" })
  @JoinColumn({ name: "variantId" })
  variant!: ProductVariantEntity;

  @Column({ type: "int" })
  quantity!: number;

  @Column({ type: "int" })
  unitPrice!: number;

  @Column({ type: "int", default: 0 })
  discount!: number; // per line

  @Column({ type: "boolean", default: false })
  taxInclusive!: boolean;

  @Column({ type: "int", default: 0 })
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
