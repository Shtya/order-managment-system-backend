// entities/purchase.entity.ts
import {
	Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
	Index, ManyToOne, JoinColumn, OneToMany
} from "typeorm";
import { User } from "./user.entity";
import { ProductVariantEntity } from "./sku.entity";
import { ApprovalStatus } from "common/enums";
import { SupplierEntity } from "./supplier.entity";

@Entity({ name: "purchase_invoices" })
@Index(["adminId", "receiptNumber"], { unique: true })
export class PurchaseInvoiceEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	@Index()
	adminId!: string;

	@Column({ type: "int", nullable: true })
	@Index()
	supplierId?: number | null;

	@ManyToOne(() => SupplierEntity, { nullable: true, eager: false, onDelete: "SET NULL" })
	@JoinColumn({ name: "supplierId" })
	supplier?: SupplierEntity | null;

	@Column({ type: "varchar", length: 120 })
	receiptNumber!: string;


	@Column({ type: "text", nullable: true })
	receiptAsset?: any | null;

	@Column({ type: "text", nullable: true })
	safeId?: any | null;

	@Column({ type: "int", default: 0 })
	paidAmount!: number;

	@Column({ type: "int", default: 0 })
	subtotal!: number;

	@Column({ type: "int", default: 0 })
	total!: number;

	@Column({ type: "int", default: 0 })
	remainingAmount!: number;

	@Column({ type: "varchar", length: 20, default: ApprovalStatus.PENDING })
	status!: ApprovalStatus;

	@Column({ type: "text", nullable: true })
	notes?: string;

	@OneToMany(() => PurchaseInvoiceItemEntity, (x) => x.invoice, { cascade: true, eager: true })
	items!: PurchaseInvoiceItemEntity[];

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;

	@UpdateDateColumn({ type: "timestamptz" })
	updated_at!: Date;
}

@Entity({ name: "purchase_invoice_items" })
@Index(["adminId", "invoiceId"])
export class PurchaseInvoiceItemEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	@Index()
	adminId!: string;

	@Column({ type: "int" })
	@Index()
	invoiceId!: number;

	@ManyToOne(() => PurchaseInvoiceEntity, (x) => x.items, { onDelete: "CASCADE" })
	@JoinColumn({ name: "invoiceId" })
	invoice!: PurchaseInvoiceEntity;

	@Column({ type: "int" })
	@Index()
	variantId!: number;

	@ManyToOne(() => ProductVariantEntity, { eager: true, onDelete: "RESTRICT" })
	@JoinColumn({ name: "variantId" })
	variant!: ProductVariantEntity;

	@Column({ type: "int" })
	quantity!: number;

	@Column({ type: "int" })
	purchaseCost!: number;

	@Column({ type: "int", default: 0 })
	lineSubtotal!: number;

	@Column({ type: "int", default: 0 })
	lineTotal!: number;

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;
}




export enum PurchaseAuditAction {
	CREATED = "created",
	UPDATED = "updated",
	STATUS_CHANGED = "status_changed",
	PAID_AMOUNT_UPDATED = "paid_amount_updated",
	STOCK_APPLIED = "stock_applied",
	STOCK_REMOVED = "stock_removed",
	DELETED = "deleted",
}

@Entity({ name: "purchase_audit_logs" })
@Index(["adminId", "invoiceId"])
@Index(["invoiceId", "created_at"])
export class PurchaseAuditLogEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	@Index()
	adminId!: string;

	@Column({ type: "int" })
	@Index()
	invoiceId!: number;

	@ManyToOne(() => PurchaseInvoiceEntity, { onDelete: "CASCADE" })
	@JoinColumn({ name: "invoiceId" })
	invoice!: PurchaseInvoiceEntity;

	@Column({ type: "int", nullable: true })
	@Index()
	userId?: number | null;

	@ManyToOne(() => User, { eager: true, nullable: true })
	@JoinColumn({ name: "userId" })
	user?: User | null;

	@Column({ type: "varchar", length: 50 })
	@Index()
	action!: PurchaseAuditAction;

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

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;
}