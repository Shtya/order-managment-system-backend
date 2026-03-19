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
  BeforeInsert,
  BeforeUpdate,
  OneToOne,
  Relation,
} from "typeorm";
import { ProductVariantEntity } from "./sku.entity";
import { StoreEntity } from "./stores.entity";
import { User } from "./user.entity";
import { ShippingCompanyEntity } from "./shipping.entity";
import { OrderCollectionEntity } from "./order-collection.entity";

// ✅ Order Status Enum
export enum OrderStatus {
  NEW = "new",
  UNDER_REVIEW = "under_review",
  // ✅ حالات مرحلة التأكيد الجديدة
  CONFIRMED = "confirmed",           // مؤكد
  DISTRIBUTED = "distributed",
  POSTPONED = "postponed",           // مؤجل
  NO_ANSWER = "no_answer",           // لا يوجد رد
  WRONG_NUMBER = "wrong_number",     // الرقم غلط
  OUT_OF_DELIVERY_AREA = "out_of_area", // خارج نطاق التوصيل
  DUPLICATE = "duplicate",           // طلب مكرر
  //
  PREPARING = "preparing",

  PRINTED = "printed",
  READY = "ready",
  PACKED = "packed",
  REJECTED = "rejected",
  SHIPPED = "shipped",
  DELIVERED = "delivered",
  CANCELLED = "cancelled",
  RETURN_PREPARING = 'return_preparing',
  RETURNED = "returned",
}

@Entity('order_statuses')
@Index(["adminId", "code"], { unique: true })
@Index(["adminId", "name"], { unique: true })
export class OrderStatusEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "varchar", length: 50 })
  name: string; // e.g., "Ready for Pickup"

  @Column({ type: "varchar", length: 50 })
  code: string; // as slug e.g., "ready-for-pickup"

  @Column({ nullable: true })
  @Index()
  adminId: string | null;

  @Column({ type: "text", nullable: true })
  description?: string;

  @Column({ type: "boolean", default: false })
  system: boolean; // If true, Admin cannot delete this

  @Column({ type: "boolean", default: false })
  isDefault: boolean; // Only one status should have this

  @Column({ type: "int", default: 0 })
  sortOrder: number; // For "trimming" the UI list order


  @Column({ type: "varchar", length: 7, default: "#000000" })
  color: string; // Hex code for UI display
  @OneToMany(() => OrderEntity, order => order.status)
  orders: OrderEntity[];

  @BeforeInsert()
  @BeforeUpdate()
  generateSlug() {
    if (!this.name) return;

    if (!this.system) {
      this.code = slugify(this.name).slice(0, 200);
    }
  }

}
export function slugify(value: string): string {
  return value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\u0600-\u06FFa-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
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
  OTHER = "other",
  WALLET = "wallet",
  UNKNOWN = "unknown",
}

