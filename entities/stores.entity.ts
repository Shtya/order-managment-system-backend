/* 
	
*/

import {
	Column,
	CreateDateColumn,
	Entity,
	Index,
	PrimaryGeneratedColumn,
	UpdateDateColumn,
} from "typeorm";

export enum StoreProvider {
	EASYORDER = 'easyorder',
	SHOPIFY = 'shopify',
	WOOCOMMERCE = 'woocommerce',
}

export enum SyncStatus {
	PENDING = 'pending',
	SYNCING = 'syncing',
	SYNCED = 'synced',
	FAILED = 'failed',
}

@Entity({ name: "stores" })
@Index(["adminId", "code"], { unique: true })
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

	@Column({ type: "varchar", length: 50 })
	code!: string; // Slug for identification, unique per tenant

	@Column({
		type: "enum",
		enum: StoreProvider
	})
	provider!: StoreProvider;

	// Provider-specific configuration
	@Column({ type: 'text' })
	encryptedData: string; // The encrypted JSON string containing keys/tokens

	@Column({ type: 'varchar', length: 255 })
	iv: string; // Hex initialization vector

	@Column({ type: 'varchar', length: 255 })
	tag: string; // Hex auth tag for GCM integrity

	@Column({ type: "boolean", default: true })
	isActive!: boolean;

	@Column({
		type: "enum",
		enum: SyncStatus,
		default: SyncStatus.PENDING,
	})
	syncStatus!: SyncStatus;

	@Column({ type: "boolean", default: true })
	autoSync!: boolean;

	@Column({ type: "timestamptz", nullable: true })
	lastSyncAttemptAt?: Date;

	@Column({ type: "varchar", nullable: true })
	onlineStorePublicationId?: string;

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;

	@UpdateDateColumn({ type: "timestamptz" })
	updated_at!: Date;

}
