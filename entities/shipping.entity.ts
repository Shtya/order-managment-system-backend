import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

@Entity({ name: "shipping_companies" })
export class ShippingCompanyEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@Column({ type: "varchar", length: 100 })
	name: string; // e.g., "DHL", "Aramex"

	@Column()
	@Index()
	adminId!: string; // Ensures multi-tenancy [2025-12-24]

	@Column({ type: "boolean", default: true })
	isActive: boolean;

	@CreateDateColumn({ type: "timestamptz" })
	created_at: Date;

	@UpdateDateColumn({ type: "timestamptz" })
	updated_at: Date;
 
	@Column({ type: "varchar", length: 50 , nullable : true })
	@Index()
	code: string; // 'bosta' | 'aramex' | 'dhl'

}