// --- File: entities/sku.entity.ts ---
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Code,
} from "typeorm";

import { StoreEntity } from "./stores.entity";
import { WarehouseEntity } from "./warehouses.entity";
import { CategoryEntity } from "./categories.entity";
import { User } from "./user.entity";
import { ActivatableEntity } from "./base.entity";

export type Money = number;

export interface ProductImage {
  url: string;
}

export type UpsellingProduct = {
  productId: string;
  label?: string;
  callCenterDescription?: string;
};

@Entity({ name: "products" })
@Index(["adminId", "name"])
@Index(["adminId", "slug"])
@Index(["adminId", "storeId", "slug"], { unique: true })
export class ProductEntity extends ActivatableEntity {
  @Column({ type: "varchar", length: 200 })
  @Index()
  name!: string;

  @Column({ type: "decimal", precision: 12, scale: 2, nullable: true })
  wholesalePrice?: number;

  @Column({ type: "decimal", precision: 12, scale: 2, nullable: true })
  lowestPrice?: number;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  salePrice: number;

  @Column({ type: "text", nullable: true })
  storageRack?: string;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  categoryId?: string | null;

  @ManyToOne(() => CategoryEntity, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "categoryId" })
  category?: CategoryEntity | null;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  storeId?: string | null;

  @ManyToOne(() => StoreEntity, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "storeId" })
  store?: StoreEntity | null;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  warehouseId?: string | null;

  @ManyToOne(() => WarehouseEntity, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "warehouseId" })
  warehouse?: WarehouseEntity | null;

  @Column({ type: "text", nullable: true })
  description?: string;

  @Column({ type: "text", nullable: true })
  callCenterProductDescription?: string;

  @Column({ type: "boolean", default: false })
  upsellingEnabled!: boolean;

  @Column({ type: "simple-json", nullable: false, default: "[]" })
  upsellingProducts!: UpsellingProduct[];

  @OneToMany(() => ProductVariantEntity, (variant) => variant.product)
  variants: ProductVariantEntity[];

  @Column({ type: "varchar", length: 300, nullable: false })
  slug: string;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId?: string;

  @Column({ type: "varchar", length: 500, nullable: false })
  mainImage!: string;

  @Column({ type: "simple-json", nullable: false, default: "[]" })
  images!: ProductImage[];

  @Column({ type: 'uuid', nullable: true })
  updatedByUserId?: string;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}

@Entity({ name: "product_variants" })
@Index(["adminId", "sku"], { unique: true, where: `"sku" IS NOT NULL` })
@Index(["adminId", "productId", "key"], { unique: true })
export class ProductVariantEntity extends ActivatableEntity{
  @Column({ type: "int" })
  @Index()
  productId!: string;

  @ManyToOne(() => ProductEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "productId" })
  product!: ProductEntity;

  @Column({ type: "varchar", length: 500 })
  key!: string;

  @Column({ type: "varchar", length: 120, nullable: true })
  @Index()
  sku?: string | null;

  // ✅ NEW: price per variant SKU
  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  price!: number;

  @Column({ type: "simple-json", nullable: false, default: "{}" })
  attributes!: Record<string, string>;

  @Column({ type: 'int', default: 0 })
  stockOnHand!: number;

  @Column({ type: "int", default: 0 })
  reserved!: number;

  @Column({ type: "varchar", length: 255, nullable: true })
  externalId?: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;

}
