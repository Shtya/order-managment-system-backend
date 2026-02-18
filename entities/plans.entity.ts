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

	@OneToMany(() => User, (user) => user.plan)
	users: Relation<User>[];

	@OneToMany(() => Transaction, (transaction) => transaction.plan)
	transactions: Relation<Transaction>[];

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}

export enum TransactionStatus {
	ACTIVE = 'نشط',
	PROCESSING = 'تحويل جاري',
	COMPLETED = 'مكتمل',
	CANCELLED = 'ملغى',
}

@Entity('transactions')
export class Transaction {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	userId: number;

	@ManyToOne(() => User, { eager: true })
	@JoinColumn({ name: 'userId' })
	user: Relation<User>;

	@Column()
	planId: number;

	@ManyToOne(() => Plan, (plan) => plan.transactions, { eager: true })
	@JoinColumn({ name: 'planId' })
	plan: Relation<Plan>;

	@Column({ type: 'decimal', precision: 10, scale: 2 })
	amount: number;

	@Column({
		type: 'enum',
		enum: TransactionStatus,
		default: TransactionStatus.PROCESSING,
	})
	status: TransactionStatus;

	@Column({ type: 'varchar', nullable: true })
	paymentMethod?: string;

	@Column({ type: 'text', nullable: true })
	paymentProof?: string; // URL or filename

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

