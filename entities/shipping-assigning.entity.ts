import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { User } from "./user.entity";
import { ShippingCompanyEntity } from "./shipping.entity";
import { StoreEntity } from "./stores.entity";

export enum ShippingAssigningRuleType {
  EQUAL_DISTRIBUTION = "equal_distribution",
  PAYMENT_METHOD = "payment_method",
  ORDER_TOTAL = "order_total",
  STORE = "store",
  CITY = "city",
}

/**
 * Per-type rule data. The single target shipping company always comes from
 * `targetCompanies` (exactly one entry, except equal_distribution where the
 * whole list is the distribution set).
 */
export type AssigningCondition = {
  /** payment_method: single payment method. */
  paymentMethod?: string | null;
  /** store: many store ids, one company. */
  storeIds?: string[];
  /** city: many city ids, one company. */
  cityIds?: string[];
  /** order_total: single min/max, null bound = open-ended. */
  minAmount?: number | null;
  maxAmount?: number | null;
};

@Index(["adminId", "name"], { unique: true })
@Index(["adminId", "priority"])
@Entity("shipping_assigning_rules")
export class ShippingAssigningRuleEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  adminId: string;

  @ManyToOne(() => User, { onDelete: "SET NULL" })
  @JoinColumn({ name: "adminId" })
  admin: User;

  @Column({ type: "varchar" })
  name: string;

  @Column({ type: "varchar", nullable: true })
  description?: string;

  @Column({
    type: "enum",
    enum: ShippingAssigningRuleType,
  })
  ruleType: ShippingAssigningRuleType;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: "uuid", nullable: true })
  lastAssignedCompanyId?: string;

  @Column({ type: "jsonb", nullable: true })
  condition?: AssigningCondition | null;

  /**
   * Priority. Lower number executes first.
   */
  @Column({ default: 1 })
  priority: number;

  // ======================
  // TARGET COMPANIES (empty = all active companies)
  // ======================

  @ManyToMany(() => ShippingCompanyEntity)
  @JoinTable({
    name: "shipping_assigning_rule_companies",
  })
  targetCompanies?: ShippingCompanyEntity[];

  // ======================
  // STORES MIRROR (source of truth stays condition.mapping)
  // ======================

  @ManyToMany(() => StoreEntity)
  @JoinTable({
    name: "shipping_assigning_rule_stores",
  })
  stores?: StoreEntity[];

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}
