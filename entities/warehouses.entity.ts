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
import { ProductEntity } from "./sku.entity";
import { User } from "./user.entity";

export type WarehouseStatus = "active" | "inactive";

@Entity({ name: "warehouses" })
@Index(["adminId", "name"])
export class WarehouseEntity {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Index()
	@Column({ type: 'uuid', nullable: true })
	adminId: string;

	@ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
	@JoinColumn({ name: 'adminId' })
	admin: User;

	@Column({ type: "varchar", length: 120, nullable: true })
	name: string;

	@Column({ type: "varchar", length: 160, nullable: true })
	location?: string;

	@ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
	@JoinColumn({ name: "managerUserId" })
	manager?: User | null;

	@Column({ type: "varchar", length: 30, nullable: true })
	phone?: string;


	@Column({ type: "boolean", default: true })
	isActive!: boolean;

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;
}
