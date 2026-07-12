;
import { Column, ManyToOne, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn, JoinColumn } from "typeorm";
import { User } from "./user.entity";

export enum AutomationMigrationStrategy {
    LATEST_MAJOR = "latest_major",
    // LATEST_PATCH = "latest_patch",
    MANUAL = "manual",
  }

  
export enum OrderFlowPath {
    SHIPPING = "shipping",
    WAREHOUSE = "warehouse",
  }
  
  export enum StockDeductionStrategy {
    ON_CONFIRMATION = "on_confirmation",
    ON_SHIPMENT = "on_shipment",
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

  export enum Language {
    EN = "en",
    AR = "ar",
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
  
@Entity({ name: "client_settings" })
export class ClientSettingsEntity {
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

  @Column({ type: "enum", enum: Language, default: Language.EN })
  defaultLang: Language;


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
    default: AutomationMigrationStrategy.MANUAL,
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
