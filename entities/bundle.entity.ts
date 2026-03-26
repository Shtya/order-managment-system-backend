// --- File: entities/bundle.entity.ts ---
import {
	Entity,
	PrimaryGeneratedColumn,
	Column,
	CreateDateColumn,
	Index,
	ManyToOne,
	OneToMany,
	JoinColumn,
} from "typeorm";
import { ProductVariantEntity } from "./sku.entity";
import { StoreEntity } from "./stores.entity";

@Entity({ name: "bundles" })
@Index(["adminId", "sku"], { unique: true })
@Index(["adminId", "name"])
export class BundleEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	@Index()
	adminId!: string;

	@Column({ type: "varchar", length: 200 })
	name!: string;

	@Column({ type: "text", nullable: true })
	description?: string;

	@Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
	price!: number;

	@Column({ type: "varchar", length: 120 })
	@Index()
	sku!: string;

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;

	@OneToMany(() => BundleItemEntity, (it) => it.bundle, { cascade: ["insert", "update"] })
	items!: BundleItemEntity[];

	@Column({ type: "int", nullable: true })
	@Index()
	variantId!: number;

	@ManyToOne(() => ProductVariantEntity, { nullable: true })
	@JoinColumn({ name: "variantId" })
	variant!: ProductVariantEntity;

	@Column({ type: "int", nullable: true })
	@Index()
	storeId?: number | null;

	@ManyToOne(() => StoreEntity, { nullable: true, onDelete: "SET NULL" })
	@JoinColumn({ name: "storeId" })
	store?: StoreEntity | null;
}

@Entity({ name: "bundle_items" })
@Index(["adminId", "bundleId"])
export class BundleItemEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	@Index()
	adminId!: string;

	@Column({ type: "int" })
	@Index()
	bundleId!: number;

	@ManyToOne(() => BundleEntity, (b) => b.items)
	@JoinColumn({ name: "bundleId" })
	bundle!: BundleEntity;

	@Column({ type: "int" })
	@Index()
	variantId!: number;

	@ManyToOne(() => ProductVariantEntity)
	@JoinColumn({ name: "variantId" })
	variant!: ProductVariantEntity;

	@Column({ type: "int" })
	qty!: number;
}
