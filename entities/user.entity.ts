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
import { Plan } from './plans.entity';
import { Asset } from './assets.entity';

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

	@Column({ type: 'int', nullable: true })
	planId?: number | null;

	@ManyToOne(() => Plan, (plan) => plan.users, { nullable: true })
	@JoinColumn({ name: 'planId' })
	plan?: Relation<Plan> | null;

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

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}