// ✅ Main Order Entity
@Entity({ name: "orders" })
@Index(["adminId", "orderNumber"], { unique: true })
@Index(["adminId", "status"])
@Index(["adminId", "paymentStatus"])
@Index(["adminId", "created_at"])
@Index(['adminId', 'storeId', 'created_at'])
@Index(["adminId", "city", "area"])
@Index(["adminId", "statusId", "rejectedAt"])
export class OrderEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "varchar", length: 255, nullable: true })
  externalId?: string | null;

  @Column({ type: "text", nullable: true })
  rejectReason: string; // ✅ The new column for rejection/cancellation reasons

  @UpdateDateColumn({ type: "timestamptz", nullable: true })
  rejectedAt?: Date;

  @UpdateDateColumn({ type: "timestamptz", nullable: true })
  returnedAt?: Date;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: "rejectedById" })
  rejectedBy?: User;

  @Column({ nullable: true })
  rejectedById?: number;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: "rejectedById" })
  returnedBy?: User;

  @Column({ nullable: true })
  returnedById?: number;


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

  @Column({ type: "varchar", length: 50, nullable: true })
  secondPhoneNumber?: string;

  @Column({ type: "varchar", length: 200, nullable: true })
  email?: string;

  @Column({ type: "text" })
  address!: string;

  @Column({ type: "text", nullable: true })
  landmark?: string;

  @Column({ type: "int", default: 0, nullable: false, })
  deposit: number;

  @Column({ type: "varchar", length: 100 })
  city!: string;

  @Column({ type: "varchar", length: 100, nullable: true })
  area?: string;

  // ✅ Order Status
  // @Column({ type: "varchar", length: 50, default: OrderStatus.NEW })
  // @Index()
  // status!: OrderStatus;

  @ManyToOne(() => OrderStatusEntity, { eager: true })
  @JoinColumn({ name: 'statusId' })
  status: OrderStatusEntity;

  @Column()
  statusId: number;

  // ✅ Payment Information
  @Column({ type: "varchar", length: 50, default: PaymentMethod.CASH_ON_DELIVERY })
  paymentMethod!: PaymentMethod;

  @Column({ type: "varchar", length: 50, default: PaymentStatus.PENDING })
  @Index()
  paymentStatus!: PaymentStatus;

  // ✅ Shipping Information
  @ManyToOne(() => ShippingCompanyEntity, { nullable: true, eager: false })
  @JoinColumn({ name: 'shippingCompanyId' })
  shippingCompany?: ShippingCompanyEntity | null;

  @Column({ type: "int", nullable: true })
  shippingCompanyId?: number | null;

  @Column({ type: "int", nullable: true })
  @Index()
  storeId?: number | null;

  @ManyToOne(() => StoreEntity, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "storeId" })
  store?: StoreEntity | null;

  @Column({ type: "varchar", length: 100, nullable: true })
  trackingNumber?: string;

  @UpdateDateColumn({ type: "timestamptz", nullable: true })
  distributed_at?: Date;

  @Column({ type: "timestamptz", nullable: true })
  shippedAt?: Date;

  @Column({ type: "timestamptz", nullable: true })
  deliveredAt?: Date;

  @Column({ type: "timestamptz", nullable: true })
  labelPrinted?: Date;

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

  @OneToMany(() => OrderAssignmentEntity, (assignment) => assignment.order)
  assignments: OrderAssignmentEntity[];

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at!: Date;

  @Column({ default: false })
  isReplacement: boolean;

  @Column({ default: false })
  allowOpenPackage: boolean;

  // Inside OrderEntity
  @Column({ nullable: true })
  lastReturnId?: number;

  @ManyToOne(() => ReturnRequestEntity, { nullable: true })
  @JoinColumn({ name: "lastReturnId" })
  lastReturn?: Relation<ReturnRequestEntity>;

  @Column({ type: "int", nullable: true })
  manifestId?: number;

  @ManyToOne(() => ShipmentManifestEntity, (manifest) => manifest.orders, {
    nullable: true,
    onDelete: "SET NULL",
  })
  @JoinColumn({ name: "manifestId" })
  manifest?: Relation<ShipmentManifestEntity>;

  // Inside OrderEntity
  @Column({
    type: "jsonb",
    nullable: true,
    default: { preparation: 0, shipping: 0 }
  })
  failedScanCounts: {
    preparation: number;
    shipping: number;
  };


  @OneToOne('OrderReplacementEntity', 'originalOrder', { nullable: true })
  replacementRequest: Relation<OrderReplacementEntity>;

  @OneToOne('OrderReplacementEntity', 'replacementOrder', { nullable: true })
  replacementResult: Relation<OrderReplacementEntity>;

  @OneToMany(() => OrderCollectionEntity, (collection) => collection.order)
  collections: Relation<OrderCollectionEntity[]>;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  collectedAmount: number;

  @Column({ type: 'jsonb', nullable: true })
  shippingMetadata?: {
    cityId?: string; //For Bosta
    districtId?: string; //For Bosta
    zoneId?: string; //For Bosta 
    locationId?: string;  //For Bosta
  };

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

  @Column({ type: "int", default: 0 })
  scannedQuantity: number;

  @Column({ type: "int", default: 0 })
  shippingScannedQuantity: number;


  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  unitPrice!: number; // Price at time of order

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  unitCost!: number; // Cost at time of order (for profit calculation)

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  lineTotal!: number; // unitPrice * quantity

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  lineProfit!: number; // (unitPrice - unitCost) * quantity

  @Column({ default: false })
  isAdditional: boolean;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}

export enum ScanLogType {
  PREPARATION = 'PREPARATION', // Scanning items into a box
  SHIPPING = 'SHIPPING',       // Scanning boxes onto a truck
}

