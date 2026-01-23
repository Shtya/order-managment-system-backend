// entities/order.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from "typeorm";
import { ProductVariantEntity } from "./sku.entity";

// ✅ Order Status Enum
export enum OrderStatus {
  NEW = "new",
  UNDER_REVIEW = "under_review",
  PREPARING = "preparing",
  READY = "ready",
  SHIPPED = "shipped",
  DELIVERED = "delivered",
  CANCELLED = "cancelled",
  RETURNED = "returned",
}

// ✅ Payment Status Enum
export enum PaymentStatus {
  PENDING = "pending",
  PAID = "paid",
  PARTIAL = "partial",
  REFUNDED = "refunded",
}

// ✅ Payment Method Enum
export enum PaymentMethod {
  CASH = "cash",
  CARD = "card",
  BANK_TRANSFER = "bank_transfer",
  CASH_ON_DELIVERY = "cod",
}

// ✅ Main Order Entity
@Entity({ name: "orders" })
@Index(["adminId", "orderNumber"], { unique: true })
@Index(["adminId", "status"])
@Index(["adminId", "paymentStatus"])
@Index(["adminId", "created_at"])
export class OrderEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  adminId!: string;

  @Column({ type: "varchar", length: 100, unique: true })
  orderNumber!: string; // e.g., ORD-20250124-001

  // ✅ Customer Information
  @Column({ type: "varchar", length: 200 })
  customerName!: string;

  @Column({ type: "varchar", length: 50 })
  phoneNumber!: string;

  @Column({ type: "varchar", length: 200, nullable: true })
  email?: string;

  @Column({ type: "text" })
  address!: string;

  @Column({ type: "varchar", length: 100 })
  city!: string;

  @Column({ type: "varchar", length: 100, nullable: true })
  area?: string;

  // ✅ Order Status
  @Column({ type: "varchar", length: 50, default: OrderStatus.NEW })
  @Index()
  status!: OrderStatus;

  // ✅ Payment Information
  @Column({ type: "varchar", length: 50, default: PaymentMethod.CASH_ON_DELIVERY })
  paymentMethod!: PaymentMethod;

  @Column({ type: "varchar", length: 50, default: PaymentStatus.PENDING })
  @Index()
  paymentStatus!: PaymentStatus;

  // ✅ Shipping Information
  @Column({ type: "varchar", length: 100, nullable: true })
  shippingCompany?: string; // DHL, Aramex, etc.

  @Column({ type: "varchar", length: 100, nullable: true })
  trackingNumber?: string;

  @Column({ type: "timestamptz", nullable: true })
  shippedAt?: Date;

  @Column({ type: "timestamptz", nullable: true })
  deliveredAt?: Date;

  // ✅ Pricing
  @Column({ type: "int", default: 0 })
  productsTotal!: number; // Sum of all items

  @Column({ type: "int", default: 0 })
  shippingCost!: number;

  @Column({ type: "int", default: 0 })
  discount!: number;

  @Column({ type: "int", default: 0 })
  finalTotal!: number; // productsTotal + shippingCost - discount

  @Column({ type: "int", default: 0 })
  profit!: number; // finalTotal - totalCost

  // ✅ Notes
  @Column({ type: "text", nullable: true })
  notes?: string;

  @Column({ type: "text", nullable: true })
  customerNotes?: string;

  // ✅ Relations
  @OneToMany(() => OrderItemEntity, (item) => item.order, { cascade: true, eager: true })
  items!: OrderItemEntity[];

  @OneToMany(() => OrderStatusHistoryEntity, (history) => history.order)
  statusHistory!: OrderStatusHistoryEntity[];

  // ✅ Metadata
  @Column({ type: "int", nullable: true })
  createdByUserId?: number;

  @Column({ type: "int", nullable: true })
  updatedByUserId?: number;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at!: Date;
}

// ✅ Order Items Entity
@Entity({ name: "order_items" })
@Index(["adminId", "orderId"])
export class OrderItemEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  adminId!: string;

  @Column({ type: "int" })
  @Index()
  orderId!: number;

  @ManyToOne(() => OrderEntity, (order) => order.items, { onDelete: "CASCADE" })
  @JoinColumn({ name: "orderId" })
  order!: OrderEntity;

  @Column({ type: "int" })
  @Index()
  variantId!: number;

  @ManyToOne(() => ProductVariantEntity, { eager: true, onDelete: "RESTRICT" })
  @JoinColumn({ name: "variantId" })
  variant!: ProductVariantEntity;

  @Column({ type: "int" })
  quantity!: number;

  @Column({ type: "int" })
  unitPrice!: number; // Price at time of order

  @Column({ type: "int" })
  unitCost!: number; // Cost at time of order (for profit calculation)

  @Column({ type: "int", default: 0 })
  lineTotal!: number; // unitPrice * quantity

  @Column({ type: "int", default: 0 })
  lineProfit!: number; // (unitPrice - unitCost) * quantity

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}

// ✅ Order Status History Entity
@Entity({ name: "order_status_history" })
@Index(["adminId", "orderId"])
@Index(["orderId", "created_at"])
export class OrderStatusHistoryEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  adminId!: string;

  @Column({ type: "int" })
  @Index()
  orderId!: number;

  @ManyToOne(() => OrderEntity, (order) => order.statusHistory, { onDelete: "CASCADE" })
  @JoinColumn({ name: "orderId" })
  order!: OrderEntity;

  @Column({ type: "varchar", length: 50 })
  fromStatus!: OrderStatus;

  @Column({ type: "varchar", length: 50 })
  toStatus!: OrderStatus;

  @Column({ type: "int", nullable: true })
  changedByUserId?: number;

  @Column({ type: "text", nullable: true })
  notes?: string;

  @Column({ type: "varchar", length: 50, nullable: true })
  ipAddress?: string;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}

// ✅ Order Messages/Chat Entity
@Entity({ name: "order_messages" })
@Index(["adminId", "orderId"])
export class OrderMessageEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  adminId!: string;

  @Column({ type: "int" })
  @Index()
  orderId!: number;

  @ManyToOne(() => OrderEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "orderId" })
  order!: OrderEntity;

  @Column({ type: "varchar", length: 50 })
  senderType!: "admin" | "customer"; // who sent the message

  @Column({ type: "int", nullable: true })
  senderUserId?: number; // if admin sent

  @Column({ type: "text" })
  message!: string;

  @Column({ type: "boolean", default: false })
  isRead!: boolean;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}