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
import { User } from "./user.entity";
import { WebhookOrderPayload } from "src/stores/storesIntegrations/BaseStoreProvider";

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
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Index()
	@Column({ type: 'uuid', nullable: true })
	adminId: string;

	@ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
	@JoinColumn({ name: 'adminId' })
	admin: User;

	// Store identification
	@Column({ type: "varchar", length: 120 })
	name!: string; // e.g., "My EasyOrder Store", "Shopify Main Store"

	@Column({ type: "varchar" })
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

	@Column({ type: "boolean", default: false })
	isIntegrated!: boolean;

	@Column({ type: "boolean", default: true })
	syncNewProducts!: boolean;

	@Column({
		type: "enum",
		enum: SyncStatus,
		default: SyncStatus.PENDING,
	})
	syncStatus!: SyncStatus;

	@Column({ type: "timestamptz", nullable: true })
	lastSyncAttemptAt?: Date;

	@Column({ type: "varchar", nullable: true })
	externalStoreId?: string;

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
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', })
	@Index()
	storeId: string;

	@Column({ type: 'varchar' })
	externalId: string;

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

export enum WebhookOrderProblem {
	PRODUCT_NOT_FOUND = 'PRODUCT_NOT_FOUND',
	SKU_NOT_FOUND = 'SKU_NOT_FOUND',
	INSUFFICIENT_STOCK = 'INSUFFICIENT_STOCK',
}

@Entity({ name: "webhook_order_failures" })
@Index(["adminId", "storeId", "externalOrderId"], {
	unique: true,
	where: '"externalOrderId" IS NOT NULL'
})
export class WebhookOrderFailureEntity {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Index()
	@Column({ type: 'uuid', nullable: true })
	adminId: string;

	@ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
	@JoinColumn({ name: 'adminId' })
	admin: User;

	@Column({ type: "int", default: 0 })
	attempts: number;

	@Column({ type: 'uuid', nullable: false })
	storeId: string;

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
	rawPayload: any;

	@Column({ type: "jsonb" })
	payload: WebhookOrderPayload;

	// optional reason/message for failure
	@Column({ type: "text", nullable: true })
	reason?: string;

	@Column({ type: "text", nullable: true })
	lastRetryFailedReason?: string;

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;

	@Column({ type: "enum", enum: OrderFailStatus, default: OrderFailStatus.PENDING })
	status: OrderFailStatus;
}