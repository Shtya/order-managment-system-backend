import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';
import { ProductEntity, ProductVariantEntity } from './sku.entity';
import { User } from './user.entity';
import { AutomationRunEntity } from './automation.entity';

export enum UpsellStatus {
    PENDING = 'pending',
    ACCEPTED = 'accepted',
    REJECTED = 'rejected',
    EXPIRED = 'expired',
    ACCEPTED_NON_ELIGIBLE = 'accepted_non_eligible',
    FAILED_TO_ADD = 'failed_to_add',
}

export interface UpsellMessageConfig {
    headerType: 'NONE' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
    headerText?: string;
    headerUrl?: string;
    headerHandle?: string; // Meta media handle
    bodyText: string;
    footerText?: string;
    buttons: Array<{ text: string }>;
}

@Index(['triggerProductId', 'upsellProductId', 'upsellSkuId', 'adminId', 'upsellPrice'], { unique: true })
@Entity('upsells')
export class Upsell {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' })
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Column({ type: 'uuid' })
    triggerProductId: string;

    @ManyToOne(() => ProductEntity)
    @JoinColumn({ name: 'triggerProductId' })
    triggerProduct: ProductEntity;

    @Column({ type: 'uuid' })
    upsellProductId: string;

    @ManyToOne(() => ProductEntity)
    @JoinColumn({ name: 'upsellProductId' })
    upsellProduct: ProductEntity;

    @Column({ type: 'uuid' })
    upsellSkuId: string;

    @ManyToOne(() => ProductVariantEntity)
    @JoinColumn({ name: 'upsellSkuId' })
    upsellSku: ProductVariantEntity;

    // ==========================================
    // Configuration Settings
    // ==========================================

    @Column({ type: 'int', nullable: true })
    expireTimeM: number;

    @Column({ type: 'decimal', precision: 10, scale: 2 })
    upsellPrice: number;

    @Column({ type: 'jsonb', nullable: true })
    messageConfig: UpsellMessageConfig;

    @Column({ type: 'boolean', default: true })
    isActive: boolean;

    @CreateDateColumn({ type: "timestamptz" })
    createdAt: Date;

    @UpdateDateColumn({ type: "timestamptz" })
    updatedAt: Date;
}

@Entity('upsell_history')
export class UpsellHistory {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid' })
    adminId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Column({ type: 'uuid' })
    upsellId: string;

    @ManyToOne(() => Upsell)
    @JoinColumn({ name: 'upsellId' })
    upsell: Upsell;

    @Column({ type: 'uuid', nullable: true })
    automationRunId: string;

    @ManyToOne(() => AutomationRunEntity, { onDelete: 'SET NULL' })
    @JoinColumn({ name: 'automationRunId' })
    automationRun: AutomationRunEntity;

    @Column({ type: 'uuid' })
    orderId: string;

    @Column({ type: 'varchar', nullable: true })
    messageId: string; // Meta message ID (wamid)

    @Column({ type: 'enum', enum: UpsellStatus, default: UpsellStatus.PENDING })
    status: UpsellStatus;

    @Column({ type: 'jsonb' })
    sentConfig: UpsellMessageConfig; // Snapshot of config at time of sending

     @Column({ type: 'uuid' })
    triggerProductId: string;

    @ManyToOne(() => ProductEntity)
    @JoinColumn({ name: 'triggerProductId' })
    triggerProduct: ProductEntity;

    @Column({ type: 'uuid' })
    upsellProductId: string;

    @ManyToOne(() => ProductEntity)
    @JoinColumn({ name: 'upsellProductId' })
    upsellProduct: ProductEntity;

    @Column({ type: 'uuid' })
    upsellSkuId: string;

    @ManyToOne(() => ProductVariantEntity)
    @JoinColumn({ name: 'upsellSkuId' })
    upsellSku: ProductVariantEntity;
    
    @Column({ type: 'decimal', precision: 10, scale: 2 })
    sentPrice: number;

    @Column({ type: 'timestamptz', nullable: true })
    respondedAt: Date;

    @Column({ type: 'timestamptz', nullable: true })
    expiresAt: Date;

    @CreateDateColumn({ type: "timestamptz" })
    createdAt: Date;
}