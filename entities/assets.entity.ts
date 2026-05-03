// entities/assets.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne } from 'typeorm';
import { User } from './user.entity';

@Entity('assets')
export class Asset {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column()
	filename: string;

	@Column()
	url: string;

	@Column({ nullable: true })
	mimeType: string;

	@ManyToOne(() => User, user => user.uploads, { eager: false, onDelete: 'SET NULL' })
	user: User;

	@CreateDateColumn({ type: "timestamptz" })
	created_at: Date;

	@UpdateDateColumn({ type: "timestamptz" })
	updated_at: Date;
}
