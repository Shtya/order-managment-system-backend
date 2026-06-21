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
  DeleteDateColumn,
} from "typeorm";
import { ProductVariantEntity } from "./sku.entity";
import { StoreEntity } from "./stores.entity";
import { User } from "./user.entity";
import { ShipmentEntity, ShippingCompanyEntity } from "./shipping.entity";
import { OrderCollectionEntity } from "./order-collection.entity";
import { MonthlyClosingEntity } from "./accounting.entity";
import { ActivatableEntity } from "./base.entity";
import { normalizeEgyptianPhoneNumber } from "common/whatsapp";
import { CityEntity } from "./cities.entity";
import { OrderAssignmentEntity } from "./assignment.entity";


// ✅ Order Status Enum
export enum OrderStatus {
  NEW = "new",   //
  UNDER_REVIEW = "under_review", //
  POSTPONED = "postponed", //
  NO_ANSWER = "no_answer", //
  WRONG_NUMBER = "wrong_number", //
  OUT_OF_DELIVERY_AREA = "out_of_area", //
  DUPLICATE = "duplicate", //
  FAILED_DELIVERY = "failed_delivery", //
  REJECTED = "rejected",//
  CANCELLED = "cancelled", //
  CONFIRMED = "confirmed",

  RETURNED = "returned",  // 
  DELIVERED = "delivered",//
  DISTRIBUTED = "distributed",
  PRINTED = "printed",
  PREPARING = "preparing",
  READY = "ready",
  PACKED = "packed",
  SHIPPED = "shipped",
  RETURN_PREPARING = "return_preparing",
}


//final (delivered)
@Entity("order_statuses")
@Index(["adminId", "code"], { unique: true })
@Index(["adminId", "name"], { unique: true })
export class OrderStatusEntity extends ActivatableEntity {
  @Column({ type: "varchar", length: 50 })
  name: string; // e.g., "Ready for Pickup"

  @Column({ type: "varchar", length: 50 })
  code: string; // as slug e.g., "ready-for-pickup"

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
  @OneToMany(() => OrderEntity, (order) => order.status)
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
  PARTIALLY_REFUNDED = "partially_refunded",
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
@Index(["adminId", "storeId", "created_at"])
@Index(["adminId", "city", "area"])
@Index(["adminId", "statusId", "rejectedAt"])
@Index(["adminId", "normalizedPhoneNumber", "itemsSignature"])
export class OrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  externalId?: string | null;

  @Column({ type: "text", nullable: true })
  rejectReason: string; // ✅ The new column for rejection/cancellation reasons

  @UpdateDateColumn({ type: "timestamptz", nullable: true })
  rejectedAt?: Date;

  @Column({ type: "timestamptz", nullable: true })
  postponedDate?: Date;

  @Column({ type: "int", nullable: true })
  reminderDaysBefore?: number;

  @Column({ type: "boolean", default: false })
  postponedNotificationSent: boolean;

  @Column({ type: "boolean", default: false })
  reminderNotificationSent: boolean;

  @Column({ type: "boolean", default: false })
  oneDayBeforeNotificationSent: boolean;

