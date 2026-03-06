import { BadRequestException, ForbiddenException, forwardRef, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { CreateSubscriptionDto, UpdateSubscriptionDto } from "dto/subscriptions.dto";
import { Plan, Subscription, SubscriptionStatus, Transaction, TransactionPaymentMethod, TransactionStatus } from "entities/plans.entity";
import { SystemRole, User } from "entities/user.entity";
import { tenantId } from "src/category/category.service";
import { TransactionsService } from "src/transactions/transactions.service";
import { DataSource, Repository } from "typeorm";
import * as ExcelJS from "exceljs";

@Injectable()
export class SubscriptionsService {
    constructor(
        private dataSource: DataSource,
        @InjectRepository(Subscription)
        private subscriptionsRepo: Repository<Subscription>,

        @InjectRepository(User)
        private usersRepo: Repository<User>,

        @InjectRepository(Plan)
        private plansRepo: Repository<Plan>,

        @Inject(forwardRef(() => TransactionsService))
        private transactionsService: TransactionsService,
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
        if (this.isAdmin(me)) {
            qb.where(
                '(sub.adminId = :meId OR sub.userId IN (SELECT id FROM users WHERE adminId = :meId))',
                { meId: me.id },
            );
        } else if (!this.isSuperAdmin(me)) {
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
        // Only Super Admin allowed
        if (!this.isSuperAdmin(me)) {
            throw new ForbiddenException('You do not have permission');
        }

        const subscription = await this.subscriptionsRepo.findOne({
            where: { id },
            relations: ['user', 'plan']
        });

        if (!subscription) throw new NotFoundException('Subscription not found');

        subscription.status = status;

        return this.subscriptionsRepo.save(subscription);
    }

    async createSubscription(me: User, dto: CreateSubscriptionDto) {
        if (!this.isSuperAdmin(me)) {
            throw new ForbiddenException('You do not have permission');
        }

        const id = me?.id;
        return await this.dataSource.transaction(async (manager) => {
            // 1️⃣ Find user & plan
            const user = await manager.findOne(User, { where: { id: dto.userId } });
            if (!user) throw new NotFoundException('User not found');

            // 2️⃣ Prevent duplicate active subscription
            const existing = await manager.findOne(Subscription, {
                where: { userId: user.id, status: SubscriptionStatus.ACTIVE },
            });
            if (existing) {
                throw new BadRequestException('User already has an active subscription');
            }

            const plan = await manager.findOne(Plan, { where: { id: dto.planId } });
            if (!plan) throw new NotFoundException('Plan not found');

            if (!plan.isActive) {
                throw new BadRequestException('Plan is not active');
            }

            // 2️⃣ Create subscription
            const subscription = manager.create(Subscription, {
                userId: user.id,
                planId: plan.id,
                adminId: user.adminId,
                price: dto.price || plan.price,
                status: dto.status,
                startDate: new Date(),
                endDate: null, // can calculate endDate based on plan.duration if needed
            });

            const number = `TX-${Math.random().toString(36).toUpperCase().substring(2, 12)}`;
            const savedSubscription = await manager.save(subscription);

            // 3️⃣ Optionally create transaction if payed
            let transaction: Transaction | null = null;
            if (dto.payed) {
                if (!dto.paymentMethod || !dto.price) {
                    throw new BadRequestException('Payment method and amount are required if subscription is paid');
                }

                transaction = manager.create(Transaction, {
                    userId: user.id,
                    adminId: user.adminId,
                    subscriptionId: savedSubscription.id,
                    amount: dto.price,
                    number,
                    status: TransactionStatus.COMPLETED,
                    paymentMethod: dto.paymentMethod,
                });

                await manager.save(transaction);
            }

            // 4️⃣ Return result
            return {
                subscription: savedSubscription,
                transaction,
            };
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

            const number = `TX-${Math.random().toString(36).toUpperCase().substring(2, 12)}`;

            const transaction = manager.create(Transaction, {
                userId: user.id,
                adminId: user.adminId || adminId,
                subscriptionId: savedSubscription.id,
                amount: plan.price,
                number,
                status: TransactionStatus.COMPLETED,
                paymentMethod: TransactionPaymentMethod.CASH,
            });

            await manager.save(transaction);

            return {
                subscription: savedSubscription,
                transaction,
            };
        });
    }

    async updateSubscription(me: User, subscriptionId: number, dto: UpdateSubscriptionDto) {
        if (!this.isSuperAdmin(me)) {
            throw new ForbiddenException('You do not have permission');
        }

        // Fetch subscription with user relation
        const subscription = await this.subscriptionsRepo.findOne({
            where: { id: subscriptionId },
            relations: ['user'],
        });

        if (!subscription) throw new NotFoundException('Subscription not found');

        // Update plan if provided
        if (dto.planId !== undefined) {
            const plan = await this.plansRepo.findOne({ where: { id: dto.planId } });
            if (!plan) throw new NotFoundException('Plan not found');
            if (!plan.isActive) throw new BadRequestException('Plan is not active');

            subscription.planId = plan.id;
            subscription.price = plan.price;
        }

        // Update status if provided
        if (dto.status) {
            subscription.status = dto.status;
        }

        // Update price if explicitly provided
        if (dto.price !== undefined) {
            subscription.price = dto.price;
        }

        // Save changes
        const updated = await this.subscriptionsRepo.save(subscription);
        return updated;
    }

    async getActiveSubscriptionForAdmin(admin: User, userId: number) {
        const tenantAdminId = tenantId(admin);

        // Fetch the user first
        const user = await this.usersRepo.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('User not found');

        // Only enforce admin restriction if caller is admin
        if (!this.isSuperAdmin(admin)) {
            if (!tenantAdminId) throw new BadRequestException('Missing adminId');
            if (user.adminId !== tenantAdminId) {
                throw new ForbiddenException('User does not belong to your account');
            }
        }

        // Find latest active subscription
        const subscription = await this.subscriptionsRepo.findOne({
            where: { userId, status: SubscriptionStatus.ACTIVE },
            relations: ['plan'],
            order: { startDate: 'DESC' },
        });

        return subscription;
    }

    async getMyActiveSubscription(me: User) {
        const subscription = await this.subscriptionsRepo.findOne({
            where: { userId: me.id, status: SubscriptionStatus.ACTIVE },
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
        if (this.isAdmin(me)) {
            qb.where(
                '(sub.adminId = :meId OR sub.userId IN (SELECT id FROM users WHERE adminId = :meId))',
                { meId: me.id },
            );
        } else if (!this.isSuperAdmin(me)) {
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

        // 1. تحديد الأعمدة بناءً على الـ Front-end المذكور
        worksheet.columns = [
            { header: "User", key: "userName", width: 25 },
            { header: "Plan", key: "planName", width: 20 },
            { header: "Price", key: "price", width: 15 },
            { header: "Status", key: "status", width: 15 },
            { header: "Start Date", key: "startDate", width: 20 },
            { header: "End Date", key: "endDate", width: 20 },
        ];

        // 2. تحويل البيانات وتجهيزها (Transform)
        const rows = subscriptions.map(sub => {
            return {
                userName: sub.user?.name?.trim() || '—',
                planName: sub.plan?.name?.trim() || '—',
                price: Number(sub.price || 0),
                status: sub.status?.toUpperCase() || '—',
                startDate: sub.startDate ? new Date(sub.startDate).toLocaleDateString() : '—',
                endDate: sub.endDate ? new Date(sub.endDate).toLocaleDateString() : '—',
            };
        });

        worksheet.addRows(rows);

        // تنسيق الصف الأول (Header)
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

        // إضافة تنسيق العملة لعمود السعر (العمود الثالث)
        worksheet.getColumn('price').numFmt = '#,##0.00 "EGP"';

        return await workbook.xlsx.writeBuffer();
    }

    public async upsertUserSubscription(
        me: User,
        userId: number,
        planId: number | null,
    ) {


        if (!planId) return;
        // 🔎 Validate plan
        const plan = await this.plansRepo.findOne({
            where: { id: planId },
        });

        if (!plan) throw new BadRequestException('Plan not found');
        if (!plan.isActive)
            throw new BadRequestException('Selected plan is not active');

        // 🔎 Check active subscription
        const activeSubscription = await this.subscriptionsRepo.findOne({
            where: {
                userId,
            },
        });

        if (activeSubscription) {
            // 🔁 Update existing subscription
            activeSubscription.planId = plan.id;
            activeSubscription.price = plan.price;
            activeSubscription.startDate = new Date();
            activeSubscription.endDate = null;

            await this.subscriptionsRepo.save(activeSubscription);
        } else {
            // ➕ Create new subscription
            const subscription = this.subscriptionsRepo.create({
                userId,
                planId: plan.id,
                price: plan.price,
                status: SubscriptionStatus.ACTIVE,
                startDate: new Date(),
                adminId: this.isSuperAdmin(me) ? null : me.id,
            });

            await this.subscriptionsRepo.save(subscription);
        }
    }
}
