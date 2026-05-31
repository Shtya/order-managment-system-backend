import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { User } from "./user.entity";
import { ConversationEntity } from "./whatsapp.entity";

@Index(['adminId', 'waId'], { unique: true })
@Index(['adminId', 'phoneNumber'], { unique: true })
@Entity('customers')
export class CustomerEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid' })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
    @JoinColumn({ name: 'adminId' })
    admin: User;

    // WhatsApp unique identity
    @Column({ type: 'varchar', length: 50 })
    waId: string;

    @Index()
    @Column({ type: 'varchar', length: 50 })
    phoneNumber: string;

    @Column({ type: 'varchar', nullable: true })
    name: string;

    @Column({ type: 'varchar', nullable: true })
    profilePicture: string;

    @Column({ type: 'varchar', nullable: true })
    email: string;

    @Column({ type: 'text', nullable: true })
    notes: string;

    @Column({ type: 'timestamptz', nullable: true })
    lastMessageAt: Date;

    @Column({ type: 'jsonb', nullable: true })
    metadata: any;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt: Date;

    // Relations
    @OneToMany(() => ConversationEntity, (c) => c.customer)
    conversations: ConversationEntity[];
}