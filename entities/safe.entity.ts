// entities/account.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, OneToMany, Index } from 'typeorm';
import { User } from './user.entity'; // افترض وجود جدول للمستخدمين/الموظفين

export enum AccountType {
    CASH = 'CASH',                 // خزنة كاش
    BANK = 'BANK',                 // حساب بنكي
    WALLET = 'WALLET',             // محفظة إلكترونية
    EMPLOYEE_CUSTODY = 'EMPLOYEE_CUSTODY', // عهدة موظف
}

// enums/account-status.enum.ts
export enum AccountStatus {
    ACTIVE = 'ACTIVE',       // نشط
    SUSPENDED = 'SUSPENDED', // موقوف
}

// enums/transaction-direction.enum.ts
export enum TransactionDirection {
    IN = 'IN',   // داخل (إضافة)
    OUT = 'OUT', // خارج (خصم)
}

// enums/transaction-reference-type.enum.ts
export enum TransactionReferenceType {
    // حركات داخلة (IN)
    INITIAL_DEPOSIT = 'INITIAL_DEPOSIT', // إيداع مبداية 
    MANUAL_ADD = 'MANUAL_ADD',                 // إضافة رصيد يدوية
    SHIPPING_COLLECTION = 'SHIPPING_COLLECTION', // تحصيل من شركة شحن//
    CUSTOMER_COLLECTION = 'CUSTOMER_COLLECTION', // تحصيل من عميل
    ORDER_COLLECTION = 'ORDER_COLLECTION',       // تحصيل طلب 
    PURCHASE_RETURN = 'PURCHASE_RETURN',       // مرتجع مشتريات
    TRANSFER_IN = 'TRANSFER_IN',               // تحويل وارد من حساب آخر
    DEPOSIT = 'DEPOSIT',                       // إيداع
    EXPENSE_REFUND = 'EXPENSE_REFUND',         // استرداد مصروف
    OTHER_IN = 'OTHER_IN',                     // دخل آخر

    // حركات خارجة (OUT)
    PURCHASE_PAYMENT = 'PURCHASE_PAYMENT',     // دفع فاتورة مشتريات
    OPERATING_EXPENSE = 'OPERATING_EXPENSE',   // مصروف تشغيل
    CASH_WITHDRAWAL = 'CASH_WITHDRAWAL',       // سحب نقدي
    TRANSFER_OUT = 'TRANSFER_OUT',             // تحويل لحساب آخر
    VENDOR_PAYMENT = 'VENDOR_PAYMENT',         // سداد لمورد
    BANK_FEE = 'BANK_FEE',                     // رسوم بنكية
    OTHER_OUT = 'OTHER_OUT',                   // مصروف آخر
}

// enums/transaction-status.enum.ts
export enum TransactionStatus {
    COMPLETED = 'COMPLETED', // مكتملة
    PENDING = 'PENDING',     // معلقة (مثل شيك تحت التحصيل أو مرتجع معلق)
    REVERSED = 'REVERSED',   // تم إلغاؤها بحركة عكسية (للحفاظ على الـ Logs)
}


@Index(['name', 'adminId'], { unique: true })
@Entity('accounts')
export class Account {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', length: 255 })
    name: string; // اسم الخزنة / الحساب

    @Column({ type: 'enum', enum: AccountType })
    type: AccountType; // نوع الحساب (كاش، بنك، إلخ)

    @Column({ type: 'enum', enum: AccountStatus, default: AccountStatus.ACTIVE })
    status: AccountStatus; // حالة الحساب

    @Column({ type: 'varchar', length: 10, default: 'EGP' })
    currency: string; // العملة

    // --- أرصدة الحساب ---
    @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
    initialBalance: number; // الرصيد الافتتاحي

    @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
    currentBalance: number; // الرصيد الحالي (يتم تحديثه تلقائياً بناءً على الحركات)

    // --- حقول خاصة بالبنك ---
    @Column({ type: 'varchar', length: 255, nullable: true })
    bankName: string;

    @Column({ type: 'varchar', length: 255, nullable: true })
    accountOwnerName: string; // صاحب الحساب / المحفظة

    @Column({ type: 'varchar', length: 100, nullable: true })
    accountNumber: string; // رقم الحساب / رقم المحفظة

    @Column({ type: 'varchar', length: 50, nullable: true })
    iban: string;

    @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
    commissionRate: number; // عمولة الحساب (لو بنك أو محفظة)

    @Index()
    @Column({ type: 'uuid', nullable: true })
    managedById: string;

    // --- علاقات (المسؤول عن الكاش أو العهدة) ---
    @ManyToOne(() => User, { nullable: true })
    @JoinColumn({ name: 'managedById' })
    managedBy: User; // الموظف المسؤول (للعهدة أو الكاش)

    @Column({ type: 'text', nullable: true })
    notes: string; // ملاحظات

