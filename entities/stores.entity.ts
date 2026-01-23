/* 
	
*/

import {
	Column,
	CreateDateColumn,
	Entity,
	Index,
	PrimaryGeneratedColumn,
	UpdateDateColumn,
	OneToMany,
} from "typeorm"; 


@Entity({ name: "stores" })
@Index(["adminId", "code"], { unique: true })
@Index(["adminId", "name"])
export class StoreEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@Column({ nullable: true })
	@Index()
	adminId!: string | null;

	@Column({ type: "varchar", length: 120 })
	name!: string;

	@Column({ type: "varchar", length: 50 })
	code!: string;

	@Column({ type: "boolean", default: true })
	isActive!: boolean;

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;

}