export enum ScanReason {
  SKU_NOT_IN_ORDER = "SKU_NOT_IN_ORDER",
  ALREADY_FULLY_SCANNED = "ALREADY_FULLY_SCANNED",
  INVALID_STATUS = "INVALID_STATUS",
  OTHER = "OTHER",
}


@Entity({ name: "order_scan_logs" })
@Index(["adminId", "orderId", "phase"]) // Fast lookup for a specific order's audit trail
export class OrderScanLogEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  adminId!: string; // Mandatory for multi-tenancy

  @Column({ type: "int" })
  orderId!: number;

  @ManyToOne(() => OrderEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "orderId" })
  order!: OrderEntity;

  @Column({ type: "int", nullable: true })
  userId?: number;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: "userId" })
  user?: User;

  @Column({ type: "varchar", length: 100 })
  sku: string; // The raw string received from the scanner

  @Column({
    type: "enum",
    enum: ScanReason,
    default: ScanReason.OTHER,
  })
  reason: ScanReason;

  @Column({ type: "text", nullable: true })
  details?: string; // Optional: Store the current status or other context

  @Column({
    type: "enum",
    enum: ScanLogType,
    default: ScanLogType.PREPARATION,
  })
  phase: ScanLogType;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
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
  // Change from Enum to Relation
  @ManyToOne(() => OrderStatusEntity)
  @JoinColumn({ name: "fromStatusId" })
  fromStatus: OrderStatusEntity;

  @Column()
  fromStatusId: number;

  @ManyToOne(() => OrderStatusEntity)
  @JoinColumn({ name: "toStatusId" })
  toStatus: OrderStatusEntity;

  @Column()
  toStatusId: number;

  @Column({ type: "int", nullable: true })
  changedByUserId?: number;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: "changedByUserId" })
  changedByUser?: User;

  @ManyToOne(() => ShippingCompanyEntity, { nullable: true })
  @JoinColumn({ name: "shippingCompanyId" })
  shippingCompany?: ShippingCompanyEntity;

  @Column({ type: "int", nullable: true })
  shippingCompanyId?: number;

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


@Entity({ name: "order_retry_settings" })
export class OrderRetrySettingsEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index({ unique: true }) // One setting record per admin
  adminId!: string;

  @Column({ type: "boolean", default: true })
  enabled: boolean;

  @Column({ type: "int", default: 3 })
  maxRetries: number;

  @Column({ type: "int", default: 30 }) // in minutes
  retryInterval: number;

  @Column({ type: "varchar", length: 50, default: "cancelled" })
  autoMoveStatus: string;

  @Column({ type: "jsonb", default: [] })
  retryStatuses: string[]; // e.g., ["pending_confirmation", "no_answer_shipping"]

  @Column({ type: "jsonb", default: [] })
  confirmationStatuses: string[]; // e.g., ["pending_confirmation", "no_answer_shipping"]

  @Column({ type: "boolean", default: true })
  notifyEmployee: boolean;

  @Column({ type: "boolean", default: false })
  notifyAdmin: boolean;

  @Column({ type: "jsonb", default: { enabled: true, start: "09:00", end: "18:00" } })
  workingHours: {
    enabled: boolean;
    start: string;
    end: string;
  };

  @UpdateDateColumn()
  updated_at: Date;
}


@Entity("order_assignments")
@Index(["orderId", "isAssignmentActive"]) // Fast lookup to see if an order is "taken"
export class OrderAssignmentEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  orderId: number;

  @ManyToOne(() => OrderEntity)
  @JoinColumn({ name: "orderId" })
  order: OrderEntity;

  @Column()
  employeeId: number;

  @ManyToOne(() => User)
  @JoinColumn({ name: "employeeId" })
  employee: User;

  @Column()
  assignedByAdminId: number;

  @ManyToOne(() => OrderStatusEntity, { eager: true, nullable: true })
  @JoinColumn({ name: 'lastStatusId' })
  lastStatus: OrderStatusEntity;

  @Column({ nullable: true })
  lastStatusId: number;

  // ✅ Tracking the Work
  @Column({ type: "int", default: 0 })
  retriesUsed: number;

  @Column({ type: "int", default: 3 })
  maxRetriesAtAssignment: number; // Snapshot of global settings at time of assign

  @Column({ type: "boolean", default: true })
  @Index()
  isAssignmentActive: boolean; // TRUE = Order is "Taken". FALSE = Order is "Free"

  // ✅ Timing & Locking
  @CreateDateColumn({ type: "timestamptz" })
  assignedAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  lastActionAt?: Date; // Automatically updates whenever the employee hits 'Retry' or 'Confirm'

  @Column({ type: "timestamptz", nullable: true })
  lockedUntil?: Date | null; // If now < lockedUntil, employee can see it but can't click it

  @Column({ type: "timestamptz", nullable: true })
  finishedAt?: Date;
}

