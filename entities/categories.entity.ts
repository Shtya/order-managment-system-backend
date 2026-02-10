import {
	Entity,
	PrimaryGeneratedColumn,
	Column,
	Index,
	CreateDateColumn,
} from "typeorm";

@Entity({ name: "categories" })
@Index(["adminId", "name"], { unique: true })
@Index(["adminId", "slug"], { unique: true })
export class CategoryEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@Column({ nullable: true })
	@Index()
	adminId!: string | null;

	@Column({ type: "varchar", length: 160 })
	name!: string;

	@Column({ type: "varchar", length: 200 })
	slug!: string;

	@Column({ type: "varchar", length: 400, nullable: true })
	image?: string;

	@CreateDateColumn({ type: "timestamptz" })
	created_at!: Date;

	// @BeforeInsert()
	// @BeforeUpdate()
	// generateSlug() {
	// 	if (!this.name) return;

	// 	if (!this.slug || this.slug.trim().length === 0) {
	// 		this.slug = slugify(this.name).slice(0, 200);
	// 	}
	// }
}


function slugify(value: string): string {
	return value
		.toString()
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\u0600-\u06FFa-z0-9-]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}