    @OneToMany(() => FinancialTransaction, transaction => transaction.account)
    transactions: FinancialTransaction[];

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @CreateDateColumn({ type: "timestamptz" })
    createdAt: Date;

    @UpdateDateColumn({ type: "timestamptz" })
    updatedAt: Date;
}

@Entity('financial_transactions')
export class FinancialTransaction {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: "varchar", length: 100 })
    number!: string; // e.g., TRX-20250124-001

    @Index()
    @Column({ type: 'uuid' })
    accountId: string;

    @ManyToOne(() => Account, account => account.transactions)
    @JoinColumn({ name: 'accountId' })
    account: Account; // الخزنة أو الحساب الذي تمت عليه الحركة

    @Column({ type: 'enum', enum: TransactionDirection })
    direction: TransactionDirection; // داخل IN أم خارج OUT

    @Column({ type: 'decimal', precision: 15, scale: 2 })
    amount: number; // المبلغ

    @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
    balanceAfter: number; // الرصيد بعد تنفيذ الحركة

    @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
    commissionRate: number; // عمولة الحساب (لو بنك أو محفظة)

    @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
    commission: number; // عمولة الحركة إن وجدت

    @Column({ type: 'varchar', length: 10 })
    currency: string; // العملة الخاصة بالحركة

    @Column({ type: 'enum', enum: TransactionReferenceType })
    referenceType: TransactionReferenceType; // نوع المرجع (مشتريات، رواتب، إلخ)

    @Column({ type: 'varchar', length: 255, nullable: true })
    referenceId: string; // رقم المرجع (مثل ID فاتورة المشتريات أو ID المصروف)

    @Column({ type: 'jsonb', nullable: true })
    referenceMeta: Record<string, any>;
    // for examble 
    // referenceMeta: 
    //{ "purchaseNumber": "PUR-2026-015", "supplierName": "ABC Supplier" }
    //{ "expenseNumber": "EXP-2026-001", "category": "Marketing"}

    @Column({ type: 'varchar', length: 255, nullable: true })
    counterparty: string; // الطرف المقابل (اسم المورد، اسم شركة الشحن، اسم العميل)

    @Column({ type: 'enum', enum: TransactionStatus, default: TransactionStatus.COMPLETED })
    status: TransactionStatus; // حالة الحركة

    @Column({ type: 'text', nullable: true })
    notes: string; // الملاحظات

    @Column({ type: 'varchar', length: 255, nullable: true })
    attachmentUrl: string; // مرفق اختياري (صورة إيصال مثلاً)

    @Column({ type: 'timestamp' })
    transactionDate: Date; // تاريخ الحركة الفعلي (غير تاريخ الإنشاء في الداتا بيز)
    @Index()
    @Column({ type: 'uuid', nullable: true })
    createdById: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: 'createdById' })
    createdBy: User; // الموظف اللي سجل الحركة

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
    @JoinColumn({ name: 'adminId' })
    admin: User;

    // // حقل لحفظ الـ UUID الخاص بالحركة الأصلية في حال تم عمل "حركة عكسية" لإلغائها
    // @Column({ type: 'uuid', nullable: true })
    // reversedTransactionId: string;

    @CreateDateColumn({ type: "timestamptz" })
    createdAt: Date;
}

@Entity('account_transfers')
export class AccountTransfer {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'uuid' })
    fromAccountId: string;

    @ManyToOne(() => Account)
    @JoinColumn({ name: 'fromAccountId' })
    fromAccount: Account; // من حساب

    @Index()
    @Column({ type: 'uuid' })
    toAccountId: string;

    @ManyToOne(() => Account)
    @JoinColumn({ name: 'toAccountId' })
    toAccount: Account; // إلى حساب

    @Column({ type: 'decimal', precision: 15, scale: 2 })
    amount: number; // المبلغ المحول

    @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
    commission: number; // العمولة البنكية إن وجدت

    @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
    commissionRate: number; // عمولة الحساب (لو بنك أو محفظة)

    @Index()
    @Column({ type: 'uuid', nullable: true })
    outTransactionId: string;

    // ربط الحركة الخارجة (الخصم من الحساب الأول)
    @ManyToOne(() => FinancialTransaction)
    @JoinColumn({ name: 'outTransactionId' })
    outTransaction: FinancialTransaction;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    inTransactionId: string;

    // ربط الحركة الداخلة (الإضافة للحساب الثاني)
    @ManyToOne(() => FinancialTransaction)
    @JoinColumn({ name: 'inTransactionId' })
    inTransaction: FinancialTransaction;

    @Column({ type: 'text', nullable: true })
    notes: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    adminId: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' }) // or 'CASCADE'
    @JoinColumn({ name: 'adminId' })
    admin: User;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    createdById: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: 'createdById' })
    createdBy: User;

    @CreateDateColumn({ type: "timestamptz" })
    createdAt: Date;
}