export enum ReplacementReason {
  WRONG_SIZE = 'wrong_size',
  DAMAGED = 'damaged',
  WRONG_ITEM = 'wrong_item',
  COLOR_ISSUE = 'color_issue',
  QUALITY = 'quality',
  NOT_AS_DESCRIBED = 'not_as_described', // New: Mismatch with website photos/text
  MISSING_PARTS = 'missing_parts',      // New: Item arrived incomplete
  CHANGE_OF_MIND = 'change_of_mind',    // New: Customer just doesn't want it
  LATE_DELIVERY = 'late_delivery',      // New: Arrived too late for an event
  FAULTY = 'faulty',                    // New: Works, but has a functional defect
  OTHER = 'other',
}


@Entity({ name: "order_replacements" })
export class OrderReplacementEntity {
  @PrimaryGeneratedColumn()
  id: number;

  // Reasons
  @Column({
    type: "enum",
    enum: ReplacementReason,
    default: ReplacementReason.OTHER
  })
  reason: ReplacementReason;

  @Column({ type: "text", nullable: true })
  anotherReason?: string; // Customer's reason (e.g., "Wrong Size")

  @Column({ type: "text", nullable: true })
  internalNotes?: string; // Admin's "another reason" or internal notes

  // Evidence
  @Column({ type: "jsonb", nullable: true })
  returnImages: string[]; // Array of URLs showing the products to return

  @OneToOne(() => OrderEntity)
  @JoinColumn({ name: "originalOrderId" })
  originalOrder: OrderEntity;

  @Column()
  originalOrderId: number;

  // Replacement order
  @OneToOne(() => OrderEntity)
  @JoinColumn({ name: "replacementOrderId" })
  replacementOrder: OrderEntity;

  @Column()
  replacementOrderId: number;

  @ManyToOne(() => ShippingCompanyEntity, { nullable: true })
  @JoinColumn({ name: "shippingCompanyId" })
  shippingCompany: ShippingCompanyEntity;

  @Column({ nullable: true })
  shippingCompanyId: number;

  @OneToMany(() => OrderReplacementItemEntity, (item) => item.replacement, { cascade: true })
  items: OrderReplacementItemEntity[];

  @CreateDateColumn()
  createdAt: Date;
}

@Entity({ name: "order_replacement_items" })
export class OrderReplacementItemEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => OrderReplacementEntity, (replacement) => replacement.items)
  @JoinColumn({ name: "replacementId" })
  replacement: OrderReplacementEntity;

  @Column()
  replacementId: number;

  // Connection to the specific item being replaced from the original order
  @ManyToOne(() => OrderItemEntity)
  @JoinColumn({ name: "originalOrderItemId" })
  originalOrderItem: OrderItemEntity;

  @Column()
  originalOrderItemId: number;

  @Column({ type: "int" })
  quantityToReplace: number;

  // Connection to the new Product Variant being sent instead
  @ManyToOne(() => ProductVariantEntity)
  @JoinColumn({ name: "newVariantId" })
  newVariant: ProductVariantEntity;
  @Column()
  newVariantId: number;
}

export enum ShipmentManifestType {
  SHIPPING = "SHIPPING", // بيان تحميل / شحن
  RETURN = "RETURN",     // بيان مرتجعات
}
@Index(["adminId", "type"])
@Entity({ name: "shipment_manifests" })
export class ShipmentManifestEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  adminId: string;

  @Column({
    type: "enum",
    enum: ShipmentManifestType,
    default: ShipmentManifestType.SHIPPING
  })
  type: ShipmentManifestType; // ✅ shipping or return

  @Column({ unique: true })
  manifestNumber: string; // e.g., MAN-2026-0001

  @Column({ type: "int", nullable: true })
  changedByUserId?: number;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: "changedByUserId" })
  changedByUser?: User;

  @ManyToOne(() => ShippingCompanyEntity, { nullable: true })
  @JoinColumn({ name: "shippingCompanyId" })
  shippingCompany?: ShippingCompanyEntity;

  @Column({ type: "int", nullable: true })
  shippingCompanyId?: number;

  @Column({ nullable: true })
  driverName: string;

  @Column({ type: "timestamptz", nullable: true })
  lastPrintedAt?: Date;

  @OneToMany(() => OrderEntity, (order) => order.manifest)
  orders: OrderEntity[];

  @Column({ type: "int", default: 0 })
  totalOrders: number;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

}


