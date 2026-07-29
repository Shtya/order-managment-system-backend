import {
	Column,
	CreateDateColumn,
	Entity,
	Index,
	PrimaryGeneratedColumn,
	UpdateDateColumn,
	OneToMany,
	ManyToOne,
	JoinColumn,
} from "typeorm";
import { User } from "./user.entity";

export enum StorageLocationType {
	ZONE = "zone",
	//منطقة
	// تقسيم كبير داخل المستودع، مثل منطقة المنتجات الغذائية أو الأجهزة أو منطقة الشحن
	RACK = "rack",
	//الهيكل المعدني
	//الهيكل المعدني الكبير الذي يحتوي على رفوف تخزين
	SHELF = "shelf",
	//رف تخزين
	//كل رف يحتوي على عدة مستويات أفقية لوضع البضائع
	BIN = "bin",
	// موضع
	/// مكان محدد على الرف لوضع المنتج
}

export const STORAGE_LOCATION_CHILDREN: Record<
	StorageLocationType,
	StorageLocationType[]
> = {
	[StorageLocationType.ZONE]: [
		StorageLocationType.RACK,
	],

	[StorageLocationType.RACK]: [
		StorageLocationType.SHELF,
	],

	[StorageLocationType.SHELF]: [
		StorageLocationType.BIN,
	],

	[StorageLocationType.BIN]: [],
};

@Entity({ name: "warehouses" })
@Index(["adminId", "name"], { unique: true })
export class WarehouseEntity {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Index()
	@Column({ type: 'uuid', nullable: true })
	adminId: string;

	@ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
	@JoinColumn({ name: 'adminId' })
	admin: User;

	@Column({ type: "varchar", length: 120 })
	name: string;

	@Column({
		nullable: true
	})
	description?: string;

	@Column({ type: "varchar", length: 160, nullable: true })
	address?: string;

	@OneToMany(
		() => StorageLocationEntity,
		location => location.warehouse
	)
	locations: StorageLocationEntity[];

	@Column({ type: "boolean", default: true })
	isActive!: boolean;

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;

	@UpdateDateColumn({ type: "timestamptz" })
	updated_at!: Date;
}


@Entity("storage_locations")
export class StorageLocationEntity {

	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Index()
	@Column({ type: 'uuid', nullable: true })
	adminId: string;

	@ManyToOne(() => User, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'adminId' })
	admin: User;

	@Index()
	@Column({ type: 'uuid', nullable: true })
	warehouseId: string;

	@ManyToOne(() => WarehouseEntity, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'warehouseId' })
	warehouse: WarehouseEntity;

	@Column()
	name: string;

	@Column({
		type: "enum",
		enum: StorageLocationType
	})
	type: StorageLocationType;

	@Column({ default: true })
	isActive!: boolean;


	// Parent location
	@Column({
		type: 'uuid',
		nullable: true
	})
	parentId?: string;


	@ManyToOne(
		() => StorageLocationEntity,
		location => location.children,
		{
			nullable: true,
			onDelete: "SET NULL"
		}
	)
	parent?: StorageLocationEntity;


	// Child locations
	@OneToMany(
		() => StorageLocationEntity,
		location => location.parent
	)
	children: StorageLocationEntity[];

	@Column({
		nullable: true
	})
	description?: string;

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;

	@UpdateDateColumn({ type: "timestamptz" })
	updated_at!: Date;
}
