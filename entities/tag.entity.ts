import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Relation,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import { User } from "./user.entity";
import { OrderEntity } from "./order.entity";

export enum TagAssignmentSource {
  MANUAL = "manual",
  AUTOMATIC = "automatic",
}

export enum TagConditionLogic {
  AND = "AND",
  OR = "OR",
}

export enum TagConditionOperator {
  EQ = "eq",
  NEQ = "neq",
  IN = "in",
  NOT_IN = "not_in",
  IS_NULL = "is_null",
  IS_NOT_NULL = "is_not_null",
  GTE = "gte",
  LTE = "lte",
}

export enum TagConditionField {
  ORDER_STATUS_ID = "order.statusId",
  ORDER_STORE_ID = "order.storeId",
  ORDER_CITY_ID = "order.cityId",
  ORDER_PAYMENT_STATUS = "order.paymentStatus",
  ORDER_PAYMENT_METHOD = "order.paymentMethod",
  ORDER_PRODUCTS_TOTAL = "order.productsTotal",
  ORDER_ITEMS_QUANTITY = "order.itemsQuantity",
  ORDER_PRODUCTS_COUNT = "order.productsCount",
  ORDER_SHIPPING_COMPANY_ID = "order.shippingCompanyId",
  ORDER_FINAL_TOTAL = "order.finalTotal",
  ORDER_DISCOUNT = "order.discount",
  ORDER_IS_CONFIRMED = "order.isConfirmed",
  ORDER_CONFIRMATION_SOURCE = "order.confirmationSource",
  ORDER_ALLOW_OPEN_PACKAGE = "order.allowOpenPackage",
  ORDER_DUPLICATE_COUNT = "order.duplicateCount",
  ASSIGNMENT_CONTACT_TRIES = "assignment.contactTries",
  ASSIGNMENT_HAS_ACTIVE = "assignment.hasActive",
  SHIPMENT_STATUS = "shipment.status",
  UPSELL_ACCEPTED = "upsell.accepted",
  ORDER_PHONE_VALID = "order.phone.valid",
}

export interface TagConditionRule {
  field: TagConditionField | string;
  operator: TagConditionOperator | string;
  value?: any;
}

export interface TagConditions {
  logic: TagConditionLogic | string;
  rules: TagConditionRule[];
}

@Entity({ name: "tags" })
@Unique(["adminId", "name"])
@Index(["adminId", "isActive"])
@Index(["adminId", "priority"])
export class TagEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  adminId: string;

  @ManyToOne(() => User, { onDelete: "SET NULL" })
  @JoinColumn({ name: "adminId" })
  admin: User;

  @Column({ type: "varchar", length: 100 })
  name: string;

  @Column({ type: "varchar", length: 20, default: "#6C5CE7" })
  color: string;

  @Column({ type: "varchar", length: 1000, nullable: true })
  description?: string | null;

  @Column({ type: "boolean", default: true })
  isActive: boolean;

  /** When false, only the tenant admin can assign/remove this tag. Employees cannot use it. */
  @Column({ type: "boolean", default: true })
  allowManualAssignment: boolean;

  /**
   * Employees allowed to use this tag when allowManualAssignment is true.
   * Empty array = all employees.
   */
  @Column({ type: "jsonb", default: [] })
  employeeIds: string[];

  @Column({ type: "int", default: 0 })
  priority: number;

  @OneToMany(() => OrderTagEntity, (orderTag) => orderTag.tag)
  orderTags: OrderTagEntity[];

  @OneToMany(() => TagAutomationEntity, (automation) => automation.tag)
  automations: TagAutomationEntity[];

  @CreateDateColumn({ type: "timestamptz" })
  created_at: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at: Date;
}

@Entity({ name: "order_tags" })
@Unique(["orderId", "tagId"])
@Index(["adminId", "orderId"])
@Index(["adminId", "tagId"])
export class OrderTagEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  adminId: string;

  @ManyToOne(() => User, { onDelete: "SET NULL" })
  @JoinColumn({ name: "adminId" })
  admin: User;

  @Column({ type: "uuid" })
  orderId: string;

  @ManyToOne(() => OrderEntity, (order) => order.orderTags, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "orderId" })
  order: Relation<OrderEntity>;

  @Column({ type: "uuid" })
  tagId: string;

  @ManyToOne(() => TagEntity, (tag) => tag.orderTags, { onDelete: "CASCADE" })
  @JoinColumn({ name: "tagId" })
  tag: TagEntity;

  @Column({ type: "varchar", length: 20, default: TagAssignmentSource.MANUAL })
  source: TagAssignmentSource;

  @Column({ type: "uuid", nullable: true })
  createdByUserId?: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "createdByUserId" })
  createdBy?: User | null;

  @CreateDateColumn({ type: "timestamptz" })
  created_at: Date;
}

@Entity({ name: "tag_automations" })
@Index(["adminId", "isEnabled"])
@Index(["adminId", "tagId"])
export class TagAutomationEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  adminId: string;

  @ManyToOne(() => User, { onDelete: "SET NULL" })
  @JoinColumn({ name: "adminId" })
  admin: User;

  @Column({ type: "uuid" })
  tagId: string;

  @ManyToOne(() => TagEntity, (tag) => tag.automations, { onDelete: "CASCADE" })
  @JoinColumn({ name: "tagId" })
  tag: TagEntity;

  @Column({ type: "varchar", length: 150 })
  name: string;

  @Column({ type: "boolean", default: true })
  isEnabled: boolean;

  @Column({
    type: "jsonb",
    default: { logic: TagConditionLogic.AND, rules: [] },
  })
  conditions: TagConditions;

  @CreateDateColumn({ type: "timestamptz" })
  created_at: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at: Date;
}
