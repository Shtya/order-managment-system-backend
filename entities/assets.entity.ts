// entities/assets.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne } from 'typeorm';
import { User } from './user.entity';

@Entity('assets')
export class Asset {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	filename: string;

	@Column()
	url: string;

	@Column({ nullable: true })
	mimeType: string;

	@ManyToOne(() => User, user => user.uploads, { eager: false, onDelete: 'SET NULL' })
	user: User;

	@CreateDateColumn()
	created_at: Date;

	@UpdateDateColumn()
	updated_at: Date;
}
