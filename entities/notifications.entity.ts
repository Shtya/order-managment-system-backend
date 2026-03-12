import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { User } from "./user.entity";

export enum NotificationType {
    ORDER_STATUS_UPDATE = 'order_status_update',
    SUBSCRIPTION_ACTIVATED = 'subscription_activated',
    SUBSCRIPTION_CANCELLED = 'subscription_cancelled',
    FEATURE_ACTIVATED = 'feature_activated',
    WALLET_TOP_UP = 'wallet_top_up',
    WALLET_CREDIT = 'wallet_credit',
    SYSTEM_ALERT = 'system_alert',
    PAYMENT_FAILED = 'payment_failed',
}

@Entity('notifications')
@Index(['userId', 'type', 'isRead'])
@Index(['userId', 'isRead'])
export class Notification {
    @PrimaryGeneratedColumn()
    id: number;

    // The actual relation
    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'user_id' })
    user: User;

    @Column({ name: 'user_id' })
    userId: number;

    @Column({
        type: 'enum',
        enum: NotificationType,
    })
    type: NotificationType; // 👈 Changed from string to Enum

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
