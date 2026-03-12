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
	OneToOne,
} from 'typeorm';
import { Plan, Subscription, SubscriptionStatus } from './plans.entity';
import { Asset } from './assets.entity';
import { OrderAssignmentEntity } from './order.entity';
import { PaymentSessionEntity, Wallet } from './payments.entity';

/* =========================
 * Roles
 * ========================= */

export enum SystemRole {
	SUPER_ADMIN = 'super_admin',
	ADMIN = 'admin',
	USER = 'user',
}

@Entity('roles')
export class Role {
	@PrimaryGeneratedColumn()
	id: number;

	@Column({ unique: true })
	name: string;

	@Column({ nullable: true })
	description?: string;

	@Column({ type: 'simple-json', default: '[]' })
	permissionNames: string[];

	@Column({ type: 'int', nullable: true })
	adminId?: number | null;

	@ManyToOne(() => User, { nullable: true })
	@JoinColumn({ name: 'adminId' })
	admin?: Relation<User> | null;     // ✅ changed

	@Column({ default: false })
	isGlobal: boolean;

	@OneToMany(() => User, (user) => user.role)
	users: Relation<User>[];           // ✅ changed
}

@Entity('permissions')
export class Permission {
	@PrimaryGeneratedColumn()
	id: number;

	@Column({ unique: true })
	name: string; // ex: 'users.read', 'roles.update'
}

export enum OnboardingStatus {
	PENDING = 'pending',
	COMPLETED = 'completed',
}

export enum OnboardingStep {
	WELCOME = 'welcome',           // Step 0
	PLAN = 'plan',           // Step 1
	COMPANY = 'company',     // Step 2
	STORE = 'store',         // Step 3
	SHIPPING = 'shipping',   // Step 4
	FINISHED = 'finished',   // Final state
}

@Entity('users')
export class User {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	name: string;

	@Column({ unique: true })
	email: string;

	@Column({ type: 'varchar', nullable: true })
	phone?: string;

	@Column({ nullable: true })
	googleId: string;

	@Column({ type: 'varchar', nullable: true })
	avatarUrl?: string;

	@Column({ type: 'varchar', nullable: true })
	employeeType?: string;

	@Column({ nullable: true })
	passwordHash?: string;

	@Column()
	roleId: number;

	@ManyToOne(() => Role, (role) => role.users, { eager: true })
	@JoinColumn({ name: 'roleId' })
	role: Role;

	@Column({ type: 'int', nullable: true })
	adminId?: number | null;

	@ManyToOne(() => User, { nullable: true })
	@JoinColumn({ name: 'adminId' })
	admin?: User | null;

	@Column({ default: true })
	isActive: boolean;

	@Column({ nullable: true })
	resetPasswordTokenHash?: string | null;

	@Column({ type: 'bigint', nullable: true })
	resetPasswordExpiresAt?: number | null;

	@Column({ type: 'varchar', nullable: true })
	otpCodeHash: string | null;

	@Column({ type: 'bigint', nullable: true })
	otpExpiresAt: number | null;

	@Column({ type: 'boolean', default: false })
	otpVerified: boolean;

	@Column({ type: 'int', default: 0 })
	otpAttempts: number;


	@OneToMany(() => Asset, upload => upload.user)
	uploads: Asset[];

	// Inside User Entity
	@OneToMany(() => OrderAssignmentEntity, (assignment) => assignment.employee)
	assignments: OrderAssignmentEntity[];

	@OneToMany(() => Subscription, (subscription) => subscription.user, {
		cascade: true, // Allows saving subscriptions when saving a user
	})
	subscriptions: Relation<Subscription>[];

	get activeSubscription(): Subscription | null {
		if (!this.subscriptions || this.subscriptions.length === 0) {
			return null;
		}
		return this.subscriptions.find(s => s.status === SubscriptionStatus.ACTIVE) || null;
	}

	@Column({
		type: 'enum',
		enum: OnboardingStatus,
		default: OnboardingStatus.PENDING,
	})
	onboardingStatus: OnboardingStatus;

	@Column({
		type: 'enum',
		enum: OnboardingStep,
		default: OnboardingStep.WELCOME,
	})
	currentOnboardingStep: OnboardingStep;


	@OneToOne(() => Company, (company) => company.user, {
		cascade: true,
		nullable: true,
	})
	company: Relation<Company>;

	@Column({ type: 'varchar', nullable: true })
	pendingNewEmail: string | null;

	@Column({ type: 'varchar', nullable: true })
	newEmailOtpCodeHash: string | null;

	@Column({ type: 'bigint', nullable: true })
	newEmailOtpExpiresAt: number | null;

	@Column({ type: 'int', default: 0 })
	newEmailOtpAttempts: number;

	@OneToMany(() => PaymentSessionEntity, (session) => session.user)
	paymentSessions: PaymentSessionEntity[];

	// 🔗 Relation to Wallet
	@OneToOne(() => Wallet, (wallet) => wallet.user, { cascade: true })
	wallet: Relation<Wallet>;
	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}

@Entity('pending_users')
export class PendingUser {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	name: string;

	@Column({ unique: true })
	email: string;

	@Column()
	passwordHash: string;

	@Column({ nullable: true })
	phone: string;

	@Column({ nullable: true })
	companyName: string;

	@Column({ type: 'varchar', nullable: true })
	businessType: string;

	// --- OTP & Security Logic (Aligned with User Entity) ---

	@Column({ type: 'varchar', nullable: true })
	otpCodeHash: string | null;

	@Column({ type: 'bigint', nullable: true })
	otpExpiresAt: number | null; // Using bigint/number to match your Date.now() logic

	@Column({ type: 'int', default: 0 })
	otpAttempts: number;

	// --- Lifecycle & Cooldown ---

	@Column({ type: 'bigint', nullable: true })
	lastSentAt: number;

	// --- Roles ---

	@Column()
	roleId: number;

	@ManyToOne(() => Role, { eager: true })
	@JoinColumn({ name: 'roleId' })
	role: Role;


	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}

@Entity('companies')
export class Company {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	name: string;

	@Column({ nullable: true })
	country: string;

	@Column({ default: "EGP" })
	currency: string;

	@Column({ nullable: true })
	tax: string;

	@Column({ nullable: true })
	commercial: string;

	@Column({ nullable: true })
	phone: string;

	@Column({ nullable: true })
	website: string;

	@Column({ type: "text", nullable: true })
	address: string;

	@OneToOne(() => User, (user) => user.company)
	@JoinColumn()
	user: User;

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;

	@Column({ type: 'varchar', nullable: true })
	businessType: string;
}