export enum OrderActionType {
  CONFIRMED = "CONFIRMED",
  COURIER_ASSIGNED = "COURIER_ASSIGNED",
  PREPARATION_STARTED = "PREPARATION_STARTED",
  WAYBILL_PRINTED = "WAYBILL_PRINTED",
  WAYBILL_REPRINTED = "WAYBILL_REPRINTED",
  MANIFEST_PRINTED = "MANIFEST_PRINTED",
  MANIFEST_REPRINTED = "MANIFEST_REPRINTED",
  OUTGOING_DISPATCHED = "OUTGOING_DISPATCHED",
  RETURN = "RETURN",
  REJECTED = "REJECTED",

  RETURN_RECEIVED = "RETURN_RECEIVED", // استلام مرتجع
  RETRY_ATTEMPT = "RETRY_ATTEMPT",
}

export enum OrderActionResult {
  SUCCESS = "SUCCESS",
  FAILED = "FAILED"
}

@Entity({ name: "order_action_logs" })
export class OrderActionLogEntity {
  @PrimaryGeneratedColumn()
  id: number; // This is your Operation Number

  @Index()
  @Column({ unique: true })
  operationNumber: string; // ✅ Human-readable ID: OP-20260318-0001

  @Column()
  @Index()
  adminId: string;

  @Column({ type: "enum", enum: OrderActionType })
  actionType: OrderActionType; // Operation Type

  @Column({ type: "int" })
  orderId: number;

  @ManyToOne(() => OrderEntity)
  @JoinColumn({ name: "orderId" })
  order: OrderEntity;

  @Column({ type: "int", nullable: true })
  shippingCompanyId?: number;

  @ManyToOne(() => ShippingCompanyEntity, { nullable: true })
  @JoinColumn({ name: "shippingCompanyId" })
  shippingCompany?: ShippingCompanyEntity;

  @Column({ type: "int", nullable: true })
  userId?: number;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: "userId" })
  user?: User; // Employee

  @Column({
    type: "enum",
    enum: OrderActionResult,
    default: OrderActionResult.SUCCESS
  })
  result: OrderActionResult; // ✅ Now an Enum

  @Column({ type: "text", nullable: true })
  details?: string; // Details

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date; // Date & Time
}


@Index(['adminId', 'orderId'])
@Entity('order_returns')
export class ReturnRequestEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  adminId: string;

  @Column()
  orderId: number;

  @ManyToOne(() => OrderEntity)
  @JoinColumn({ name: 'orderId' })
  order: OrderEntity;

  @Column()
  userId: number; // User who created the request (Staff/Admin)

  @Column({ nullable: true })
  reason: string;

  @OneToMany(() => ReturnRequestItemEntity, (item) => item.returnRequest, { cascade: true })
  items: ReturnRequestItemEntity[];

  @CreateDateColumn()
  createdAt: Date;
}


@Entity('order_return_items')
export class ReturnRequestItemEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  returnRequestId: number;

  @ManyToOne(() => ReturnRequestEntity, (req) => req.items)
  returnRequest: ReturnRequestEntity;

  @Column()
  originalOrderItemId: number;

  @ManyToOne(() => OrderItemEntity)
  @JoinColumn({ name: 'originalOrderItemId' })
  originalItem: OrderItemEntity;

  @Column()
  returnedVariantId: number; // The actual variant received

  @ManyToOne(() => ProductVariantEntity)
  @JoinColumn({ name: 'returnedVariantId' })
  returnedVariant: ProductVariantEntity;

  @Column({ type: 'int', default: 1 })
  quantity: number;

  @Column({ nullable: true })
  condition: string; // e.g., "Damaged", "Resellable"
}