  @UpdateDateColumn({ type: "timestamptz", nullable: true })
  returnedAt?: Date;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: "rejectedById" })
  rejectedBy?: User;

  @Column({ type: 'uuid', nullable: true })
  rejectedById?: string;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: "returnedById" })
  returnedBy?: User;

  @Column({ type: 'uuid', nullable: true })
  returnedById?: string;

  @Index()
  @Column({ type: 'uuid', nullable: true }) // Set to false if adminId is mandatory
  adminId: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Column({ type: "varchar", length: 100, unique: true })
  orderNumber!: string; // e.g., ORD-20250124-001

  // ✅ Customer Information
  @Column({ type: "varchar", length: 200 })
  customerName!: string;

  @Column({ type: "varchar", length: 50 })
  phoneNumber!: string;

  @Column({
    type: 'varchar',
    name: 'normalized_phone',
    nullable: true,
  })
  normalizedPhoneNumber: string;

  @BeforeInsert()
  @BeforeUpdate()
  setNormalizedPhone() {
    this.normalizedPhoneNumber = normalizeEgyptianPhoneNumber(this.phoneNumber);
  }

  @Column({
    nullable: true,
  })
  itemsSignature: string;

  @Column({ type: "int", default: 0 })
  duplicateCount: number;

  @Column({ type: "varchar", length: 100, nullable: true })
  originalOrderNumber?: string;

  @Column({ type: "varchar", length: 50, nullable: true })
  secondPhoneNumber?: string;

  @Column({ type: "varchar", length: 200, nullable: true })
  email?: string;

  @Column({ type: "text" })
  address!: string;

  @Column({ type: "text", nullable: true })
  landmark?: string;


  @Column({ type: "varchar", length: 100 })
  city!: string;

  @Column({ type: 'uuid', nullable: true })
  cityId: string;

  @ManyToOne(() => CityEntity, { eager: true })
  @JoinColumn({ name: "cityId" })
  cityDetails?: CityEntity;

  @Column({ type: "varchar", length: 100, nullable: true })
  area?: string;

  @ManyToOne(() => OrderStatusEntity, { eager: true })
  @JoinColumn({ name: "statusId" })
  status: OrderStatusEntity;
  
  @Column({ type: 'uuid' })
  statusId: string;
  
  @Column({ type: 'uuid', nullable: true })
  oldStatusId: string;
  
  @ManyToOne(() => OrderStatusEntity, { nullable: true })
  @JoinColumn({ name: "oldStatusId" })
  oldStatus: OrderStatusEntity;

  // ✅ Payment Information
  @Column({
    type: "varchar",
    length: 50,
    default: PaymentMethod.CASH_ON_DELIVERY,
  })
  paymentMethod!: PaymentMethod;

  @Column({ type: "varchar", length: 50, default: PaymentStatus.PENDING })
  @Index()
  paymentStatus!: PaymentStatus;

  // ✅ Shipping Information
  @ManyToOne(() => ShippingCompanyEntity, { nullable: true, eager: false })
  @JoinColumn({ name: "shippingCompanyId" })
  shippingCompany?: ShippingCompanyEntity | null;

  @Column({ type: 'uuid', nullable: true })
  shippingCompanyId?: string | null;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  storeId?: string | null;

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

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0, nullable: false })
  deposit: number;
  
  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  productsTotal!: number; // Sum of all items

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  shippingCost!: number;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  discount!: number;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  finalTotal!: number; // productsTotal + shippingCost - discount

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  profit!: number; // finalTotal - totalCost

  // ✅ Notes
  @Column({ type: "text", nullable: true })
  notes?: string;

  @Column({ type: "text", nullable: true })
  customerNotes?: string;

  // ✅ Relations
  @OneToMany(() => OrderItemEntity, (item) => item.order, {
    cascade: true,
    eager: true,
  })
  items!: OrderItemEntity[];

  @OneToMany(() => OrderStatusHistoryEntity, (history) => history.order)
  statusHistory!: OrderStatusHistoryEntity[];

  // ✅ Metadata
  @Column({ type: 'uuid', nullable: true })
  createdByUserId?: string;

  @Column({ type: 'uuid', nullable: true })
  updatedByUserId?: string;

  @OneToMany(() => OrderAssignmentEntity, (assignment) => assignment.order)
  assignments: OrderAssignmentEntity[];

  @OneToMany(() => ShipmentEntity, (shipment) => shipment.order)
  shipments: ShipmentEntity[];

  @OneToMany(() => ReturnRequestEntity, (returnRequest) => returnRequest.order)
  returnRequests: ReturnRequestEntity[];

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at!: Date;

  @Column({ default: false })
  isReplacement: boolean;

  @Column({ default: false })
  allowOpenPackage: boolean;

  // Inside OrderEntity
  @Column({ type: 'uuid', nullable: true })
  lastReturnId?: string;

  @ManyToOne(() => ReturnRequestEntity, { nullable: true })
  @JoinColumn({ name: "lastReturnId" })
  lastReturn?: Relation<ReturnRequestEntity>;

  @Column({ type: 'uuid', nullable: true })
  manifestId?: string;

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
    default: { preparation: 0, shipping: 0 },
  })
  failedScanCounts: {
    preparation: number;
    shipping: number;
  };

  @OneToOne("OrderReplacementEntity", "originalOrder", { nullable: true })
  replacementRequest: Relation<OrderReplacementEntity>;

  @OneToOne("OrderReplacementEntity", "replacementOrder", { nullable: true })
  replacementResult: Relation<OrderReplacementEntity>;

  @OneToMany(() => OrderCollectionEntity, (collection) => collection.order)
  collections: Relation<OrderCollectionEntity[]>;

  @OneToMany(() => OrderScanLogEntity, (log) => log.order)
  scanLogs: Relation<OrderScanLogEntity[]>;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  collectedAmount: number;

  @Column({ type: "jsonb", nullable: true })
  shippingMetadata?: {
    cityId?: string;
    districtId?: string;
    zoneId?: string;
    locationId?: string;
    orderSize?: string;
  };

  // Add this to your OrderEntity
  @Column({ type: 'uuid', nullable: true })
  monthlyClosingId: string | null;

  @ManyToOne(() => MonthlyClosingEntity)
  @JoinColumn({ name: 'monthlyClosingId' })
  monthlyClosing: Relation<MonthlyClosingEntity>;


  @DeleteDateColumn({ name: "deleted_at", nullable: true, type: "timestamptz" })
  deleted_at?: Date;
}

