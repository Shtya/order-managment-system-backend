import {
	Column,
	CreateDateColumn,
	Entity,
	Index,
	PrimaryGeneratedColumn,
	UpdateDateColumn,
	ManyToMany,
	JoinTable,
	ManyToOne,
	JoinColumn,
	Relation,
} from "typeorm";
import { SupplierClosingEntity } from "./accounting.entity";

@Entity({ name: "suppliers" })
@Index(["adminId", "name"])
@Index(["adminId", "phone"])
export class SupplierEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@Column({ nullable: true })
	@Index()
	adminId!: string | null;

	@Column({ type: "varchar", length: 120 })
	name!: string;

	@Column({ type: "varchar", length: 200, nullable: true })
	address?: string;

	@Column({ type: "text", nullable: true })
	description?: string;

	@Column({ type: "varchar", length: 30 })
	phone!: string;

	@Column({ type: "varchar", length: 10, nullable: true })
	phoneCountry?: string;

	@Column({ type: "varchar", length: 30, nullable: true })
	secondPhone?: string;

	@Column({ type: "varchar", length: 10, nullable: true })
	secondPhoneCountry?: string;

	@Column({ type: "varchar", length: 100, nullable: true })
	email?: string;

	// Financial fields
	@Column({ type: "decimal", precision: 20, scale: 2, default: 0 })
	dueBalance!: number; // الرصيد المستحق

	@Column({ type: "decimal", precision: 20, scale: 2, default: 0 })
	purchaseValue!: number; // قيمة المشتريات

	@ManyToMany(() => SupplierCategoryEntity, (category) => category.suppliers, {
		cascade: false,
	})
	@JoinTable({
		name: "supplier_category_assignments",
		joinColumn: { name: "supplierId", referencedColumnName: "id" },
		inverseJoinColumn: { name: "categoryId", referencedColumnName: "id" },
	})
	categories?: SupplierCategoryEntity[];

	@Column({ type: 'date', nullable: true })
	lastClosingEndDate: Date;

	@Column({ nullable: true })
	lastClosingId: number;

	@ManyToOne(() => SupplierClosingEntity)
	@JoinColumn({ name: 'lastClosingId' })
	lastClosing: Relation<SupplierClosingEntity>;

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;

	@UpdateDateColumn({ type: "timestamptz" })
	updated_at!: Date;
}


@Entity({ name: "supplier_categories" })
@Index(["adminId", "name"], { unique: true })
export class SupplierCategoryEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@Column({ nullable: true })
	@Index()
	adminId!: string | null;

	@Column({ type: "varchar", length: 100 })
	name!: string;

	@Column({ type: "varchar", length: 500, nullable: true })
	description?: string;

	@ManyToMany(() => SupplierEntity, (supplier) => supplier.categories)
	suppliers?: SupplierEntity[];

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;

	@UpdateDateColumn({ type: "timestamptz" })
	updated_at!: Date;
}