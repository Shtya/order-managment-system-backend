import { Entity, PrimaryGeneratedColumn, Column, OneToMany, Index, ManyToOne, JoinColumn, CreateDateColumn, Relation } from 'typeorm';
import { PurchaseReturnInvoiceEntity } from './purchase_return.entity';
import { PurchaseInvoiceEntity } from './purchase.entity';

@Entity({ name: 'manual_expenses' })
export class ManualExpenseEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    @Index()
    adminId: string;

    @Column({ type: 'decimal', precision: 20, scale: 2 })
    amount: number;

    @Column({ type: 'text', nullable: true })
    description: string;

    @Column({ type: 'varchar', nullable: true })
    attachment: string;

    @Column()
    @Index()
    userId: number;


    @Column()
    createdByUserId: number;

    @ManyToOne(() => ManualExpenseCategoryEntity, (category) => category.expenses, {
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'categoryId' })
    category: Relation<ManualExpenseCategoryEntity>;

    @Column({ nullable: true })
    categoryId: number;

    @Column({
        type: "timestamptz",
        default: () => "CURRENT_TIMESTAMP"
    })
    @Index()
    collectionDate: Date;

    @Column({ nullable: true })
    monthlyClosingId: number | null;

    @ManyToOne(() => MonthlyClosingEntity)
    @JoinColumn({ name: 'monthlyClosingId' })

    @CreateDateColumn()
    createdAt: Date;
}

@Entity({ name: 'manual_expense_categories' })
@Index(['adminId', 'name'], { unique: true })
export class ManualExpenseCategoryEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    @Index()
    adminId: string;

    @Column({ type: 'varchar', length: 100 })
    name: string;

    @Column({ type: 'text', nullable: true })
    description: string;


    @Column({ default: true })
    isActive: boolean;

    @OneToMany(() => ManualExpenseEntity, (expense) => expense.category)
    expenses: ManualExpenseEntity[];
}



@Entity({ name: 'supplier_closings' })
export class SupplierClosingEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    adminId: string;

    @Column()
    supplierId: number;

    @Column({ type: 'date' })
    startDate: Date;

    @Column({ type: 'date' })
    endDate: Date;

    @Column({ type: 'decimal', precision: 20, scale: 2 })
    totalPurchases: number; // إجمالي المشتريات

    @Column({ type: 'decimal', precision: 20, scale: 2 })
    totalPaid: number;      // إجمالي المدفوع للمورد

    @Column({ type: 'decimal', precision: 20, scale: 2 })
    totalReturns: number;   // إجمالي المرتجعات

    @Column({ type: 'decimal', precision: 20, scale: 2 })
    totalTakenFromReturns: number; // المبالغ المستردة من المورد للمرتجعات

    @Column({ type: 'decimal', precision: 20, scale: 2 })
    finalBalance: number;   // الرصيد النهائي



    @OneToMany(() => PurchaseInvoiceEntity, (purchase) => purchase.closing)
    purchases: Relation<PurchaseInvoiceEntity[]>;

    @OneToMany(() => PurchaseReturnInvoiceEntity, (ret) => ret.closing)
    returns: Relation<PurchaseReturnInvoiceEntity[]>;

}

@Entity({ name: 'monthly_closings' })
@Index(['adminId', 'year', 'month'], { unique: true })
export class MonthlyClosingEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    @Index()
    adminId: string;

    @Column({ type: 'int' })
    year: number;

    @Column({ type: 'int' })
    month: number; // 1-12

    @Column({ type: 'date' })
    periodStart: Date;

    @Column({ type: 'date' })
    periodEnd: Date;

    // Revenue and costs
    @Column({ type: 'decimal', precision: 20, scale: 2, default: 0 })
    revenue: number;

    @Column({ type: 'decimal', precision: 20, scale: 2, default: 0 })
    productCost: number; // COGS

    @Column({ type: 'decimal', precision: 20, scale: 2, default: 0 })
    operationalExpenses: number;

    @Column({ type: 'decimal', precision: 20, scale: 2, default: 0 })
    returnsCost: number;

    // Profit metrics
    @Column({ type: 'decimal', precision: 20, scale: 2, default: 0 })
    grossProfit: number; // revenue - productCost

    @Column({ type: 'decimal', precision: 20, scale: 2, default: 0 })
    operatingProfit: number; // grossProfit - operationalExpenses

    @Column({ type: 'decimal', precision: 20, scale: 2, default: 0 })
    netProfit: number; // operatingProfit - returnsCost but absolute value with type

    // Audit
    @Column({ type: 'int', nullable: true })
    createdByUserId?: number;

    @CreateDateColumn()
    createdAt: Date;
}
