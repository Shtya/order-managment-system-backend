import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { OrderEntity } from "./order.entity";
import { ShippingCompanyEntity } from "./shipping.entity";
import { User } from "./user.entity";

// src/entities/payment-source.enum.ts
export enum PaymentSource {
    // Standard Methods
    VISA = "visa",
    BANK = "bank",
    CASH = "cash",
    OTHER = "other",

    // Mobile Wallets & Instant Transfers
    VODAFONE_CASH = "vodafone_cash",
    ORANGE_CASH = "orange_cash",
    ETISALAT_CASH = "etisalat_cash",
    WE_PAY = "we_pay",
    INSTA = "insta",

    // Payment Aggregators & Points
    FAWRY = "fawry",
    AMAN = "aman",
    MEEZA = "meeza",

    // Buy Now Pay Later (BNPL)
    VALU = "valu",
    SYMPL = "sympl",
    TABBY = "tabby",
    TAMARA = "tamara",

    // Logistics specific
    SHIPPING_COMPANY = "shipping_company", // When the company holds the cash
    OFFICE_PICKUP = "office_pickup",
}

@Entity({ name: "order_collections" })
@Index(["adminId", "orderId"])
@Index(["adminId", "shippingCompanyId"])
export class OrderCollectionEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid', nullable: true }) // Set to false if adminId is mandatory
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Column({type: 'uuid'})
    orderId: string;

    @ManyToOne(() => OrderEntity)
    @JoinColumn({ name: "orderId" })
    order: OrderEntity;

    @Column({ type: 'uuid', nullable: true })
    shippingCompanyId?: string | null;

    @ManyToOne(() => ShippingCompanyEntity, { nullable: true, onDelete: "SET NULL" })
    @JoinColumn({ name: "shippingCompanyId" })
    shippingCompany?: ShippingCompanyEntity | null;

    @Column({ type: "decimal", precision: 10, scale: 2 })
    amount: number;

    @Column({ type: "varchar", length: 50, default: "EGP" })
    currency: string;

    // <-- changed
    @Column({ type: "enum", enum: PaymentSource, default: PaymentSource.CASH })
    source: PaymentSource;

    @Column({ type: "text", nullable: true })
    notes: string;

    @CreateDateColumn({ type: "timestamptz" })
    collectedAt: Date;
}