import { BadRequestException, ForbiddenException, forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { defaultCurrency } from 'common/healpers';
import { PaymentPurposeEnum, TransactionEntity, TransactionStatus } from 'entities/payments.entity';
import { Feature, SubscriptionStatus, UserFeature } from 'entities/plans.entity';
import { SystemRole, User } from 'entities/user.entity';
import { PaymentFactoryService } from 'src/payments/providers/PaymentFactoryService';
import { TransactionsService } from 'src/transactions/transactions.service';
import { DataSource, Repository } from 'typeorm';
import * as ExcelJS from "exceljs";
import { AssignUserFeatureDto, UpdateFeatureDto } from 'dto/feature.dto';

@Injectable()
export class ExtraFeaturesService {
    constructor(
        private dataSource: DataSource,
        @InjectRepository(User)
        private usersRepo: Repository<User>,

        @InjectRepository(UserFeature)
        private userFeatureRepo: Repository<UserFeature>,

        @Inject(forwardRef(() => TransactionsService))
        private transactionsService: TransactionsService,

        @Inject(forwardRef(() => PaymentFactoryService))
        private paymentFactory: PaymentFactoryService,

        @InjectRepository(Feature)
        private readonly featuresRepo: Repository<Feature>
    ) { }

    private isSuperAdmin(me: User) {
        return me.role?.name === SystemRole.SUPER_ADMIN;
    }

    // ✅ Check if user is admin
    private isAdmin(me: User) {
        return me.role?.name === SystemRole.ADMIN;
    }

    // ✅
    async purchaseFeature(user: User, featureId: number) {
        return await this.dataSource.transaction(async (manager) => {
            const userData = await manager.findOne(User, {
                where: { id: user.id },
            });

            if (!userData) throw new BadRequestException("User not found");

            const feature = await manager.findOne(Feature, { where: { id: featureId, isActive: true } });
            if (!feature) throw new NotFoundException('Feature not found or inactive');

            // Check if user already has this feature ACTIVE
            const existing = await manager.findOne(UserFeature, {
                where: { userId: user.id, featureId: feature.id, status: SubscriptionStatus.ACTIVE }
            });
            if (existing) throw new BadRequestException('You already have this feature active');

            // Create PENDING user feature
            let userFeature = await manager.findOne(UserFeature, {
                where: { userId: user.id, featureId: feature.id, status: SubscriptionStatus.PENDING }
            });

            if (!userFeature) {
                userFeature = manager.create(UserFeature, {
                    userId: user.id,
                    featureId: feature.id,
                    priceAtPurchase: feature.price,
                    status: SubscriptionStatus.PENDING,
                    startDate: new Date(),
                });
                userFeature = await manager.save(userFeature);
            }


            const provider = this.paymentFactory.getProviderByCurrency(defaultCurrency);
            return provider.checkout({
                amount: Number(userFeature.priceAtPurchase),
                currency: defaultCurrency,
                userId: user.id,
                purpose: PaymentPurposeEnum.FEATURE_PURCHASE, // Add this to your Enum
                userFeatureId: userFeature.id, // Pass this to the session
                manager
            });
        });
    }

    async list(me: User, q?: any) {
        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? '').trim();

        const sortBy = String(q?.sortBy ?? 'startDate'); // الافتراضي تاريخ البدء
        const sortDir: 'ASC' | 'DESC' =
            String(q?.sortDir ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        const qb = this.userFeatureRepo
            .createQueryBuilder('uf')
            .leftJoinAndSelect('uf.user', 'user')
            .leftJoinAndSelect('uf.feature', 'feature');

        // --- منطق الصلاحيات (Role-based access) ---
        if (!this.isSuperAdmin(me)) {
            qb.where('uf.userId = :meId', { meId: me.id });
        }

        // --- الفلاتر (Filters) ---
        if (q?.status) qb.andWhere('uf.status = :status', { status: q.status });
        if (q?.userId) qb.andWhere('uf.userId = :userId', { userId: q.userId });
        if (q?.featureId) qb.andWhere('uf.featureId = :featureId', { featureId: q.featureId });

        // البحث بالاسم أو البريد أو اسم الميزة
        if (search) {
            qb.andWhere(
                `(user.name ILIKE :s OR user.email ILIKE :s OR feature.name ILIKE :s)`,
                { s: `%${search}%` },
            );
        }

        // فلاتر التاريخ (startDate)
        if (q?.startDate) {
            qb.andWhere('uf.startDate >= :startDate', {
                startDate: `${q.startDate}T00:00:00.000Z`,
            });
        }

        // --- الترتيب والتقسيم ---
        qb.orderBy(`uf.${sortBy}`, sortDir);

        const [records, total] = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getManyAndCount();

        return {
            total_records: total,
            current_page: page,
            per_page: limit,
            records: records,
        };
    }

    async exportExtraFeatures(me: User, q?: any) {
        const search = String(q?.search ?? '').trim();
        const sortBy = String(q?.sortBy ?? 'startDate');
        const sortDir: 'ASC' | 'DESC' = String(q?.sortDir ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        const qb = this.userFeatureRepo
            .createQueryBuilder('uf')
            .leftJoinAndSelect('uf.user', 'user')
            .leftJoinAndSelect('uf.feature', 'feature');

        if (!this.isSuperAdmin(me)) {
            qb.where('uf.userId = :meId', { meId: me.id });
        }

        if (q?.status) qb.andWhere('uf.status = :status', { status: q.status });
        if (search) {
            qb.andWhere(`(user.name ILIKE :s OR user.email ILIKE :s OR feature.name ILIKE :s)`, { s: `%${search}%` });
        }

        const records = await qb.orderBy(`uf.${sortBy}`, sortDir).getMany();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Extra Features");

        // 1. تحديد الأعمدة
        worksheet.columns = [
            { header: "User Name", key: "userName", width: 25 },
            { header: "User Email", key: "userEmail", width: 30 },
            { header: "Feature Name", key: "featureName", width: 20 },
            { header: "Feature Type", key: "featureType", width: 20 },
            { header: "Paid Price", key: "price", width: 15 },
            { header: "Status", key: "status", width: 15 },
            { header: "Purchase Date", key: "startDate", width: 20 },
        ];

        // 2. معالجة البيانات
        const rows = records.map(uf => ({
            userName: uf.user?.name?.trim() || '—',
            userEmail: uf.user?.email?.trim() || '—',
            featureName: uf.feature?.name?.trim() || 'Deleted Feature',
            featureType: uf.feature?.type?.toUpperCase() || '—',
            price: Number(uf.priceAtPurchase || 0),
            status: uf.status?.toUpperCase() || '—',
            startDate: uf.startDate ? new Date(uf.startDate).toISOString().split('T')[0] : '—',
        }));

        worksheet.addRows(rows);

        // 3. التنسيق الجمالي (Styling)
        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4F46E5' },
        };
        worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

        worksheet.getColumn('price').numFmt = '#,##0.00 "EGP"';

        return await workbook.xlsx.writeBuffer();
    }

    async updateFeature(me: any, featureId: number, dto: UpdateFeatureDto) {
        if (!this.isSuperAdmin(me)) {
            throw new ForbiddenException('You do not have permission');
        }

        const feature = await this.featuresRepo.findOne({ where: { id: featureId } });

        if (!feature) {
            throw new NotFoundException(`Feature with ID ${featureId} not found`);
        }

        // تحديث الحقول إذا تم إرسالها
        if (dto.name) feature.name = dto.name.trim();
        if (dto.price !== undefined) feature.price = dto.price;
        if (dto.isActive !== undefined) feature.isActive = dto.isActive;

        return await this.featuresRepo.save(feature);
    }

    // جلب قائمة المميزات (التعريفات)
    async getAllFeaturesDefinitions() {
        return await this.featuresRepo.find({
            order: {
                id: 'ASC'
            }
        });
    }

    async assignFeatureToUser(me: User, dto: AssignUserFeatureDto) {
        // 1️⃣ التحقق من الصلاحيات
        if (!this.isSuperAdmin(me)) {
            throw new ForbiddenException('You do not have permission to perform this action');
        }

        return await this.dataSource.transaction(async (manager) => {
            // 2️⃣ التأكد من وجود المستخدم والميزة
            const user = await manager.findOne(User, { where: { id: dto.userId } });
            if (!user) throw new NotFoundException('User not found');

            const feature = await manager.findOne(Feature, { where: { id: dto.featureId } });
            if (!feature) throw new NotFoundException('Feature definition not found');

            if (!feature.isActive) {
                throw new BadRequestException('This feature is currently deactivated');
            }

            // 3️⃣ التحقق من عدم وجود نفس الميزة نشطة حالياً لنفس المستخدم
            const existing = await manager.findOne(UserFeature, {
                where: { userId: user.id, featureId: feature.id, status: SubscriptionStatus.ACTIVE }
            });
            if (existing) {
                throw new BadRequestException('User already has this feature active');
            }

            const finalPrice = dto.price ?? Number(feature.price);
            const paymentMethod = dto.paymentMethod?.trim() || 'cash';

            // 4️⃣ إنشاء سجل الميزة للمستخدم (Snapshot)
            const userFeature = manager.create(UserFeature, {
                userId: user.id,
                featureId: feature.id,
                priceAtPurchase: finalPrice,
                status: dto.status || SubscriptionStatus.ACTIVE,
                startDate: new Date(),
            });

            const savedUserFeature = await manager.save(userFeature);

            // 5️⃣ إنشاء سجل المعاملة المالية (Transaction)

            const number = await this.transactionsService.generateTransactionNumber(user.id?.toString())

            const transaction = manager.create(TransactionEntity, {
                userId: user.id,
                adminId: user.adminId || me.id, // ربطها بأدمن المستخدم أو الأدمن الحالي
                amount: finalPrice,
                number: number,
                purpose: PaymentPurposeEnum.FEATURE_PURCHASE,
                status: TransactionStatus.SUCCESS,
                paymentMethod: paymentMethod,
                userFeatureId: savedUserFeature.id,
            });

            await manager.save(transaction);

            return {
                userFeature: savedUserFeature,
                transaction: transaction
            };
        });
    }


    async getUserFeatures(user: User) {
        const qb = this.featuresRepo
            .createQueryBuilder('f')
            .leftJoinAndSelect(
                'f.userFeatures',
                'uf',
                'uf.userId = :userId AND uf.status = :status', // Combine conditions using AND
                {
                    userId: user.id,
                    status: SubscriptionStatus.ACTIVE
                }
            ).where('f.isActive = true');

        const features = await qb.getMany();

        return features.map((feature) => {
            const uf = feature.userFeatures?.[0];

            return {
                id: feature.id,
                name: feature.name,
                type: feature.type,
                price: Number(feature.price),
                isActive: feature.isActive,
                subscription: uf
                    ? {
                        id: uf.id,
                        status: uf.status,
                        startDate: uf.startDate,
                        priceAtPurchase: Number(uf.priceAtPurchase),
                    }
                    : null,
            };
        });
    }
}