// ✅ Order Items Entity
@Entity({ name: "order_items" })
@Index(["adminId", "orderId"])
export class OrderItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true }) // Set to false if adminId is mandatory
  adminId: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Column({ type: 'uuid', })
  @Index()
  orderId!: string;

  @ManyToOne(() => OrderEntity, (order) => order.items, { onDelete: "CASCADE" })
  @JoinColumn({ name: "orderId" })
  order!: OrderEntity;

  @Column({ type: 'uuid', })
  @Index()
  variantId!: string;

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

  @Column({ type: "boolean", default: false })
  stockDeducted: boolean;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;

}

export enum ScanLogType {
  PREPARATION = "PREPARATION", // Scanning items into a box
  SHIPPING = "SHIPPING", // Scanning boxes onto a truck
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
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true }) // Set to false if adminId is mandatory
  adminId: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Column({ type: 'uuid', })
  orderId!: string;

  @ManyToOne(() => OrderEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "orderId" })
  order!: OrderEntity;

  @Column({ type: 'uuid', nullable: true })
  userId?: string;

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
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true }) // Set to false if adminId is mandatory
  adminId: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Column({ type: 'uuid' })
  @Index()
  orderId!: string;

  @ManyToOne(() => OrderEntity, (order) => order.statusHistory, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "orderId" })
  order!: OrderEntity;
  // Change from Enum to Relation
  @ManyToOne(() => OrderStatusEntity)
  @JoinColumn({ name: "fromStatusId" })
  fromStatus: OrderStatusEntity;

  @Column({ type: 'uuid' })
  fromStatusId: string;

  @ManyToOne(() => OrderStatusEntity)
  @JoinColumn({ name: "toStatusId" })
  toStatus: OrderStatusEntity;

  @Column({ type: 'uuid', })
  toStatusId: string;

  @Column({ type: 'uuid', nullable: true })
  changedByUserId?: string;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: "changedByUserId" })
  changedByUser?: User;

  @ManyToOne(() => ShippingCompanyEntity, { nullable: true })
  @JoinColumn({ name: "shippingCompanyId" })
  shippingCompany?: ShippingCompanyEntity;

  @Column({ type: 'uuid', nullable: true })
  shippingCompanyId?: string;

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
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  adminId: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Column({ type: 'uuid', })
  @Index()
  orderId!: string;

  @ManyToOne(() => OrderEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "orderId" })
  order!: OrderEntity;

  @Column({ type: "varchar", length: 50 })
  senderType!: "admin" | "customer"; // who sent the message

  @Column({ type: 'uuid', nullable: true })
  senderUserId?: string; // if admin sent

  @Column({ type: "text" })
  message!: string;

  @Column({ type: "boolean", default: false })
  isRead!: boolean;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}

export enum OrderFlowPath {
  SHIPPING = "shipping",
  WAREHOUSE = "warehouse",
}

export enum StockDeductionStrategy {
  ON_CONFIRMATION = "on_confirmation",
  ON_SHIPMENT = "on_shipment",
}

export enum AutomationMigrationStrategy {
  LATEST_MAJOR = "latest_major",
  LATEST_PATCH = "latest_patch",
  MANUAL = "manual",
}

export enum AssignmentMode {
  IMMEDIATE = "immediate",
  DELAYED = "delayed",
  DISABLED = "disabled",
}

export enum TimeUnit {
  MINUTES = "minutes",
  HOURS = "hours",
  DAYS = "days",
}
export type NotificationType =
  | "order"
  | "store"
  | "template"
  | "webhook_order_failures"
  | "product"
  | "bundle"
  | "automation_run"
  | "subscription"
  | "user_feature"
  | "wallet"
  | "other";
export type NotificationSettings = Record<NotificationType, boolean>;
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  order: true,
  store: true,
  template: true,
  webhook_order_failures: true,
  product: true,
  bundle: true,
  automation_run: true,
  subscription: true,
  user_feature: true,
  wallet: true,
  other: true,
};

