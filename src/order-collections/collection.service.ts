// collection.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CreateOrderCollectionDto } from 'dto/order-collection.dto';
import { OrderCollectionEntity } from 'entities/order-collection.entity';
import { OrderEntity, OrderStatus } from 'entities/order.entity';
import { ShippingIntegrationEntity } from 'entities/shipping.entity';
import { tenantId } from 'src/category/category.service';
import { Brackets, DataSource, Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { DateFilterUtil } from 'common/date-filter.util';
import { NotificationService } from 'src/notifications/notification.service';
import { NotificationType } from 'entities/notifications.entity';
import { UsersService } from 'src/users/users.service';

import { Account, AccountStatus, TransactionReferenceType } from 'entities/safe.entity';
import { SafesService } from 'src/safes/safes.service';
import { RequestTranslationService, TranslationService } from 'common/translation.service';

@Injectable()
export class CollectionService {
    constructor(
        private dataSource: DataSource,
        @InjectRepository(OrderCollectionEntity)
        private readonly repo: Repository<OrderCollectionEntity>,

        @InjectRepository(OrderEntity)
        private readonly ordersRepo: Repository<OrderEntity>,

        @InjectRepository(ShippingIntegrationEntity)
        private readonly shippingRepo: Repository<ShippingIntegrationEntity>,

        private readonly notificationService: NotificationService,
        private readonly usersService: UsersService,
        private readonly safesService: SafesService,
        private readonly translations: TranslationService,
        private requestTranslations: RequestTranslationService,
    ) { }

    // collection.service.ts

    async getCollectionStatistics(me: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException();
        const otherLocalization = await this.translations.t('domains.collections.direct_other');
//collectedOrdersCount
        // 1. Run general stats and shipping breakdown in parallel
        const [generalStats, shippingBreakdownRaw] = await Promise.all([
            this.ordersRepo
                .createQueryBuilder('o')
                .leftJoin('o.status', 'st')
                .select(`
                    SUM(CASE WHEN COALESCE(o.collectedAmount,0) = 0 THEN 1 ELSE 0 END) AS "notCollectedCount",
                    SUM(CASE WHEN COALESCE(o.collectedAmount,0) > 0 AND COALESCE(o.collectedAmount,0) < (o.finalTotal) THEN 1 ELSE 0 END) AS "partialCollectedCount",
                    SUM(CASE WHEN COALESCE(o.collectedAmount,0) >= (o.finalTotal) THEN 1 ELSE 0 END) AS "fullyCollectedCount",
                    SUM(COALESCE(o.collectedAmount,0)) AS "totalCollectedMoney",
                    SUM(CASE WHEN (o.finalTotal) > COALESCE(o.collectedAmount,0) THEN (o.finalTotal) - COALESCE(o.collectedAmount,0) ELSE 0 END) AS "totalNonCollectedMoney",
                    SUM(CASE WHEN COALESCE(o.collectedAmount,0) > 0 AND COALESCE(o.collectedAmount,0) < (o.finalTotal) THEN COALESCE(o.collectedAmount,0) ELSE 0 END) AS "totalPartialCollectedMoney"
                `)
                .where('o.adminId = :adminId', { adminId })
                .andWhere(`st.code = '${OrderStatus.DELIVERED}'`)
                .getRawOne(),

            this.ordersRepo
                .createQueryBuilder('o')
                .leftJoin('o.shippingCompany', 'ship')
                .leftJoin('o.status', 'st')
                .select('COALESCE(ship.name, :otherLocalization)', 'shippingName')
                .addSelect('SUM(CASE WHEN COALESCE(o.collectedAmount,0) = 0 THEN 1 ELSE 0 END)', 'nonCollectedOrdersCount')
                .addSelect('SUM(CASE WHEN COALESCE(o.collectedAmount,0) >= (o.finalTotal) THEN 1 ELSE 0 END)', 'collectedOrdersCount')
                .addSelect('SUM(CASE WHEN (o.finalTotal) > COALESCE(o.collectedAmount,0) THEN (o.finalTotal) - COALESCE(o.collectedAmount,0) ELSE 0 END)', 'totalNonCollectedMoney')
                .addSelect('SUM(COALESCE(o.collectedAmount,0))', 'totalCollectedMoney')
                .where('o.adminId = :adminId', { adminId })
                .andWhere(`st.code = '${OrderStatus.DELIVERED}'`)
                .setParameter('otherLocalization', otherLocalization)
                .groupBy('ship.id')
                .addGroupBy('ship.name')
                .getRawMany()
        ]);

        const stats = {
            notCollectedCount: Number(generalStats?.notCollectedCount) || 0,
            partialCollectedCount: Number(generalStats?.partialCollectedCount) || 0,
            fullyCollectedCount: Number(generalStats?.fullyCollectedCount) || 0,
            totalPartialCollectedMoney: parseFloat(generalStats?.totalPartialCollectedMoney) || 0,
            totalCollectedOrders: Number(generalStats?.fullyCollectedCount) || 0,
            totalCollectedMoney: parseFloat(generalStats?.totalCollectedMoney) || 0,
            totalNonCollectedMoney: parseFloat(generalStats?.totalNonCollectedMoney) || 0,
            shippingBreakdown: shippingBreakdownRaw.map(s => ({
                name: s.shippingName || otherLocalization,
                nonCollectedOrdersCount: Number(s.nonCollectedOrdersCount) || 0,
                collectedOrdersCount: Number(s.collectedOrdersCount) || 0,
                totalNonCollectedMoney: parseFloat(s.totalNonCollectedMoney) || 0,
                totalCollectedMoney: parseFloat(s.totalCollectedMoney) || 0
            }))
        };

        return stats;
    }

    async addCollection(me: any, dto: CreateOrderCollectionDto) {
        const adminId = tenantId(me)
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        return await this.dataSource.transaction(async (manager) => {
            // 1. Lock and find the order
            const order = await manager.findOne(OrderEntity, {
                where: { id: dto.orderId, adminId }
            });

            if (!order) {
                throw new NotFoundException(this.translations.t('domains.collections.order_not_found', { args: { orderId: dto.orderId } }));
            }

            // 2. Validate safe/account
            const safe = await manager.findOne(Account, {
                where: { id: dto.safeId, adminId } as any
            });
            if (!safe) throw new BadRequestException(this.translations.t('domains.collections.safe_not_found', { args: { safeId: dto.safeId } }));
            if (safe.status !== AccountStatus.ACTIVE) throw new BadRequestException(this.translations.t('domains.collections.safe_not_active', { args: { safeId: dto.safeId } }));

            // 3. Validate shipping company if provided
            let shippingIntegration: ShippingIntegrationEntity | null = null;
            if (dto.shippingCompanyId) {
                shippingIntegration = await manager.findOne(ShippingIntegrationEntity, {
                    where: { shippingCompanyId: dto.shippingCompanyId, adminId },
                    relations: ['shippingCompany'],
                });

                if (!shippingIntegration) {
                    throw new NotFoundException(this.translations.t('domains.collections.shipping_integration_required', { args: { shippingCompanyId: dto.shippingCompanyId } }));
                }
            }

            const currency = await this.usersService.getCompanyCurrency(me, manager);

            // 4. Create collection
            const collection = manager.create(OrderCollectionEntity, {
                adminId,
                orderId: dto.orderId,
                amount: dto.amount,
                currency: currency,
                source: dto.source,
                notes: dto.notes?.trim(),
                collectedAt: dto.collectedAt ? new Date(dto.collectedAt) : new Date(),
                shippingCompanyId: dto.shippingCompanyId || null,
                safeId: dto.safeId,
            });

            const saved = await manager.save(collection);

            // 5. Update order collected amount
            order.collectedAmount = (Number(order.collectedAmount) || 0) + Number(dto.amount);
            await manager.save(order);

            // 6. Deposit to safe
            await this.safesService.deposit(me, {
                accountId: dto.safeId,
                amount: Number(dto.amount),
                referenceType: TransactionReferenceType.ORDER_COLLECTION,
                referenceId: saved.id,
                referenceMeta: {
                    shippingCompanyProvider: shippingIntegration?.shippingCompany?.code || null,
                    trackingNumber: order.trackingNumber || null,
                    orderNumber: order.orderNumber || null,
                },
                notes: await this.requestTranslations.tAsync('domains.collections.collection_deposit_notes', adminId, { args: { orderNumber: order.orderNumber } }),
            }, manager);

            // 7. Create notification
            await this.notificationService.create({
                userId: adminId,
                type: NotificationType.COLLECTION_CREATED,
                title: await this.requestTranslations.tAsync('domains.collections.collection_created_title', adminId),
                message: await this.requestTranslations.tAsync('domains.collections.collection_created_message', adminId, { args: { amount: dto.amount, currency: collection.currency, orderNumber: order.orderNumber } }),
                relatedEntityType: "order",
                relatedEntityId: String(order.id),
            });

            return saved;
        });
    }

    async listCollections(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();

        // Sort by order creation or custom field
        const sortBy = String(q?.sortBy ?? "deliveredAt");
        const sortDir: "ASC" | "DESC" = String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

        // Primary query is now on OrderEntity
        const qb = this.ordersRepo.createQueryBuilder("order")
            .leftJoinAndSelect("order.collections", "col")
            .leftJoinAndSelect("col.shippingCompany", "colShipping")
            .leftJoinAndSelect("order.shippingCompany", "shipping")
            .leftJoin("order.status", "st")
            .where("order.adminId = :adminId", { adminId });

        // --- 1. Filter by Shipping Company (From Order Entity) ---
        if (q?.shippingCompanyId) {
            qb.andWhere("order.shippingCompanyId = :shippingId", { shippingId: q.shippingCompanyId });
        }

        // --- 2. Collection Status Logic ---
        if (q?.collectionStatus) {
            const amt = "COALESCE(order.collectedAmount, 0)";
            const collectible = "(order.finalTotal)";
            const deliveredCondition = `st.code = '${OrderStatus.DELIVERED}'`;

            if (q.collectionStatus === 'not_collected') {
                qb.andWhere(`${amt} = 0`);
            }
            else if (q.collectionStatus === 'partial') {
                // تحصيل جزئي + يجب أن يكون مستلم
                qb.andWhere(`${amt} > 0 AND ${amt} < ${collectible}`)
                    .andWhere(deliveredCondition);
            }
            else if (q.collectionStatus === 'fully_collected') {
                qb.andWhere(`${amt} >= ${collectible}`)
                    .andWhere(`${amt} > 0`);
            }
            else if (q.collectionStatus === 'pending') {
                // لم يكتمل التحصيل + يجب أن يكون مستلم
                qb.andWhere(`${amt} < ${collectible}`)
                    .andWhere(deliveredCondition);
            }
        }

        // --- 3. Search (Order Number / Customer / Phone) ---
        if (search) {
            qb.andWhere(new Brackets((sq) => {
                sq.where("order.orderNumber ILIKE :s", { s: `%${search}%` })
                    .orWhere("order.customerName ILIKE :s", { s: `%${search}%` })
                    .orWhere("order.phoneNumber ILIKE :s", { s: `%${search}%` });
            }));
        }

        // --- 4. Date Range (Based on Order Creation or Delivery) ---
        DateFilterUtil.applyToQueryBuilder(qb, "order.deliveredAt", q?.startDate, q?.endDate);

        qb.orderBy(`order.${sortBy}`, sortDir);

        const [orders, total] = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getManyAndCount();

        // --- 5. Data Mapping & Delay Calculation ---
        const records = orders.map(order => {
            const collectibleAmount = order.finalTotal;
            const isFullyCollected = (order.collectedAmount || 0) >= collectibleAmount;

            // Calculate Delay Days: Difference between Delivery Date and Last Collection Date
            let delayDays = 0;
            if (isFullyCollected && order.deliveredAt && order.collections?.length > 0) {
                // Get the date of the very last payment
                const lastCollection = order.collections.reduce((prev, current) =>
                    (prev.collectedAt > current.collectedAt) ? prev : current
                );

                const start = new Date(order.deliveredAt);
                const end = new Date(lastCollection.collectedAt);
                const diffTime = end.getTime() - start.getTime();
                delayDays = Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
            }

            return {

                orderId: order.id,
                orderNumber: order.orderNumber,
                deliveredAt: order.deliveredAt, // تاریخ التوصيل
                shippingCompany: order.shippingCompany || 'N/A',
                shippingCost: order.shippingCost,
                finalTotal: order.finalTotal,
                collectibleAmount,
                collectedAmount: order.collectedAmount || 0,
                remainingBalance: Math.max(0, collectibleAmount - (order.collectedAmount || 0)),
                delayDays: delayDays, // عدد أيام التأخير
                collections: order.collections // Optional: include full history
            };
        });

        return {
            total_records: total,
            current_page: page,
            per_page: limit,
            records
        };
    }

    async exportCollections(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        const search = String(q?.search ?? "").trim();
        const statusFilter = q?.collectionStatus;

        // 1. الاستعلام الأساسي (بدون تغيير في منطق الفلترة)
        const qb = this.ordersRepo.createQueryBuilder("order")
            .leftJoinAndSelect("order.collections", "col")
            .leftJoinAndSelect("order.shippingCompany", "shipping")
            .leftJoin("order.status", "st")
            .where("order.adminId = :adminId", { adminId });

        // تطبيق نفس فلاتر البحث والشركة والحالة...
        if (q?.shippingCompanyId) qb.andWhere("order.shippingCompanyId = :shippingId", { shippingId: q.shippingCompanyId });
        if (search) {
            qb.andWhere(new Brackets(sq => {
                sq.where("order.orderNumber ILIKE :s", { s: `%${search}%` }).orWhere("order.customerName ILIKE :s", { s: `%${search}%` });
            }));
        }

        DateFilterUtil.applyToQueryBuilder(qb, "order.created_at", q?.startDate, q?.endDate);


        // منطق فلترة الحالة (نفس الـ listCollections)
        if (statusFilter) {
            const amt = "COALESCE(order.collectedAmount, 0)";
            const collectible = "(order.finalTotal)";
            const deliveredCondition = `st.code = '${OrderStatus.DELIVERED}'`;
            if (statusFilter === 'not_collected') qb.andWhere(`${amt} = 0`).andWhere(deliveredCondition);
            else if (statusFilter === 'partial') qb.andWhere(`${amt} > 0 AND ${amt} < ${collectible}`).andWhere(deliveredCondition);
            else if (statusFilter === 'fully_collected') qb.andWhere(`${amt} >= ${collectible}`);
            else if (statusFilter === 'pending') qb.andWhere(`${amt} < ${collectible}`).andWhere(deliveredCondition);
        }

        const orders = await qb.orderBy("order.created_at", "DESC").getMany();

        // 2. تحديد الأعمدة بناءً على الحالة (Dynamic Columns)
        let columns = [];
        const isFullyCollected = statusFilter === 'fully_collected';

        if (isFullyCollected) {
            // أعمدة الـ collectedColumns
            columns = [
                { header: this.translations.t('domains.collections.export_order_number'), key: "orderNumber", width: 15 },
                { header: this.translations.t('domains.collections.export_shipping_company'), key: "shippingCompany", width: 20 },
                { header: this.translations.t('domains.collections.export_last_collection_date'), key: "lastCollectionDate", width: 20 },
                { header: this.translations.t('domains.collections.export_shipping_cost'), key: "shippingCost", width: 15 },
                { header: this.translations.t('domains.collections.export_total_amount'), key: "finalTotal", width: 15 },
                { header: this.translations.t('domains.collections.export_collectible_amount'), key: "collectibleAmount", width: 15 },
                { header: this.translations.t('domains.collections.export_collected_amount'), key: "collectedAmount", width: 15 },
                { header: this.translations.t('domains.collections.export_remaining_balance'), key: "remainingBalance", width: 15 },
                { header: this.translations.t('common.export_status'), key: "collectionStatus", width: 15 },
            ];
        } else {
            // أعمدة الـ notCollectedColumns (تستخدم للـ partial, pending, not_collected)
            columns = [
                { header: this.translations.t('domains.collections.export_order_number'), key: "orderNumber", width: 15 },
                { header: this.translations.t('domains.collections.export_shipping_company'), key: "shippingCompany", width: 20 },
                { header: this.translations.t('domains.collections.export_collected_amount'), key: "collectedAmount", width: 15 },
                { header: this.translations.t('domains.collections.export_remaining_balance'), key: "remainingBalance", width: 15 },
                { header: this.translations.t('domains.collections.export_shipping_cost'), key: "shippingCost", width: 15 },
                { header: this.translations.t('domains.collections.export_collection_method'), key: "collectionMethod", width: 25 },
                { header: this.translations.t('domains.collections.export_delivered_at'), key: "deliveredAt", width: 18 },
                { header: this.translations.t('common.export_status'), key: "collectionStatus", width: 15 },
                { header: this.translations.t('domains.collections.export_delay_days'), key: "delayDays", width: 12 },
            ];
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(this.translations.t('domains.collections.export_collections_sheet'));
        worksheet.columns = columns;

        // 3. تحويل البيانات (Transform)
        const rows = orders.map(order => {
            const collectibleAmount = Number(order.finalTotal || 0);
            const collected = Number(order.collectedAmount || 0);
            const remaining = Math.max(0, collectibleAmount - collected);

            // حساب تاريخ آخر تحصيل (لـ Fully Collected)
            const lastCol = order.collections?.length > 0
                ? new Date(Math.max(...order.collections.map(c => new Date(c.collectedAt).getTime()))).toLocaleDateString()
                : "—";

            // حساب طرق التحصيل (لـ Not Collected)
            const methods = [...new Set(order.collections?.map(c => c.source))].join(", ") || "—";

            // حساب أيام التأخير
            let delay = 0;
            if (order.deliveredAt) {
                const end = remaining === 0 ? new Date(lastCol) : new Date();
                delay = Math.floor((end.getTime() - new Date(order.deliveredAt).getTime()) / (86400000));
            }

            return {
                orderNumber: order.orderNumber,
                shippingCompany: order.shippingCompany?.name || "—",
                collectedAmount: collected,
                remainingBalance: remaining,
                shippingCost: Number(order.shippingCost || 0),
                finalTotal: Number(order.finalTotal || 0),
                collectibleAmount,
                collectionMethod: methods,
                deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toLocaleDateString() : "—",
                lastCollectionDate: lastCol,
                collectionStatus: remaining > 0 ? collected > 0 ? this.translations.t('domains.collections.status_partial') : this.translations.t('domains.collections.status_pending') : this.translations.t('domains.collections.status_fully_collected'),
                delayDays: Math.max(0, delay)
            };
        });

        // 4. إضافة البيانات وتنسيق الألوان
        worksheet.addRows(rows);
        worksheet.getRow(1).font = { bold: true };

        return await workbook.xlsx.writeBuffer();
    }

}