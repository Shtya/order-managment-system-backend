import { Column, CreateDateColumn, Entity, Index, JoinColumn, JoinTable, ManyToMany, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { User } from "./user.entity";
import { ProductEntity } from "./sku.entity";
import { CityEntity } from "./cities.entity";
import { ShippingCompanyEntity } from "./shipping.entity";
import { OrderEntity, OrderStatusEntity, PaymentStatus } from "./order.entity";


export enum AutoAssignRuleType {
    MANUAL = 'manual',
    PRODUCT = 'product',
    CITY = 'city',
    AMOUNT_RANGE = 'amountRange',
    PAYMENT_STATUS = 'paymentStatus'
}

export enum AssignmentStrategy {
  ROUND_ROBIN = 'roundRobin',
  LEAST_ACTIVE_ORDERS = 'leastActiveOrders',
}

@Index(["adminId", "name"], { unique: true })
@Entity('auto_assign_rules')
export class AutoAssignRuleEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Column({
        type: 'enum',
        enum: AutoAssignRuleType,
    })
    ruleType: AutoAssignRuleType;

    @Column({
        type: 'enum',
        enum: AssignmentStrategy,
    })
    strategy: AssignmentStrategy;

    @Column({ default: true })
    isActive: boolean;

    @Column({ type: 'uuid', nullable: true })
    lastAssignedEmployeeId?: string;    

    /**
     * Priority
     * Lower number executes first
     */
    @Column({ default: 1 })
    priority: number;

    @Column({type: 'varchar'})
    name: string;


    @Column({ type: 'varchar', nullable: true })
    description?: string;

    // ======================
    // PRODUCT RULE
    // ======================

    @ManyToMany(() => ProductEntity)
    @JoinTable({
        name: 'auto_assign_rule_products',
    })
    products?: ProductEntity[];

    // ======================
    // CITY RULE
    // ======================

    @ManyToMany(() => CityEntity)
    @JoinTable({
        name: 'auto_assign_rule_cities',
    })
    cities?: CityEntity[];

    // ======================
    // AMOUNT RANGE RULE
    // ======================

    @Column({
        type: 'decimal',
        precision: 12,
        scale: 2,
        nullable: true,
    })
    minAmount?: number;

    @Column({
        type: 'decimal',
        precision: 12,
        scale: 2,
        nullable: true,
    })
    maxAmount?: number;

    // ======================
    // PAYMENT STATUS RULE
    // ======================

    @Column({
        type: 'enum',
        enum: PaymentStatus,
        nullable: true,
    })
    paymentStatus?: PaymentStatus;

    // ======================
    // TARGET EMPLOYEES
    // ======================

    @ManyToMany(() => User)
    @JoinTable({
        name: 'auto_assign_rule_employees',
    })
    employees?: User[];

    @CreateDateColumn({ type: "timestamptz" })
    createdAt: Date;

    @UpdateDateColumn({ type: "timestamptz" })
    updatedAt: Date;
}


@Entity("order_assignments")
@Index(["orderId", "isAssignmentActive"]) // Fast lookup to see if an order is "taken"
export class OrderAssignmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', })
  orderId: string;

  @ManyToOne(() => OrderEntity)
  @JoinColumn({ name: "orderId" })
  order: OrderEntity;

  @Column({ type: 'uuid', })
  employeeId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "employeeId" })
  employee: User;

  @Column({ type: 'uuid', })
  assignedByAdminId: string;

  @ManyToOne(() => OrderStatusEntity, { eager: true, nullable: true })
  @JoinColumn({ name: "lastStatusId" })
  lastStatus: OrderStatusEntity;

  @Column({ type: 'uuid', nullable: true })
  lastStatusId: string;

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