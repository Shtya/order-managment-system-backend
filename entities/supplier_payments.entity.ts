import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index, OneToMany } from 'typeorm';
import { User } from './user.entity';
import { SupplierEntity } from './supplier.entity';
import { PurchaseInvoiceEntity } from './purchase.entity';
import { Account } from './safe.entity';

@Entity({ name: 'supplier_payments' })
@Index(['adminId', 'supplierId'])
export class SupplierPaymentEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid' })
    adminId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Column({ type: 'uuid' })
    supplierId: string;

    @ManyToOne(() => SupplierEntity)
    @JoinColumn({ name: 'supplierId' })
    supplier: SupplierEntity;

    @Column({ type: 'uuid' })
    safeId: string;

    @ManyToOne(() => Account)
    @JoinColumn({ name: 'safeId' })
    safe: Account;

    @Column({ type: 'decimal', precision: 12, scale: 2 })
    amount: number;

    @Column({ type: 'varchar', length: 10 })
    currency: string;

    @Column({ type: 'timestamptz' })
    paymentDate: Date;

    @Column({ type: 'text', nullable: true })
    notes: string;

    @Column({ type: 'decimal', precision: 12, scale: 2 })
    supplierBalanceAfterPay: number;

    @Column({ type: 'uuid' })
    createdByUserId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: 'createdByUserId' })
    createdByUser: User;

    @OneToMany(() => SupplierPaymentAllocationEntity, (alloc) => alloc.payment, {
        cascade: true,
    })
    allocations: SupplierPaymentAllocationEntity[];

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt: Date;
}


@Entity('supplier_payment_allocations')
export class SupplierPaymentAllocationEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    paymentId: string;

    @ManyToOne(() => SupplierPaymentEntity, (payment) => payment.allocations, {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'paymentId' })
    payment: SupplierPaymentEntity;

    @Column({ type: 'uuid', nullable: true })
    invoiceId: string | null;

    @ManyToOne(() => PurchaseInvoiceEntity, {
        onDelete: 'CASCADE',
        nullable: true
    })
    @JoinColumn({ name: 'invoiceId' })
    invoice: PurchaseInvoiceEntity | null;

    @Column({ type: 'decimal', precision: 12, scale: 2 })
    amount: number;

    @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
    invoiceRemainingAfterPay: number | null;
}
