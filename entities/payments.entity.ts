import { Column, CreateDateColumn, Entity, EntityManager, Index, JoinColumn, ManyToOne, OneToOne, PrimaryGeneratedColumn, Relation, UpdateDateColumn } from "typeorm";
import { User } from "./user.entity";
import { Subscription, UserFeature } from "./plans.entity";

export enum PaymentProviderEnum {
    KASHIER = "kashier",
}

export interface CheckoutResponse {
    checkoutUrl: string;
    sessionId: string; // Our internal database ID
}

export interface ParsedWebhookData {
    externalTransactionId: string;
    internalSessionId: string;
    status: PaymentSessionStatusEnum;
    paymentMethod: string;
    rawStatus: string; // Useful for logging the exact provider status
}

export enum PaymentSessionStatusEnum {
    PENDING = 'pending',
    SUCCESS = 'success',
    FAILED = 'failed',
    EXPIRED = 'expired',
    CANCELLED = 'cancelled'
}

export interface CheckoutOptions {
    amount: number;
    currency: string;
    userId: number;
    purpose: PaymentPurposeEnum;
    subscriptionId?: number; /// for pay subscription purpose
    userFeatureId?: number; /// for pay subscription purpose
    manager: EntityManager
}

export interface PaymentSessionResponse {
    transactionId: string;
    checkoutUrl: string;
    paymentToken?: string; // Specific to providers like Kashier
}

export interface ParsedRedirectData {
    status: PaymentSessionStatusEnum;
    sessionId: string;
}

export abstract class PaymentProvider {
    abstract providerName: string;


    // Direct server-to-server checkout if applicable
    abstract checkout(options: CheckoutOptions): Promise<CheckoutResponse>;

    // New Webhook Methods
    abstract verifyWebhookSignature(headers: any, payload: any): boolean;
    abstract parseWebhookPayload(payload: any): ParsedWebhookData;
    abstract parseRedirectQuery(query: any): ParsedRedirectData;
}

export enum PaymentPurposeEnum {
    WALLET_TOP_UP = 'wallet_top_up',
    SUBSCRIPTION_PAYMENT = 'subscription_payment',
    FEATURE_PURCHASE = 'feature_purchase',
    WALLET_WITHDRAWAL = 'wallet_withdrawal' // الميزة الجديدة
}
@Index('IDX_PAYMENT_SESSION_EXPIRY', ['status', 'expireAt'])
@Entity('payment_sessions')
export class PaymentSessionEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({
        type: 'enum',
        enum: PaymentProviderEnum,
    })
    provider: PaymentProviderEnum;

    @ManyToOne(() => User, (user) => user.paymentSessions,)
    @JoinColumn({ name: 'userId' })
    user: User;

    @Column()
    userId: number;

    @Column({
        type: 'enum',
        enum: PaymentPurposeEnum,
    })
    purpose: PaymentPurposeEnum;


    @ManyToOne(() => Subscription, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'subscriptionId' })
    subscription: Subscription;

    @Column({ nullable: true })
    subscriptionId: number;

    @ManyToOne(() => UserFeature, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'userFeatureId' })
    userFeature: Relation<UserFeature>;

    @Column({ nullable: true })
    userFeatureId: number;

    @Column({ nullable: true })
    externalSessionId: string;

    @Column('numeric', { precision: 12, scale: 2 })
    amount: number;

    @Column({
        type: 'enum',
        enum: PaymentSessionStatusEnum,
        default: PaymentSessionStatusEnum.PENDING
    })
    status: PaymentSessionStatusEnum;

    @Column()
    currency: string;

    @Column({ type: 'timestamptz' })
    expireAt: Date;

    @Column({ nullable: true })
    checkoutUrl: string;

    @Column({ type: 'jsonb', nullable: true })
    metadata: any;

    @CreateDateColumn()
    createdAt: Date;
}



export enum TransactionStatus {
    SUCCESS = 'success',
    FAILED = 'failed',
    CANCELLED = 'cancelled',
    REFUNDED = 'refunded', // Good to have for future-proofing
    PENDING = 'pending'    // The initial state while waiting for provider callback
}


export enum TransactionPaymentMethod {
    MANUAL_ADJUSTMENT = "manual_adjustment",
    CASH = 'cash',
    VISA = "visa",
    BANK = "bank",
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
}

@Index(["userId", "number"], { unique: true })
@Index('IDX_TRANSACTION_LATEST_NUMBER', ['userId', 'number', 'id'])
@Entity('transactions')
export class TransactionEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ type: "varchar", length: 100 })
    number!: string; // e.g., ORD-20250124-001

    @Column({ nullable: true })
    userId: number;

    @ManyToOne(() => User, { nullable: true, })
    @JoinColumn({ name: 'userId' })
    user: Relation<User>;

    @ManyToOne(() => User, { nullable: true })
    @JoinColumn({ name: 'adminId' })
    admin?: Relation<User> | null;

    // New Session Relation
    @Column({ type: 'int', nullable: true }) // Using UUID assuming your session ID is UUID
    sessionId?: number | null;

    @OneToOne(() => PaymentSessionEntity, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'sessionId' })
    session?: Relation<PaymentSessionEntity>;

    @Column({ nullable: true })
    subscriptionId?: number;

    @ManyToOne(() => Subscription, (sub) => sub.transactions, { nullable: true })
    @JoinColumn({ name: 'subscriptionId' })
    subscription?: Relation<Subscription>;
    @Column({
        type: 'enum',
        enum: PaymentPurposeEnum,
        default: PaymentPurposeEnum.SUBSCRIPTION_PAYMENT
    })
    purpose: PaymentPurposeEnum; // 👈 Added this


    @ManyToOne(() => UserFeature, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'userFeatureId' })
    userFeature: Relation<UserFeature>;

    @Column({ nullable: true })
    userFeatureId: number;

    @Column({ type: 'decimal', precision: 10, scale: 2 })
    amount: number;

    @Column({
        type: 'enum',
        enum: TransactionStatus,
        default: TransactionStatus.PENDING,
    })
    status: TransactionStatus;

    @Column({ type: 'varchar', nullable: true })
    paymentMethod?: string;

    @Column({ type: 'varchar', nullable: true })
    paymentProof?: string; // URL or filename

    @Column({ type: "text", nullable: true })
    notes?: string;


    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

}


@Entity('webhook_events')
@Index(['provider', 'externalTransactionId', 'status']) // Speeds up our idempotency checks
export class WebhookEvents {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({
        type: 'enum',
        enum: PaymentProviderEnum,
    })
    provider: PaymentProviderEnum;

    @Column()
    externalTransactionId: string; // Kashier's transactionId or kashierOrderId

    @Column({
        type: 'enum',
        enum: PaymentSessionStatusEnum,
    })
    status: PaymentSessionStatusEnum;

    @Column({ type: 'jsonb', nullable: true })
    payload: any;

    @CreateDateColumn()
    createdAt: Date;
}


@Entity('wallets')
export class Wallet {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    userId: number;

    @OneToOne(() => User, (user) => user.wallet)
    @JoinColumn({ name: 'userId' })
    user: Relation<User>;

    // 💰 Current spendable balance
    @Column('numeric', { precision: 12, scale: 2, default: 0 })
    currentBalance: number;

    // 📈 Total ever added to the wallet (Sum of all successful top-ups)
    @Column('numeric', { precision: 12, scale: 2, default: 0 })
    totalCharged: number;

    // 📉 Total ever spent or withdrawn from the wallet
    @Column('numeric', { precision: 12, scale: 2, default: 0 })
    totalWithdrawn: number;

    @UpdateDateColumn()
    updatedAt: Date;
}

