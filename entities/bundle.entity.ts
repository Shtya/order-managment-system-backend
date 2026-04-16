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
import { User } from "./user.entity";
import { ActivatableEntity } from "./base.entity";

@Entity({ name: "bundles" })
@Index(["adminId", "sku"], { unique: true })
@Index(["adminId", "name"])
export class BundleEntity extends ActivatableEntity {

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

	@Column({ type: 'uuid', nullable: true })
	@Index()
	variantId!: string;

	@ManyToOne(() => ProductVariantEntity, { nullable: true })
	@JoinColumn({ name: "variantId" })
	variant!: ProductVariantEntity;

	@Column({ type: 'uuid', nullable: true })
	@Index()
	storeId?: string | null;

	@ManyToOne(() => StoreEntity, { nullable: true, onDelete: "SET NULL" })
	@JoinColumn({ name: "storeId" })
	store?: StoreEntity | null;
}

@Entity({ name: "bundle_items" })
@Index(["adminId", "bundleId"])
export class BundleItemEntity extends ActivatableEntity {
	@Column({ type: 'uuid', })
	@Index()
	bundleId!: string;

	@ManyToOne(() => BundleEntity, (b) => b.items)
	@JoinColumn({ name: "bundleId" })
	bundle!: BundleEntity;

	@Column({ type: 'uuid', })
	@Index()
	variantId!: string;

	@ManyToOne(() => ProductVariantEntity)
	@JoinColumn({ name: "variantId" })
	variant!: ProductVariantEntity;

	@Column({ type: "int" })
	qty!: number;
}
