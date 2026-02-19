import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { User } from "./user.entity";


@Entity('notifications')
export class Notification {
    @PrimaryGeneratedColumn()
    id: number;

    // The actual relation
    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'user_id' })
    user: User;

    @Column({ name: 'user_id' })
    userId: number;

    @Column()
    type: string;

    @Column()
    title: string;

    @Column({ type: 'text' })
    message: string;

    @Column({ name: 'is_read', default: false })
    isRead: boolean;

    @Column({ name: 'related_entity_type', nullable: true })
    relatedEntityType: string;

    @Column({ name: 'related_entity_id', nullable: true })
    relatedEntityId: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}