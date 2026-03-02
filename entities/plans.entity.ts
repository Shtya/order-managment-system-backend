import {
	Entity,
	PrimaryGeneratedColumn,
	Column,
	ManyToOne,
	OneToMany,
	JoinColumn,
	CreateDateColumn,
	UpdateDateColumn,
	Relation,
	BeforeInsert,
	Index,
	OneToOne,
} from 'typeorm';
import { User } from './user.entity';

/* =========================
 * Plans & Subscriptions
 * ========================= */

export enum PlanDuration {
	MONTHLY = 'monthly',
	YEARLY = 'yearly',
	LIFETIME = 'lifetime',
}

export enum PlanColor {
	BLUE = 'from-blue-500 to-blue-600',
	PURPLE = 'from-purple-500 to-purple-600',
	ORANGE = 'from-orange-500 to-orange-600',
	GREEN = 'from-green-500 to-green-600',
	PINK = 'from-pink-500 to-pink-600',
	CYAN = 'from-cyan-500 to-cyan-600',
}

@Entity('plans')
export class Plan {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	name: string;

	@Column({ type: 'decimal', precision: 10, scale: 2 })
	price: number;

	@Column({
		type: 'enum',
		enum: PlanDuration,
		default: PlanDuration.MONTHLY,
	})
	duration: PlanDuration;

	@Column({ type: 'text', nullable: true })
	description?: string;

	@Column({ type: 'simple-json', default: '[]' })
	features: string[];

	@Column({
		type: 'varchar',
		default: PlanColor.BLUE,
	})
	color: string;

	@Column({ default: true })
	isActive: boolean;

	@Column({ default: false })
	isPopular: boolean;

	@Column({ type: 'int', default: 1 })
	usersLimit: number;

	@Column({ type: 'int', default: 0 })
	shippingCompaniesLimit: number;

	@Column({ type: 'int', default: 0 })
	bulkUploadPerMonth: number;

	@Column({ type: 'int', nullable: true })
	adminId?: number | null;

	@ManyToOne(() => User, { nullable: true })
	@JoinColumn({ name: 'adminId' })
	admin?: Relation<User> | null;

	@OneToMany(() => Subscription, (sub) => sub.plan)
	subscriptions: Relation<Subscription>[];

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}


export enum SubscriptionStatus {
	ACTIVE = 'active',
	CANCELLED = 'cancelled',
	EXPIRED = 'expired',
}


@Entity('subscriptions')
export class Subscription {
	@PrimaryGeneratedColumn()
	id: number;

	@Column({ nullable: true })
	userId: number; // FK column

	// Owning side with JoinColumn
	@OneToOne(() => User, (user) => user.subscription, { nullable: true })
	@JoinColumn({ name: 'userId' })
	user: Relation<User>;

	@Column()
	planId: number;

	@ManyToOne(() => Plan, (plan) => plan.subscriptions)
	@JoinColumn({ name: 'planId' })
	plan: Relation<Plan>;


	@Column({ type: 'decimal', precision: 10, scale: 2 })
	price: number;

	@Column({
		type: 'enum',
		enum: SubscriptionStatus,
		default: SubscriptionStatus.ACTIVE,
	})
	status: SubscriptionStatus;

	@Column({ type: 'timestamptz' })
	startDate: Date;

	@Column({ type: 'timestamptz', nullable: true })
	endDate: Date;

	@OneToMany(() => Transaction, (transaction) => transaction.subscription)
	transactions: Relation<Transaction>[];

	@Column({ type: 'int', nullable: true })
	adminId?: number | null;

	@ManyToOne(() => User, { nullable: true })
	@JoinColumn({ name: 'adminId' })
	admin?: Relation<User> | null;

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}


export enum TransactionStatus {
	ACTIVE = 'active',
	PROCESSING = 'processing',
	COMPLETED = 'completed',
	CANCELLED = 'concelled'
}


export enum TransactionPaymentMethod {
	CASH = 'cash',
	VISA = "visa",
	BANK = "bank",
	OTHER = "other",

	// Mobile Wallets & Instant Transfers
	VODAFONE_CASH = "vodafone_cash",
	ORANGE_CASH = "orange_cash",
	ETISALAT_CASH = "etisalat_cash",
	WE_PAY = "we_pay",
	INSTA = "insta",

	// Payment Aggregators & Points
	FAWRY = "fawry",
	AMAN = "aman",
	MEEZA = "meeza",

	// Buy Now Pay Later (BNPL)
	VALU = "valu",
	SYMPL = "sympl",
	TABBY = "tabby",
	TAMARA = "tamara",

}

@Index(["adminId", "number"], { unique: true })
@Entity('transactions')
export class Transaction {
	@PrimaryGeneratedColumn()
	id: number;

	@Column({ type: "varchar", length: 100 })
	number!: string; // e.g., ORD-20250124-001

	@Column({ nullable: true })
	userId: number;

	@OneToOne(() => User, (user) => user.subscription, { nullable: false })
	@JoinColumn({ name: 'userId' }) // User owns the FK column
	user: Relation<User>;

	@Column({ type: 'int', nullable: true }) // just for simeple filtering
	adminId?: number | null;

	@ManyToOne(() => User, { nullable: true })
	@JoinColumn({ name: 'adminId' })
	admin?: Relation<User> | null;

	@Column()
	subscriptionId: number;

	@ManyToOne(() => Subscription, (sub) => sub.transactions)
	@JoinColumn({ name: 'subscriptionId' })
	subscription: Relation<Subscription>;

	@Column({ type: 'decimal', precision: 10, scale: 2 })
	amount: number;

	@Column({
		type: 'enum',
		enum: TransactionStatus,
		default: TransactionStatus.PROCESSING,
	})
	status: TransactionStatus;

	@Column({ type: 'enum', enum: TransactionPaymentMethod, nullable: true })
	paymentMethod?: TransactionPaymentMethod;

	@Column({ type: 'text', nullable: true })
	paymentProof?: string; // URL or filename

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;

}