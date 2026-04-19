
import {
	Entity,
	PrimaryGeneratedColumn,
	Column,
	CreateDateColumn,
	Index,
	OneToOne,
	JoinColumn,
	Relation,
	ManyToOne,
	UpdateDateColumn,
} from "typeorm";
import { ProductEntity } from "./sku.entity";
import { StoreEntity } from "./stores.entity";
import { User } from "./user.entity";


export enum ProductSyncStatus {
	PENDING = 'pending',
	SYNCED = 'synced',
	FAILED = 'failed',
}

export interface ProductSyncStatusDto {
	remoteProductId: string | null;
	status: ProductSyncStatus;
	lastError: string | null;
	lastSynced_at: Date | null;

}

@Entity('product_sync_state')
@Index(['adminId', 'productId', 'storeId', 'externalStoreId'], { unique: true })
export class ProductSyncStateEntity {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	// 🔗 Local references
	@Column('uuid')
	productId: string;


	@ManyToOne(() => ProductEntity, (product) => product.syncStates, {
		onDelete: 'SET NULL',
	})
	@JoinColumn({ name: 'productId' })
	product: Relation<ProductEntity>;

	@Column('uuid')
	storeId: string;

	@ManyToOne(() => StoreEntity, { onDelete: 'SET NULL', })
	@JoinColumn({ name: 'storeId' })
	store: StoreEntity;

	@Index()
	@Column({ type: 'uuid', nullable: true })
	adminId: string;

	@ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
	@JoinColumn({ name: 'adminId' })
	admin: User;

	// 🌍 Remote mapping (IMPORTANT)
	@Column({ nullable: true })
	remoteProductId: string | null;

	@Column({ type: 'varchar', nullable: true })
	externalStoreId: string | null;

	// 📊 Sync status
	@Column({
		type: 'enum',
		enum: ProductSyncStatus,
		default: ProductSyncStatus.PENDING,
	})
	status: ProductSyncStatus;

	// ❗ Last error (for debugging + UI)
	@Column({ type: 'text', nullable: true })
	lastError: string | null;

	// ⏱️ Timestamps
	@Column({ type: 'timestamp', nullable: true })
	lastSynced_at: Date | null;

	@CreateDateColumn({ type: "timestamptz" })
	created_at: Date;

	@UpdateDateColumn({ type: "timestamptz" })
	updated_at: Date;
}

export enum ProductSyncAction {
	CREATE = 'create',
	UPDATE = 'update',
}

@Entity("product_sync_error_logs")
@Index(["adminId", "productId", "storeId"])
export class ProductSyncErrorLogEntity {
	@PrimaryGeneratedColumn("uuid")
	id: string;

	@Column("uuid")
	adminId: string;

	@ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
	@JoinColumn({ name: 'adminId' })
	admin: User;

	@Column("uuid")
	productId: string;

	@ManyToOne(() => ProductEntity, { onDelete: 'SET NULL', })
	@JoinColumn({ name: 'productId' })
	product: ProductEntity;

	@Column("uuid")
	storeId: string;

	@ManyToOne(() => StoreEntity, { onDelete: 'SET NULL', })
	@JoinColumn({ name: 'storeId' })
	store: StoreEntity;

	@Column({ nullable: true })
	remoteProductId: string | null;

	@Column({ type: "text", nullable: true })
	action: ProductSyncAction | null; // CREATE / UPDATE

	@Column({ type: "jsonb", nullable: true })
	requestPayload: Record<string, any> | null;

	@Column({ type: "text", nullable: true })
	errorMessage: string | null;

	@Column({ type: "int", nullable: true })
	responseStatus: number | null;

	@CreateDateColumn({ type: "timestamptz" })
	created_at: Date;
}