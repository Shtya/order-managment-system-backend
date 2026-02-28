/* 
	
*/

import {
	Column,
	CreateDateColumn,
	Entity,
	In,
	Index,
	JoinColumn,
	ManyToOne,
	PrimaryGeneratedColumn,
	UpdateDateColumn,
} from "typeorm";

export enum StoreProvider {
	EASYORDER = 'easyorder',
	SHOPIFY = 'shopify',
	WOOCOMMERCE = 'woocommerce',
}

export enum OrderFailStatus {
	PENDING = 'pending',
	RETRYING = 'retrying',
	SUCCESS = 'success',
	FAILED = 'failed',
}

export enum SyncStatus {
	PENDING = 'pending',
	SYNCING = 'syncing',
	SYNCED = 'synced',
	FAILED = 'failed',
}

@Entity({ name: "stores" })
// @Index(["adminId", "code"], { unique: true })
@Index(["adminId", "name"])
@Index(["adminId", "isActive"])
export class StoreEntity {
	@PrimaryGeneratedColumn()
	id: number;

	// Tenant ownership
	@Column({ nullable: true })
	@Index()
	adminId!: string | null;

	// Store identification
	@Column({ type: "varchar", length: 120 })
	name!: string; // e.g., "My EasyOrder Store", "Shopify Main Store"

	@Column({ type: "varchar", unique: true })
	storeUrl!: string;

	@Column({
		type: "enum",
		enum: StoreProvider
	})
	provider!: StoreProvider;


	@Column({ type: 'jsonb', nullable: true })
	credentials?: {
		apiKey?: string;
		clientSecret?: string;
		webhookCreateOrderSecret?: string;     // secret value for easyorder and woocomerce
		webhookUpdateStatusSecret?: string;     // secret value for easyorder and woocomerce
		webhookSecret?: string;     // secret value for shopify (same for create/update)
	} | null;

	@Column({ type: "boolean", default: true })
	isActive!: boolean;

	@Column({
		type: "enum",
		enum: SyncStatus,
		default: SyncStatus.PENDING,
	})
	syncStatus!: SyncStatus;

	@Column({ type: "timestamptz", nullable: true })
	lastSyncAttemptAt?: Date;

	@Column({ type: "varchar", nullable: true })
	onlineStorePublicationId?: string;

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;

	@UpdateDateColumn({ type: "timestamptz" })
	updated_at!: Date;

}



@Entity({ name: 'store_events' })
@Index(['storeId', 'created_at'])
export class StoreEventEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@Column({ type: 'int' })
	@Index()
	storeId: number;

	@Column({ type: 'int' })
	externalId: number;

	@ManyToOne(() => StoreEntity, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'storeId' })
	store: StoreEntity;

	@Column({
		type: "enum",
		enum: StoreProvider
	})
	source!: StoreProvider;

	@Column({ type: 'varchar', length: 80 })
	eventType: 'order_created' | 'order_updated';

	@Column({ type: 'jsonb', nullable: true })
	payload?: any;

	@CreateDateColumn({ type: 'timestamptz' })
	created_at: Date;
}


@Entity({ name: "webhook_order_failures" })
@Index(["adminId", "storeId", "externalOrderId"], { unique: true })
export class WebhookOrderFailureEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@Column({ type: "varchar", length: 50 })
	adminId: string;

	@Column({ type: "int", default: 0 })
	attempts: number;

	@Column({ type: "int", nullable: false })
	storeId: number;

	@Column({ type: "varchar", nullable: true })
	externalOrderId: string;

	@ManyToOne(() => StoreEntity, { nullable: false })
	@JoinColumn({ name: "storeId" })
	store: StoreEntity;

	// ✅ Customer Information
	@Column({ type: "varchar", length: 200, nullable: true })
	customerName: string;

	@Column({ type: "varchar", length: 50, nullable: true })
	phoneNumber: string;

	// raw payload received from the provider (not transformed)
	@Column({ type: "jsonb" })
	payload: any;

	// optional reason/message for failure
	@Column({ type: "text", nullable: true })
	reason?: string;

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;

	@Column({ type: "enum", enum: OrderFailStatus, default: OrderFailStatus.PENDING })
	status: OrderFailStatus;
}
