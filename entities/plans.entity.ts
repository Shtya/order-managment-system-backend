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
import { TransactionEntity } from './payments.entity';

/* =========================
 * Plans & Subscriptions
 * ========================= */


export enum PlanColor {
	BLUE = 'from-blue-500 to-blue-600',
	PURPLE = 'from-purple-500 to-purple-600',
	ORANGE = 'from-orange-500 to-orange-600',
	GREEN = 'from-green-500 to-green-600',
	PINK = 'from-pink-500 to-pink-600',
	CYAN = 'from-cyan-500 to-cyan-600',
}
export enum PlanDuration {
	CUSTOM = 'custom',
	MONTHLY = 'monthly',
	YEARLY = 'yearly',
	LIFETIME = 'lifetime',
}


export enum PlanType {
	TRIAL = 'trial',
	STANDARD = 'standard', // Has a defined price/logic (includes Fixed, Hybrid, PAYG)
	NEGOTIATED = 'negotiated' // Price is hidden/zero; requires contacting support/admin
}

@Entity('plans')
@Index(['name'])
export class Plan {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	name: string;

	@Column({
		type: 'enum',
		enum: PlanDuration,
		default: PlanDuration.MONTHLY,
	})
	duration: PlanDuration;

	@Column({ type: 'int', nullable: true })
	durationIndays: number | null; // for custom plans

	@Column({
		type: 'enum',
		enum: PlanType,
		default: PlanType.STANDARD,
	})
	type: PlanType;

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

	// number of orders included in the base price
	@Column({ type: 'int', nullable: true })
	includedOrders: number | null; // null = Unlimited

	@Column({ type: 'int', default: 1, nullable: true })
	usersLimit: number | null; // null = Unlimited (غير محدود);

	@Column({ type: 'int', default: 1, nullable: true })
	storesLimit: number | null; // null = Unlimited (غير محدود);

	@Column({ type: 'int', default: 1, nullable: true })
	shippingCompaniesLimit: number | null; // null = Unlimited (غير محدود);

	// --- Pricing & Extras ---

	@Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
	extraOrderFee: number | null; // Fee per order after includedOrders is exceeded (e.g., 0.65) || null mean not allow to exeed the includedOrders

	@Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
	price: number | null; //base fee
	//

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
	PENDING = 'pending',
	ACTIVE = 'active',
	CANCELLED = 'cancelled',
	EXPIRED = 'expired',
}

@Index(["userId", "status"])
@Index('IDX_ONE_ACTIVE_SUBSCRIPTION_PER_USER', ['userId'], {
	unique: true,
	where: `"status" = 'active'`
})
@Index('IDX_SUBSCRIPTION_PLAN_STATUS', ['planId', 'status'])
@Index('IDX_SUBSCRIPTION_EXPIRY', ['status', 'endDate'])
@Entity('subscriptions')
export class Subscription {
	@PrimaryGeneratedColumn()
	id: number;

	@Column({ nullable: true })
	userId: number;

	@Column({
		type: 'enum',
		enum: PlanDuration,
		default: PlanDuration.MONTHLY,
	})
	duration: PlanDuration;

	@Column({ type: 'int', nullable: true })
	durationIndays: number | null; // for custom plans

	// Changed to ManyToOne because a user has a history of many subscriptions
	@ManyToOne(() => User, (user) => user.subscriptions, { nullable: true })
	@JoinColumn({ name: 'userId' })
	user: Relation<User>;

	@Column({ nullable: true })
	planId: number | null; // Nullable so history remains if plan is deleted

	@ManyToOne(() => Plan, (plan) => plan.subscriptions, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'planId' })
	plan: Relation<Plan>;

	// --- Plan Snapshots (Data frozen at time of purchase) ---

	@Column({ type: 'enum', enum: PlanType, default: PlanType.STANDARD })
	planType: PlanType;

	@Column({ type: 'decimal', precision: 10, scale: 2 })
	price: number; // Base paid fee

	@Column({ type: 'int', nullable: true })
	includedOrders: number | null;

	@Column({ type: 'int', default: 0 })
	usedOrders: number;

	@Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
	extraOrderFee: number | null;

	@Column({ type: 'int', default: 1, nullable: true })
	usersLimit: number | null;

	@Column({ type: 'int', default: 1, nullable: true })
	storesLimit: number | null;

	@Column({ type: 'int', default: 1, nullable: true })
	shippingCompaniesLimit: number | null;

	@Column({ type: 'int', default: 0 })
	bulkUploadPerMonth: number;

	// --- Subscription Specifics ---

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

	@OneToMany(() => TransactionEntity, (transaction) => transaction.subscription)
	transactions: Relation<TransactionEntity>[];


	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}

export enum FeatureType {
	WHATSAPP_CONFIRMATION = 'whatsapp_confirmation',
	AI_ANALYTICS = 'ai_analytics',
	FRAUD_DETECTION = 'fraud_detection',
}

@Entity('features')
export class Feature {
	@PrimaryGeneratedColumn()
	id: number;

	@Column({ type: 'enum', enum: FeatureType, unique: true })
	type: FeatureType;

	@Column()
	name: string;

	@Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
	price: number;

	@Column({ default: true })
	isActive: boolean;

	@OneToMany(() => UserFeature, (userFeature) => userFeature.feature)
	userFeatures: Relation<UserFeature[]>;
}


@Entity('user_features')
@Index(['userId', 'featureId', 'status'])
export class UserFeature {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	userId: number;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'userId' })
	user: Relation<User>;

	@Column()
	featureId: number;

	@ManyToOne(() => Feature, (feature) => feature.userFeatures)
	@JoinColumn({ name: 'featureId' })
	feature: Relation<Feature>;

	@Column({ type: 'enum', enum: SubscriptionStatus, default: SubscriptionStatus.PENDING })
	status: SubscriptionStatus;

	@Column({ type: 'decimal', precision: 10, scale: 2 })
	priceAtPurchase: number; // Snapshot

	@Column({ type: 'timestamptz' })
	startDate: Date;

}