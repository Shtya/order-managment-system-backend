// --- File: entities/sku.entity.ts ---
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from "typeorm";

import { StoreEntity } from "./stores.entity";
import { WarehouseEntity } from "./warehouses.entity";
import { CategoryEntity } from "./categories.entity";

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
export class ProductEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  adminId!: string;

  @Column({ type: "varchar", length: 200 })
  @Index()
  name!: string;

  @Column({ type: "int", nullable: true })
  wholesalePrice?: Money;

  @Column({ type: "int", nullable: true })
  lowestPrice?: Money;

  @Column({ type: "text", nullable: true })
  storageRack?: string;

  @Column({ type: "int", nullable: true })
  @Index()
  categoryId?: number | null;

  @ManyToOne(() => CategoryEntity, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "categoryId" })
  category?: CategoryEntity | null;

  @Column({ type: "int", nullable: true })
  @Index()
  storeId?: number | null;

  @ManyToOne(() => StoreEntity, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "storeId" })
  store?: StoreEntity | null;

  @Column({ type: "int", nullable: true })
  @Index()
  warehouseId?: number | null;

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

  @Column({ type: "int", nullable: true })
  createdByUserId?: number;

  @Column({ type: "varchar", length: 500, nullable: false })
  mainImage!: string;

  @Column({ type: "simple-json", nullable: false, default: "[]" })
  images!: ProductImage[];

  @Column({ type: "int", nullable: true })
  updatedByUserId?: number;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}

@Entity({ name: "product_variants" })
@Index(["adminId", "sku"], { unique: true, where: `"sku" IS NOT NULL` })
@Index(["adminId", "productId", "key"], { unique: true })
export class ProductVariantEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  adminId!: string;

  @Column({ type: "int" })
  @Index()
  productId!: number;

  @ManyToOne(() => ProductEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "productId" })
  product!: ProductEntity;

  @Column({ type: "varchar", length: 500 })
  key!: string;

  @Column({ type: "varchar", length: 120, nullable: true })
  @Index()
  sku?: string | null;

  // ✅ NEW: price per variant SKU
  @Column({ type: "int", nullable: true })
  price?: Money;

  @Column({ type: "simple-json", nullable: false, default: "{}" })
  attributes!: Record<string, string>;

  @Column({ type: "int", default: 0 })
  stockOnHand!: number;

  @Column({ type: "int", default: 0 })
  reserved!: number;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}