@Entity({ name: "order_retry_settings" })
export class OrderRetrySettingsEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true }) // Set to false if adminId is mandatory
  adminId: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Column({
    type: "enum",
    enum: AssignmentMode,
    default: AssignmentMode.IMMEDIATE,
  })
  assignmentMode: AssignmentMode;

  @Column({ type: "int", default: 1 })
  assignmentDelay: number;

  @Column({
    type: "enum",
    enum: TimeUnit,
    default: TimeUnit.MINUTES,
  })
  assignmentDelayUnit: TimeUnit;

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

  @Column({
    type: "jsonb",
    default: DEFAULT_NOTIFICATION_SETTINGS,
  })
  notificationSettings: NotificationSettings;

  @Column({ type: "boolean", default: true })
  notifyLowStock: boolean;

  @Column({ type: "boolean", default: false })
  notifyMarketing: boolean;

  @Column({
    type: "enum",
    enum: StockDeductionStrategy,
    default: StockDeductionStrategy.ON_SHIPMENT,
  })
  stockDeductionStrategy: StockDeductionStrategy;

  @Column({
    type: "jsonb",
    default: { enabled: true, start: "09:00", end: "18:00" },
  })
  workingHours: {
    enabled: boolean;
    start: string;
    end: string;
  };

  @Column({
    type: "enum",
    enum: OrderFlowPath,
    default: OrderFlowPath.WAREHOUSE,
  })
  orderFlowPath: OrderFlowPath;

  /** When true, store webhook orders match line items by variant SKU if no product sync link exists. */
  @Column({ type: "boolean", default: true })
  storeOrderSkuFallback: boolean;

  @Column({
    type: "enum",
    enum: AutomationMigrationStrategy,
    default: AutomationMigrationStrategy.LATEST_PATCH,
  })
  automationMigrationStrategy: AutomationMigrationStrategy;

  @Column({ type: "uuid", nullable: true })
  defaultWhatsAppAccountId: string;

  @Column({ type: "boolean", default: false })
  reservedEnabled: boolean;

  @Column({ type: "int", default: 24 })
  duplicateWindowHours: number;

  @Column({ type: "boolean", default: false })
  autoCancelDuplicates: boolean;

  @Column({
    type: "jsonb",
    default: {
      shippingCompanyId: null,
      triggerStatus: null,
      notifyOnShipment: false,
      autoGenerateLabel: false,
      partialPaymentThreshold: 0,
      requireFullPayment: false,
      autoShipAfterWarehouse: false,
      warehouseDefaultShippingCompanyId: null,
    },
  })
  shipping: {
    shippingCompanyId: string | null;
    triggerStatus: string | null;
    notifyOnShipment: boolean; //
    autoGenerateLabel: boolean;
    partialPaymentThreshold: number;
    requireFullPayment: boolean;
    autoShipAfterWarehouse: boolean;
    warehouseDefaultShippingCompanyId: string | null;
  };

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at: Date;
}



@Entity({ name: "order_replacements" })
export class OrderReplacementEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Reasons

  @Column({ type: "text", nullable: true })
  reason?: string;
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

  @Column({ type: 'uuid', })
  originalOrderId: string;

  // Replacement order
  @OneToOne(() => OrderEntity)
  @JoinColumn({ name: "replacementOrderId" })
  replacementOrder: OrderEntity;

  @Column({ type: 'uuid', })
  replacementOrderId: string;

  @ManyToOne(() => ShippingCompanyEntity, { nullable: true })
  @JoinColumn({ name: "shippingCompanyId" })
  shippingCompany: ShippingCompanyEntity;

  @Column({ type: 'uuid', nullable: true })
  shippingCompanyId: string;

  @OneToMany(() => OrderReplacementItemEntity, (item) => item.replacement, {
    cascade: true,
  })
  items: OrderReplacementItemEntity[];

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}

@Entity({ name: "order_replacement_items" })
export class OrderReplacementItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => OrderReplacementEntity, (replacement) => replacement.items)
  @JoinColumn({ name: "replacementId" })
  replacement: OrderReplacementEntity;

  @Column({ type: 'uuid', })
  replacementId: string;

  // Connection to the specific item being replaced from the original order
  @ManyToOne(() => OrderItemEntity)
  @JoinColumn({ name: "originalOrderItemId" })
  originalOrderItem: OrderItemEntity;

  @Column({ type: 'uuid', })
  originalOrderItemId: string;

  @Column({ type: "int" })
  quantityToReplace: number;

  // Connection to the new Product Variant being sent instead
  @ManyToOne(() => ProductVariantEntity)
  @JoinColumn({ name: "newVariantId" })
  newVariant: ProductVariantEntity;
  @Column()
  newVariantId: string;
}

