import { BadRequestException, ForbiddenException, forwardRef, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { CreateSubscriptionDto, UpdateSubscriptionDto } from "dto/subscriptions.dto";
import { Feature, Plan, PlanDuration, PlanType, Subscription, SubscriptionStatus, UserFeature, } from "entities/plans.entity";
import { SystemRole, User } from "entities/user.entity";
import { tenantId } from "src/category/category.service";
import { TransactionsService } from "src/transactions/transactions.service";
import { DataSource, EntityManager, Repository } from "typeorm";
import * as ExcelJS from "exceljs";
import { PaymentProviderEnum, PaymentPurposeEnum, PaymentSessionEntity, TransactionEntity, TransactionPaymentMethod, TransactionStatus } from "entities/payments.entity";
import { PaymentFactoryService } from "src/payments/providers/PaymentFactoryService";
import { defaultCurrency, SubscriptionUtils } from "common/healpers";
import { PaymentsService } from "src/payments/payments.service";
import { NotificationService } from "src/notifications/notification.service";
import { NotificationType } from "entities/notifications.entity";

@Injectable()
export class SubscriptionsService {
    constructor(
        private dataSource: DataSource,
        @InjectRepository(Subscription)
        private subscriptionsRepo: Repository<Subscription>,

        @InjectRepository(User)
        private usersRepo: Repository<User>,

        @InjectRepository(UserFeature)
        private userFeatureRepo: Repository<UserFeature>,

        @InjectRepository(Plan)
        private plansRepo: Repository<Plan>,

        @Inject(forwardRef(() => TransactionsService))
        private transactionsService: TransactionsService,

        @Inject(forwardRef(() => PaymentFactoryService))
        private paymentFactory: PaymentFactoryService,

        @Inject(forwardRef(() => PaymentsService))
        private paymentService: PaymentsService,

        private readonly notificationService: NotificationService,
    ) { }
    // ✅ Check if user is super admin
    private isSuperAdmin(me: User) {
        return me.role?.name === SystemRole.SUPER_ADMIN;
    }

    // ✅ Check if user is admin
    private isAdmin(me: User) {
        return me.role?.name === SystemRole.ADMIN;
    }

    // ✅ List all subscriptions with user & plan
    async list(me: User, q?: any) {
        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? '').trim();

        const sortBy = String(q?.sortBy ?? 'createdAt');
        const sortDir: 'ASC' | 'DESC' =
            String(q?.sortDir ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        const qb = this.subscriptionsRepo
            .createQueryBuilder('sub')
            .leftJoinAndSelect('sub.user', 'user')
            .leftJoinAndSelect('sub.plan', 'plan');

        // --- Role-based access ---
        if (!this.isSuperAdmin(me)) {
            qb.where('sub.userId = :meId', { meId: me.id });
        }

        // --- Filters ---
        if (q?.status) qb.andWhere('sub.status = :status', { status: q.status });
        if (q?.userId) qb.andWhere('sub.userId = :userId', { userId: q.userId });
        if (q?.planId) qb.andWhere('sub.planId = :planId', { planId: q.planId });

        // Search by user name or email
        if (search) {
            qb.andWhere(
                `(user.name ILIKE :s OR user.email ILIKE :s OR plan.name ILIKE :s)`,
                { s: `%${search}%` },
            );
        }

        // Date filters (timestamptz-safe)
        if (q?.startDate) {
            qb.andWhere('sub.startDate >= :startDate', {
                startDate: `${q.startDate}T00:00:00.000Z`,
            });
        }
        if (q?.endDate) {
            qb.andWhere('sub.endDate <= :endDate', {
                endDate: `${q.endDate}T23:59:59.999Z`,
            });
        }

        // --- Sorting ---
        qb.orderBy(`sub.${sortBy}`, sortDir);

        // --- Pagination ---
        const [subscriptions, total] = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getManyAndCount();

        // Return as-is, including user & plan relations
        return {
            total_records: total,
            current_page: page,
            per_page: limit,
            records: subscriptions,
        };
    }

    async get(me: User, id: number) {
        const subscription = await this.subscriptionsRepo.findOne({
            where: { id },
            relations: ['user', 'plan'],
        });

        if (!subscription) throw new NotFoundException('Subscription not found');

        // Role-based access
        if (this.isSuperAdmin(me)) {
            return subscription; // super admin sees all
        }

        if (this.isAdmin(me)) {
            const user = await this.usersRepo.findOne({ where: { id: subscription.userId } });
            if (user && user.adminId === me.id) return subscription;
            throw new ForbiddenException('Not your transaction');
        }

        // Regular user: only own subscription
        if (subscription.userId === me.id) return subscription;

        throw new ForbiddenException('Not allowed');
    }

    async updateSubscriptionStatus(me: User, id: number, status: SubscriptionStatus) {
        // 1. Authorization Check
        if (!this.isSuperAdmin(me)) {
            throw new ForbiddenException('You do not have permission');
        }

        // 2. Fetch the target subscription
        const subscription = await this.subscriptionsRepo.findOne({
            where: { id },
            relations: ['user']
        });

        if (!subscription) throw new NotFoundException('Subscription not found');

        // 3. Prevent Multiple Active Subscriptions
        // If we are trying to set this subscription to ACTIVE
        if (status === SubscriptionStatus.ACTIVE) {
            const existingActive = await this.subscriptionsRepo.findOne({
                where: {
                    userId: subscription.userId,
                    status: SubscriptionStatus.ACTIVE,
                }
            });

            if (existingActive && existingActive.id !== subscription.id) {
                throw new BadRequestException(
                    `User already has an active subscription (ID: ${existingActive.id}). Deactivate it first before activating this one.`
                );
            }
        }

        // 4. Apply status and save
        subscription.status = status;

        const saved = await this.subscriptionsRepo.save(subscription);

        await this.notificationService.create({
            userId: Number(subscription.userId),
            type: NotificationType.SUBSCRIPTION_STATUS_UPDATED,
            title: "Subscription Status Updated",
            message: `Your subscription status has been updated to ${status}.`,
            relatedEntityType: "subscription",
            relatedEntityId: String(saved.id),
        });

        return saved;
    }

    async createSubscription(me: User, dto: CreateSubscriptionDto) {
        if (!this.isSuperAdmin(me)) {
            throw new ForbiddenException('You do not have permission');
        }

        return await this.dataSource.transaction(async (manager) => {
            // 1️⃣ Find user & plan
            const user = await manager.findOne(User, { where: { id: dto.userId } });
            if (!user) throw new NotFoundException('User not found');

            const plan = await manager.findOne(Plan, { where: { id: dto.planId } });
            if (!plan) throw new NotFoundException('Plan not found');

            if (!plan.isActive) {
                throw new BadRequestException('Plan is not active');
            }

            // 2️⃣ Prevent duplicate active subscription (Only if we are trying to create an ACTIVE one)
            if (dto.status === SubscriptionStatus.ACTIVE) {
                const existing = await manager.findOne(Subscription, {
                    where: { userId: user.id, status: SubscriptionStatus.ACTIVE },
                });
                if (existing) {
                    throw new BadRequestException('User already has an active subscription. Deactivate it first.');
                }
            }

            // 3️⃣ Calculate End Date based on Plan Duration
            const startDate = new Date();
            let endDate: Date | null = null;

            endDate = SubscriptionUtils.calculateEndDate(
                startDate,
                plan.duration,
                plan.durationIndays
            );

            // 4️⃣ Create subscription (Taking a SNAPSHOT of the plan details)
            const subscription = manager.create(Subscription, {
                userId: user.id,
                planId: plan.id,
                // Snapshot core pricing & type
                planType: plan.type,
                price: dto.price ?? plan.price ?? 0,
                extraOrderFee: dto.extraOrderFee ?? plan.extraOrderFee,
                // Snapshot limits
                includedOrders: dto.includedOrders ?? plan.includedOrders,
                usersLimit: dto.usersLimit ?? plan.usersLimit,
                storesLimit: dto.storesLimit ?? plan.storesLimit,
                shippingCompaniesLimit: dto.shippingCompaniesLimit ?? plan.shippingCompaniesLimit,
                bulkUploadPerMonth: dto.bulkUploadPerMonth ?? plan.bulkUploadPerMonth,
                // Status and dates
                status: dto.status,
                startDate: startDate,
                endDate: endDate,
                usedOrders: 0, // Fresh start
            });

            const savedSubscription = await manager.save(subscription);

            // 5️⃣ Optionally create transaction if paid
            let transaction: TransactionEntity | null = null;
            // Apply trimming as a best practice for string inputs
            const paymentMethod = dto.paymentMethod?.trim();

            if (!paymentMethod || dto.price === undefined) {
                throw new BadRequestException('Payment method and amount are required if subscription is paid');
            }
            const number = await this.transactionsService.generateTransactionNumber(user.id?.toString())

            transaction = manager.create(TransactionEntity, {
                userId: user.id,
                adminId: user.adminId, // Using the user's admin (branch owner)
                subscriptionId: savedSubscription.id,
                amount: dto.price,
                number,
                status: TransactionStatus.SUCCESS,
                paymentMethod: paymentMethod || 'cash',
            });

            await manager.save(transaction);

            await this.notificationService.create({
                userId: Number(user.id),
                type: NotificationType.SUBSCRIPTION_CREATED,
                title: "Subscription Created",
                message: `Your new subscription for plan "${plan.name}" has been created successfully.`,
                relatedEntityType: "subscription",
                relatedEntityId: String(savedSubscription.id),
            });

            // 6️⃣ Return result
            return {
                subscription: savedSubscription,
                transaction,
            };
        });
    }

    async updateSubscription(me: User, id: number, dto: UpdateSubscriptionDto) {
        if (!this.isSuperAdmin(me)) {
            throw new ForbiddenException('You do not have permission');
        }

        return await this.dataSource.transaction(async (manager) => {
            // 1️⃣ البحث عن الاشتراك الحالي
            const sub = await manager.findOne(Subscription, {
                where: { id },
                relations: ['user']
            });
            if (!sub) throw new NotFoundException('Subscription not found');

            // 2️⃣ معالجة تغيير الخطة (Plan Change)
            if (dto.planId && dto.planId !== sub.planId) {
                const newPlan = await manager.findOne(Plan, { where: { id: dto.planId } });
                if (!newPlan || !newPlan.isActive) {
                    throw new BadRequestException('New plan is invalid or inactive');
                }

                // تحديث مرجع الخطة والنوع
                sub.planId = newPlan.id;
                sub.planType = newPlan.type;

                // تحديث لقطة البيانات من الخطة الجديدة، مع إمكانية التجاوز من الـ DTO
                // إذا كانت القيمة موجودة في dto نستخدمها، وإلا نأخذ القيمة الافتراضية من الخطة الجديدة
                sub.price = dto.price ?? newPlan.price ?? 0;
                sub.duration = dto.duration ?? newPlan.duration;
                sub.durationIndays = dto.durationIndays ?? newPlan.durationIndays;
                sub.extraOrderFee = dto.extraOrderFee ?? newPlan.extraOrderFee;
                sub.includedOrders = dto.includedOrders ?? newPlan.includedOrders;
                sub.usersLimit = dto.usersLimit ?? newPlan.usersLimit;
                sub.storesLimit = dto.storesLimit ?? newPlan.storesLimit;
                sub.shippingCompaniesLimit = dto.shippingCompaniesLimit ?? newPlan.shippingCompaniesLimit;
                sub.bulkUploadPerMonth = dto.bulkUploadPerMonth ?? newPlan.bulkUploadPerMonth;

                // إعادة ضبط الاستهلاك وتحديث التواريخ
                sub.usedOrders = 0;
                const now = new Date();
                sub.startDate = now;
                sub.endDate = SubscriptionUtils.calculateEndDate(
                    now,
                    newPlan.duration,
                    newPlan.durationIndays
                );
            } else {
                // 3️⃣ في حال عدم تغيير الخطة، نقوم بتحديث الحقول المرسلة فقط (Partial Update)
                if (dto.status) sub.status = dto.status;
                if (dto.price !== undefined) sub.price = dto.price;

                // تحديث الحدود يدوياً إذا تم إرسالها في الـ DTO
                if (dto.includedOrders !== undefined) sub.includedOrders = dto.includedOrders;
                if (dto.extraOrderFee !== undefined) sub.extraOrderFee = dto.extraOrderFee;
                if (dto.usersLimit !== undefined) sub.usersLimit = dto.usersLimit;
                if (dto.storesLimit !== undefined) sub.storesLimit = dto.storesLimit;
                if (dto.shippingCompaniesLimit !== undefined) sub.shippingCompaniesLimit = dto.shippingCompaniesLimit;
                if (dto.bulkUploadPerMonth !== undefined) sub.bulkUploadPerMonth = dto.bulkUploadPerMonth;
            }

            // 4️⃣ التحقق من عدم وجود اشتراك نشط آخر لنفس المستخدم (فقط إذا كان الاشتراك الحالي سيصبح ACTIVE)
            if (dto.status === SubscriptionStatus.ACTIVE && sub.status !== SubscriptionStatus.ACTIVE) {
                const existingActive = await manager.findOne(Subscription, {
                    where: {
                        userId: sub.userId,
                        status: SubscriptionStatus.ACTIVE,
                    },
                });
                if (existingActive && existingActive.id !== sub.id) {
                    throw new BadRequestException('User already has another active subscription');
                }
            }

            const savedSub = await manager.save(sub);

            await this.notificationService.create({
                userId: Number(sub.userId),
                type: NotificationType.SUBSCRIPTION_UPDATED,
                title: "Subscription Updated",
                message: `Your subscription has been updated successfully.`,
                relatedEntityType: "subscription",
                relatedEntityId: String(savedSub.id),
            });

            return savedSub;
        });
    }

    async createMockSubscription(me: User, dto: { planId: number }) {
        const adminId = tenantId(me);
        return await this.dataSource.transaction(async (manager) => {
            // 1️⃣ Get real User & Plan
            const user = await manager.findOne(User, { where: { id: me?.id } });
            if (!user) throw new NotFoundException(`User not found`);

            const plan = await manager.findOne(Plan, { where: { id: dto.planId } });
            if (!plan) throw new NotFoundException('Plan not found');

            // 2️⃣ Check for existing active subscription
            let subscription = await manager.findOne(Subscription, {
                where: { userId: user.id },
                lock: { mode: 'pessimistic_write' },
            });

            if (subscription) {
                // UPDATE: Change the plan and price on the current active subscription
                subscription.planId = plan.id;
                subscription.price = plan.price;
                subscription.updatedAt = new Date(); // Ensure refresh timestamp
            } else {
                // CREATE: New subscription if none exists
                subscription = manager.create(Subscription, {
                    userId: user.id,
                    planId: plan.id,
                    adminId: adminId || user.adminId,
                    price: plan.price,
                    status: SubscriptionStatus.ACTIVE,
                    startDate: new Date(),
                });
            }

            const savedSubscription = await manager.save(subscription);

            const number = await this.transactionsService.generateTransactionNumber(user.id?.toString())

            const transaction = manager.create(TransactionEntity, {
                userId: user.id,
                adminId: user.adminId || adminId,
                subscriptionId: savedSubscription.id,
                amount: savedSubscription.price,
                number,
                status: TransactionStatus.SUCCESS,
                paymentMethod: TransactionPaymentMethod.CASH,
            });

            await manager.save(transaction);

            return {
                subscription: savedSubscription,
                transaction,
            };
        });
    }

    async subscribe(user: User, planId: number) {
        return await this.dataSource.transaction(async (manager) => {

            const userData = await manager.findOne(User, {
                where: { id: user.id },
                relations: ['company']
            });
            if (!userData) throw new BadRequestException("User not found");

            // 1. Check for any existing ACTIVE subscription
            const activeSub = await manager.findOne(Subscription, {
                where: { userId: user.id, status: SubscriptionStatus.ACTIVE },
            });


            if (activeSub) {
                throw new BadRequestException('You already have an active subscription.');
            }

            // 2. Check for an existing PENDING subscription for THIS specific plan
            // This prevents creating multiple checkout sessions for the same plan
            let subscription = await manager.findOne(Subscription, {
                where: {
                    userId: user.id,
                    planId: planId,
                    status: SubscriptionStatus.PENDING
                },
            });

            const plan = await manager.findOne(Plan, { where: { id: planId } });
            if (!plan || !plan.isActive) throw new NotFoundException('Plan not available');

            if (plan.type === PlanType.NEGOTIATED) {
                throw new BadRequestException('This plan requires direct negotiation. Please contact support to subscribe.');
            }

            // 3. Create PENDING subscription if it doesn't exist
            if (!subscription) {
                subscription = manager.create(Subscription, {
                    userId: user.id,
                    planId: plan.id,
                    planType: plan.type,
                    price: plan.price || 0,
                    duration: plan.duration,
                    durationIndays: plan.durationIndays,
                    extraOrderFee: plan.extraOrderFee,
                    includedOrders: plan.includedOrders,
                    usersLimit: plan.usersLimit,
                    storesLimit: plan.storesLimit,
                    shippingCompaniesLimit: plan.shippingCompaniesLimit,
                    bulkUploadPerMonth: plan.bulkUploadPerMonth,
                    status: SubscriptionStatus.PENDING,
                    startDate: new Date(), // Placeholder until activation
                    usedOrders: 0,
                });
                subscription = await manager.save(subscription);
            }

            if (Number(subscription.price) === 0) {
                // أ- إنشاء جلسة دفع مكتملة برمجياً
                const expireMinutes = Number(process.env.PAYMENT_EXPIRE_MINUTES) || 30;
                const maxAttempts = Number(process.env.PAYMENT_MAX_FAILURE_ATTEMPTS) || 3;

                // Create Date object for DB
                const expireAtDate = new Date(Date.now() + expireMinutes * 60 * 1000);

                const session = manager.create(PaymentSessionEntity, {
                    provider: PaymentProviderEnum.KASHIER,
                    userId: user.id,
                    purpose: PaymentPurposeEnum.SUBSCRIPTION_PAYMENT,
                    amount: subscription.price,
                    currency: defaultCurrency,
                    subscriptionId: subscription.id,
                    expireAt: expireAtDate, // Saved as timestamptz in DB
                });
                const savedSession = await manager.save(session);

                // ب- إنشاء عملية دفع (Transaction)
                const transactionNumber = await this.transactionsService.generateTransactionNumber(user.id.toString());
                const transaction = manager.create(TransactionEntity, {
                    number: transactionNumber,
                    userId: user.id,
                    sessionId: savedSession.id,
                    purpose: savedSession.purpose,
                    subscriptionId: subscription.id,
                    amount: 0,
                    status: TransactionStatus.SUCCESS, // حالة النجاح
                    paymentMethod: 'FREE_PLAN',
                });
                const savedTransaction = await manager.save(transaction);

                // ج- استدعاء منطق النجاح (تفعيل الاشتراك، تحديث التواريخ، إلخ)
                await this.paymentService.handlePaymentSuccessLogic(
                    savedSession,
                    savedTransaction,
                    manager
                );

                return {
                    subscriptionId: subscription.id,
                    message: "Free subscription activated successfully"
                };
            }

            // 4. Generate Checkout via Payment Factory
            const provider = this.paymentFactory.getProviderByCurrency(defaultCurrency); // Or user currency
            const checkout = await provider.checkout({
                amount: subscription.price,
                currency: defaultCurrency,
                userId: user.id,
                purpose: PaymentPurposeEnum.SUBSCRIPTION_PAYMENT,
                subscriptionId: subscription.id,
                manager
            });

            return {
                checkoutUrl: checkout.checkoutUrl
            };
        });
    }

    async cancelSubscription(user: User, subscriptionId: number) {
        return await this.dataSource.transaction(async (manager) => {
            // 1. Find the subscription and verify ownership
            const subscription = await manager.findOne(Subscription, {
                where: {
                    id: subscriptionId,
                    status: SubscriptionStatus.ACTIVE
                },
                relations: ['plan']
            });

            if (!this.isSuperAdmin(user) && subscription.userId !== user.id) {
                throw new ForbiddenException('You do not have permission');
            }

            if (!subscription) {
                throw new NotFoundException('Active subscription not found or already cancelled.');
            }

            // 2. Update status
            subscription.status = SubscriptionStatus.CANCELLED;

            await manager.save(subscription);

            await this.notificationService.create({
                userId: Number(subscription.userId),
                type: NotificationType.SUBSCRIPTION_STATUS_UPDATED,
                title: "Subscription Cancelled",
                message: `Your subscription for plan "${subscription.plan?.name}" has been cancelled.`,
                relatedEntityType: "subscription",
                relatedEntityId: String(subscription.id),
            });

            return {
                success: true,
                message: 'Subscription has been cancelled successfully.',
                subscriptionId: subscription.id
            };
        });
    }

    async getActiveSubscriptionForAdmin(admin: User, userId: number) {
        const tenantAdminId = tenantId(admin);

        // Fetch the user first
        const user = await this.usersRepo.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('User not found');

        // Only enforce admin restriction if caller is admin
        if (!this.isSuperAdmin(admin)) {
            if (!tenantAdminId) throw new BadRequestException('Missing adminId');
        }

        // Find latest active subscription
        const subscription = await this.subscriptionsRepo.findOne({
            where: { userId, status: SubscriptionStatus.ACTIVE },
            relations: ['plan'],
            order: { startDate: 'DESC' },
        });

        return subscription;
    }

  async getMyActiveSubscription(me: User, manager?: EntityManager) {
    const repo = manager ? manager.getRepository(Subscription) : this.subscriptionsRepo;

    const subscription = await repo.findOne({
        where: { 
            userId: me.id, 
            status: SubscriptionStatus.ACTIVE 
        },
        relations: ['plan'],
        order: { startDate: 'DESC' },
    });

    return subscription;
}

    async getSubscriptionStatistics(me: User) {
        if (!(this.isSuperAdmin(me) || this.isAdmin(me))) {
            throw new ForbiddenException('Not allowed');
        }

        const qb = this.subscriptionsRepo
            .createQueryBuilder('s')
            .leftJoin('s.user', 'u');

        // Scope by role
        if (this.isSuperAdmin(me)) {
            qb.where('u.adminId IS NULL');
        } else {
            qb.where('u.adminId = :adminId', { adminId: me.id });
        }

        const result = await qb
            .select([
                'COUNT(*) as total',
                `COUNT(CASE WHEN s.status = :active THEN 1 END) as active`,
                `COUNT(CASE WHEN s.status = :expired THEN 1 END) as expired`,
                `COUNT(CASE WHEN s.status = :cancelled THEN 1 END) as cancelled`,
                'COALESCE(SUM(s.price), 0) as totalRevenue',
            ])
            .setParameters({
                active: SubscriptionStatus.ACTIVE,
                expired: SubscriptionStatus.EXPIRED,
                cancelled: SubscriptionStatus.CANCELLED,
            })
            .getRawOne();

        return {
            total: Number(result.total),
            active: Number(result.active),
            expired: Number(result.expired),
            cancelled: Number(result.cancelled),
            totalRevenue: Number(result.totalRevenue),
        };
    }

    async exportSubscriptions(me: User, q?: any) {
        const search = String(q?.search ?? '').trim();
        const sortBy = String(q?.sortBy ?? 'createdAt');
        const sortDir: 'ASC' | 'DESC' = String(q?.sortDir ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        const qb = this.subscriptionsRepo
            .createQueryBuilder('sub')
            .leftJoinAndSelect('sub.user', 'user')
            .leftJoinAndSelect('sub.plan', 'plan');

        // --- منطق الصلاحيات (Role-based access) ---
        if (!this.isSuperAdmin(me)) {
            qb.where('sub.userId = :meId', { meId: me.id });
        }

        // --- الفلاتر (Filters) ---
        if (q?.status) qb.andWhere('sub.status = :status', { status: q.status });
        if (q?.userId) qb.andWhere('sub.userId = :userId', { userId: q.userId });
        if (q?.planId) qb.andWhere('sub.planId = :planId', { planId: q.planId });

        // البحث (Search)
        if (search) {
            qb.andWhere(
                `(user.name ILIKE :s OR user.email ILIKE :s OR plan.name ILIKE :s)`,
                { s: `%${search}%` },
            );
        }

        // فلاتر التاريخ (Date filters)
        if (q?.startDate) {
            qb.andWhere('sub.startDate >= :startDate', {
                startDate: `${q.startDate}T00:00:00.000Z`,
            });
        }
        if (q?.endDate) {
            qb.andWhere('sub.endDate <= :endDate', {
                endDate: `${q.endDate}T23:59:59.999Z`,
            });
        }

        // جلب جميع البيانات بدون Pagination للتصدير
        const subscriptions = await qb.orderBy(`sub.${sortBy}`, sortDir).getMany();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Subscriptions");

        // 1. تحديد الأعمدة لتتطابق مع الواجهة الأمامية
        worksheet.columns = [
            { header: "User Name", key: "userName", width: 25 },
            { header: "User Email", key: "userEmail", width: 30 },
            { header: "Plan Name", key: "planName", width: 20 },
            { header: "Plan Type", key: "planType", width: 15 },
            { header: "Price", key: "price", width: 15 },
            { header: "Duration", key: "duration", width: 15 },
            { header: "Extra Order Fee", key: "extraOrderFee", width: 20 },
            { header: "Used Orders", key: "usedOrders", width: 15 },
            { header: "Included Orders", key: "includedOrders", width: 15 },
            { header: "Users Limit", key: "usersLimit", width: 15 },
            { header: "Stores Limit", key: "storesLimit", width: 15 },
            { header: "Shipping Limit", key: "shippingLimit", width: 15 },
            { header: "Bulk Uploads", key: "bulkUpload", width: 15 },
            { header: "Status", key: "status", width: 15 },
            { header: "Start Date", key: "startDate", width: 15 },
            { header: "End Date", key: "endDate", width: 15 },
        ];

        // دالة مساعدة لمعالجة قيم الحدود اللانهائية (null)
        const renderLimit = (val: number | null) => (val === null || val === undefined) ? '∞' : val;

        // 2. تحويل البيانات وتجهيزها (Transform)
        const rows = subscriptions.map(sub => {
            // تجهيز مدة الباقة (Duration)
            let durationText = sub.duration || 'monthly';
            if (durationText === 'custom' && sub.durationIndays) {
                durationText = `${sub.durationIndays} Days`;
            }

            // تجهيز الرسوم الإضافية (Extra Order Fee)
            let extraFeeText = 'Not Allowed';
            if (sub.extraOrderFee === 0) {
                extraFeeText = 'Free Excess';
            } else if (Number(sub.extraOrderFee) > 0) {
                extraFeeText = `+${sub.extraOrderFee} per order`;
            }

            return {
                userName: sub.user?.name?.trim() || '—',
                userEmail: sub.user?.email?.trim() || '—',
                planName: sub.plan?.name?.trim() || 'Deleted Plan',
                planType: sub.planType || '—',

                price: Number(sub.price || 0),
                duration: durationText,
                extraOrderFee: extraFeeText,

                usedOrders: sub.usedOrders || 0,
                includedOrders: renderLimit(sub.includedOrders),

                usersLimit: renderLimit(sub.usersLimit),
                storesLimit: renderLimit(sub.storesLimit),
                shippingLimit: renderLimit(sub.shippingCompaniesLimit),
                bulkUpload: sub.bulkUploadPerMonth || 0,

                status: sub.status?.toUpperCase() || '—',
                // استخدام YYYY-MM-DD ليكون منسقاً وسهل القراءة في الإكسل
                startDate: sub.startDate ? new Date(sub.startDate).toISOString().split('T')[0] : '—',
                endDate: sub.endDate ? new Date(sub.endDate).toISOString().split('T')[0] : '—',
            };
        });

        worksheet.addRows(rows);

        // تنسيق الصف الأول (Header)
        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4F46E5' }, // لون أزرق للترويسة (Primary Color)
        };
        worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

        // إضافة تنسيق العملة لعمود السعر والتوسيط لباقي الأرقام
        worksheet.getColumn('price').numFmt = '#,##0.00 "EGP"';
        worksheet.getColumn('usedOrders').alignment = { horizontal: 'center' };
        worksheet.getColumn('includedOrders').alignment = { horizontal: 'center' };
        worksheet.getColumn('usersLimit').alignment = { horizontal: 'center' };

        return await workbook.xlsx.writeBuffer();
    }



}
