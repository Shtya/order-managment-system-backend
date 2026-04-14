// --- File: backend/src/shipping/shipping.entity.ts ---
import {
	Entity,
	PrimaryGeneratedColumn,
	Column,
	CreateDateColumn,
	UpdateDateColumn,
	Index,
	ManyToOne,
	JoinColumn,
	OneToMany,
} from 'typeorm';
import { OrderEntity } from './order.entity';
import { User } from './user.entity';

export enum ShipmentStatus {
	CREATED = 'created',
	SUBMITTED = 'submitted',
	IN_TRANSIT = 'in_transit',
	DELIVERED = 'delivered',
	FAILED = 'failed',
	CANCELLED = 'cancelled',
}

export enum UnifiedShippingStatus {
	NEW = 'new',
	IN_PROGRESS = 'in_progress',
	PICKED_UP = 'picked_up',
	IN_TRANSIT = 'in_transit',
	DELIVERED = 'delivered',
	RETURNED = 'returned',
	EXCEPTION = 'exception',
	CANCELLED = 'cancelled',
	TERMINATED = 'terminated',
	LOST = 'lost',
	DAMAGED = 'damaged',
	ON_HOLD = 'on_hold',
	ACTION_REQUIRED = 'action_required',
	ARCHIVED = 'archived',
}



@Entity({ name: "shipping_companies" })
export class ShippingCompanyEntity {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: "varchar", length: 50 })
	@Index()
	code: string; // bosta | jt | turbo

	@Column({ type: "varchar", length: 100 })
	name: string;

	@Column({ type: "boolean", default: true })
	isActive: boolean;

	// ✅ UI metadata fields
	@Column({ type: "varchar", length: 255, nullable: true })
	logo?: string;

	@Column({ type: "varchar", length: 120, nullable: true })
	website?: string;

	@Column({ type: "text", nullable: true })
	bg?: string;

	@Column({ type: "text", nullable: true })
	description?: string; // store translation key like "integrated.description"

	@CreateDateColumn({ type: "timestamptz" })
	created_at: Date;

	@UpdateDateColumn({ type: "timestamptz" })
	updated_at: Date;



	@OneToMany(() => OrderEntity, (order) => order.shippingCompany)
	orders: OrderEntity[];
}



@Entity({ name: 'shipping_integrations' })
@Index(['adminId', 'shippingCompanyId'], { unique: true })
export class ShippingIntegrationEntity {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Index()
	@Column({ type: 'uuid', nullable: true })
	adminId: string;

	@ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
	@JoinColumn({ name: 'adminId' })
	admin: User;

	@Column({ type: 'int' })
	@Index()
	shippingCompanyId: string;

	@ManyToOne(() => ShippingCompanyEntity, { onDelete: 'CASCADE', eager: true })
	@JoinColumn({ name: 'shippingCompanyId' })
	shippingCompany: ShippingCompanyEntity;

	@Column({ type: 'boolean', default: true })
	isActive: boolean;

	@Column({ type: 'jsonb', nullable: true })
	credentials?: {
		apiKey?: string;
		accountId?: string;

		webhookHeaderName?: string; // custom header name in Bosta dashboard
		webhookSecret?: string;     // secret value
	} | null;

	@CreateDateColumn({ type: 'timestamptz' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamptz' })
	updated_at: Date;
}

@Entity({ name: 'shipments' })
@Index(['adminId', 'orderId'])
@Index(['adminId', 'shippingCompanyId'])
@Index(['trackingNumber'])
export class ShipmentEntity {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Index()
	@Column({ type: 'uuid', nullable: true })
	adminId: string;

	@ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
	@JoinColumn({ name: 'adminId' })
	admin: User;

	@Column({ type: 'uuid', nullable: false })
	@Index()
	orderId: string;

	@ManyToOne(() => OrderEntity, { nullable: false, onDelete: 'SET NULL' })
	@JoinColumn({ name: 'orderId' })
	order: OrderEntity;

	@Column({ type: 'uuid', })
	@Index()
	shippingCompanyId: string;

	@ManyToOne(() => ShippingCompanyEntity, { eager: true })
	@JoinColumn({ name: 'shippingCompanyId' })
	shippingCompany: ShippingCompanyEntity;

	@Column({ type: 'varchar', length: 120, nullable: true })
	providerShipmentId?: string | null;

	@Column({ type: 'varchar', length: 120, nullable: true })
	trackingNumber?: string | null;

	@Column({ type: 'enum', enum: ShipmentStatus, default: ShipmentStatus.CREATED })
	status: ShipmentStatus;

	@Column({ type: 'enum', enum: UnifiedShippingStatus, default: UnifiedShippingStatus.NEW })
	unifiedStatus: UnifiedShippingStatus;

	@Column({ type: 'jsonb', nullable: true })
	providerRaw?: any;

	@Column({ type: 'text', nullable: true })
	failureReason?: string | null;

	@CreateDateColumn({ type: 'timestamptz' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamptz' })
	updated_at: Date;
}

@Entity({ name: 'shipment_events' })
@Index(['shipmentId', 'created_at'])
export class ShipmentEventEntity {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', })
	@Index()
	shipmentId: string;

	@ManyToOne(() => ShipmentEntity, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'shipmentId' })
	shipment: ShipmentEntity;

	@Column({ type: 'varchar', length: 80 })
	source: 'bosta' | 'jt' | 'turbo' | 'aramex' | 'dhl' | 'system';

	@Column({ type: 'varchar', length: 80 })
	eventType: string;

	@Column({ type: 'jsonb', nullable: true })
	payload?: any;

	@CreateDateColumn({ type: 'timestamptz' })
	created_at: Date;
}
