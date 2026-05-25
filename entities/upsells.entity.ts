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

export interface UpsellMessageConfig {
    headerType: 'NONE' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
    headerText?: string;
    headerUrl?: string;
    headerHandle?: string; // Meta media handle
    bodyText: string;
    footerText?: string;
    buttons: Array<{ text: string }>;
}

@Index(['triggerProductId', 'upsellProductId', 'upsellSkuId'], { unique: true })
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