export enum ShipmentManifestType {
  SHIPPING = "SHIPPING", // بيان تحميل / شحن
  RETURN = "RETURN", // بيان مرتجعات
}
@Index(["adminId", "type"])
@Entity({ name: "shipment_manifests" })
export class ShipmentManifestEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  adminId: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Column({
    type: "enum",
    enum: ShipmentManifestType,
    default: ShipmentManifestType.SHIPPING,
  })
  type: ShipmentManifestType; // ✅ shipping or return

  @Column({ unique: true })
  manifestNumber: string; // e.g., MAN-2026-0001

  @Column({ type: 'uuid', nullable: true })
  changedByUserId?: string;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: "changedByUserId" })
  changedByUser?: User;

  @ManyToOne(() => ShippingCompanyEntity, { nullable: true })
  @JoinColumn({ name: "shippingCompanyId" })
  shippingCompany?: ShippingCompanyEntity;

  @Column({ type: 'uuid', nullable: true })
  shippingCompanyId?: string;

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
  FAILED = "FAILED",
}

@Entity({ name: "order_action_logs" })
export class OrderActionLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string; // This is your Operation Number

  @Index()
  @Column({ unique: true })
  operationNumber: string; // ✅ Human-readable ID: OP-20260318-0001

  @Index()
  @Column({ type: 'uuid', nullable: true })
  adminId: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Column({ type: "enum", enum: OrderActionType })
  actionType: OrderActionType; // Operation Type

  @Column({ type: 'uuid', })
  orderId: string;

  @ManyToOne(() => OrderEntity)
  @JoinColumn({ name: "orderId" })
  order: OrderEntity;

  @Column({ type: 'uuid', nullable: true })
  shippingCompanyId?: string;

  @ManyToOne(() => ShippingCompanyEntity, { nullable: true })
  @JoinColumn({ name: "shippingCompanyId" })
  shippingCompany?: ShippingCompanyEntity;

  @Column({ type: 'uuid', nullable: true })
  userId?: string;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: "userId" })
  user?: User; // Employee

  @Column({
    type: "enum",
    enum: OrderActionResult,
    default: OrderActionResult.SUCCESS,
  })
  result: OrderActionResult; // ✅ Now an Enum

  @Column({ type: "text", nullable: true })
  details?: string; // Details

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date; // Date & Time
}

export enum ReturnRequestStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
}
@Index(["adminId", "orderId"])
@Entity("order_returns")
export class ReturnRequestEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  adminId: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Column({ type: 'uuid', })
  orderId: string;

  @Column({ type: "enum", enum: ReturnRequestStatus, default: ReturnRequestStatus.PENDING })
  status: ReturnRequestStatus; // ✅ Now an Enum

  @ManyToOne(() => OrderEntity)
  @JoinColumn({ name: "orderId" })
  order: OrderEntity;

  @Column({ type: 'uuid', })
  userId: string; // User who created the request (Staff/Admin)

  @Column({ nullable: true })
  reason: string;
  
  @OneToMany(() => ReturnRequestItemEntity, (item) => item.returnRequest, {
    cascade: true,
  })
  items: ReturnRequestItemEntity[];

  @Column({ type: 'uuid', nullable: true })
  monthlyClosingId: string | null;

  @ManyToOne(() => MonthlyClosingEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'monthlyClosingId' })
  monthlyClosing: MonthlyClosingEntity;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}

@Entity("order_return_items")
export class ReturnRequestItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', })
  returnRequestId: string;

  @ManyToOne(() => ReturnRequestEntity, (req) => req.items)
  returnRequest: ReturnRequestEntity;

  @Column({ type: 'uuid', })
  originalOrderItemId: string;

  @ManyToOne(() => OrderItemEntity)
  @JoinColumn({ name: "originalOrderItemId" })
  originalItem: OrderItemEntity;

  @Column({ type: 'uuid', })
  returnedVariantId: string; // The actual variant received

  @ManyToOne(() => ProductVariantEntity)
  @JoinColumn({ name: "returnedVariantId" })
  returnedVariant: ProductVariantEntity;

  @Column({ type: "int", default: 1 })
  quantity: number;

  @Column({ nullable: true })
  condition: string; // e.g., "Damaged", "Resellable"
}
