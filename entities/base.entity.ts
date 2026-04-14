import { Column, Index, CreateDateColumn, UpdateDateColumn, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';
import { User } from './user.entity';

export abstract class ActivatableEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Column({ type: 'boolean', default: true })
    isActive: boolean;

    @Column({ type: 'timestamptz', nullable: true })
    deactivatedAt?: Date | null;
}