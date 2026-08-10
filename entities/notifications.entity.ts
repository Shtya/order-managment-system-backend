import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { User } from "./user.entity";

export enum NotificationType {
  ORDER_STATUS_UPDATE = "order_status_update",
  SUBSCRIPTION_ACTIVATED = "subscription_activated",
  SUBSCRIPTION_CANCELLED = "subscription_cancelled",
  FEATURE_ACTIVATED = "feature_activated",
  WALLET_TOP_UP = "wallet_top_up",
  WALLET_CREDIT = "wallet_credit",
  SYSTEM_ALERT = "system_alert",
  PAYMENT_FAILED = "payment_failed",
  SHIPPING_AUTO_SENT = "shipping_auto_sent",
  SHIPPING_AUTO_FAILED = "shipping_auto_failed",
  ORDER_UPDATED = "order_updated",
  ORDER_REJECTED = "order_rejected",
  ORDER_RECONFIRMED = "order_reconfirmed",
  ORDER_DELETED = "order_deleted",
  ORDER_STATUS_CREATED = "order_status_created",
  ORDER_STATUS_SETTINGS_UPDATED = "order_status_settings_updated",
  BULK_ORDERS_CREATED = "bulk_orders_created",
  BULK_ORDERS_FAILED = "bulk_orders_failed",
  COLLECTION_CREATED = "collection_created",
  REPLACEMENT_CREATED = "replacement_created",
  RETURN_REQUEST_CREATED = "return_request_created",
  EXTRA_FEATURE_ASSIGNED = "extra_feature_assigned",
  PRODUCT_CREATED = "product_created",
  SHIPMENT_CREATED = "shipment_created",
  SHIPMENT_CANCELLED = "shipment_cancelled",
  SUBSCRIPTION_CREATED = "subscription_created",
  SUBSCRIPTION_STATUS_UPDATED = "subscription_status_updated",
  SUBSCRIPTION_UPDATED = "subscription_updated",
  ORDER_USAGE_FAILED = "order_usage_failed",
  LOW_STOCK_ALERT = "low_stock_alert",
  MARKETING_MESSAGE = "marketing_message",
  SYSTEM_ERROR = "system_error",
  ORDER_CREATED = "order_created",
  PRODUCT_SYNC_FAILED = "product_sync_failed",
  PRODUCT_SYNC_SUCCESS = "product_sync_success",
  ORDER_CREATTION_FAILED = "order_creation_failed",
  REMOTE_SYNC_END = "remote_sync_end",
  TEMPLATE_DELETED = "template_deleted",
  TEMPLATE_FLAGGED = "template_flagged",
  TEMPLATE_QUALITY_UPDATED = "template_quality_updated",
  TEMPLATE_STATUS_UPDATED = "template_status_updated",
  AUTOMATION_RUN_STARTED = "automation_run_started",
  AUTOMATION_RUN_FAILED = "automation_run_failed",
  AUTOMATION_RUN_COMPLETED = "automation_run_completed",
  AUTOMATION_RUN_RESUMED = "automation_run_resumed",
  ORDER_POSTPONED_REMINDER = "order_postponed_reminder",
  UPSELL_APPLICATION_FAILED = "upsell_application_failed",
  SHIPMENT_DELIVERED = "shipment_delivered",
  SHIPMENT_FAILED = "shipment_failed",
  ORDER_ASSIGNED = "order_assigned",
  UPSELL_UPDATED = "upsell_updated",
  ORDER_LOCATION_UPDATED = "order_location_updated",
  RETURN_SHIPMENT_REMINDER = "return_shipment_reminder",
  SUPPORT_TICKET_CREATED = "support_ticket_created",
  SUPPORT_TICKET_NEW_MESSAGE = "support_ticket_new_message",
  SUPPORT_TICKET_INTERNAL_NOTE = "support_ticket_internal_note",
  SUPPORT_TICKET_ASSIGNED = "support_ticket_assigned",
  SUPPORT_TICKET_UNASSIGNED = "support_ticket_unassigned",
  SUPPORT_TICKET_STATUS_CHANGED = "support_ticket_status_changed",
  SUPPORT_TICKET_PRIORITY_CHANGED = "support_ticket_priority_changed",
  SUPPORT_TICKET_REOPENED = "support_ticket_reopened",
  SUPPORT_TICKET_RESOLVED = "support_ticket_resolved",
  SUPPORT_TICKET_CLOSED = "support_ticket_closed",
  SUPPORT_TICKET_CANCELED = "support_ticket_canceled",
  ISSUE_CREATED = "issue_created",
  ISSUE_NEW_MESSAGE = "issue_new_message",
  ISSUE_MESSAGE_UPDATED = "issue_message_updated",
  ISSUE_MESSAGE_DELETED = "issue_message_deleted",
  ISSUE_STATUS_CHANGED = "issue_status_changed",
  ISSUE_PRIORITY_CHANGED = "issue_priority_changed",
  ISSUE_ASSIGNED = "issue_assigned",
}

@Entity("notifications")
@Index(["userId", "type", "isRead"])
@Index(["userId", "isRead"])
export class Notification {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  // The actual relation
  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user: User;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @Column({
    type: "enum",
    enum: NotificationType,
  })
  type: NotificationType; // 👈 Changed from string to Enum

  @Column()
  title: string;

  @Column({ type: "text" })
  message: string;

  @Column({ name: "is_read", default: false })
  isRead: boolean;

  @Column({ name: "related_entity_type", nullable: true })
  relatedEntityType: string;

  @Column({ type: "uuid", name: "related_entity_id", nullable: true })
  relatedEntityId: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}
