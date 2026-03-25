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
import { NotificationService } from 'src/notifications/notification.service';
import { NotificationType } from 'entities/notifications.entity';

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
    ) { }

    // collection.service.ts

    async getCollectionStatistics(me: any) {
        const adminId = tenantId(me)
        if (!adminId) throw new BadRequestException("Missing adminId");
        // shipping breakdown unchanged
        const shippingBreakdown = await this.repo
            .createQueryBuilder('col')
            .leftJoin('col.shippingCompany', 'ship')
            .select('COALESCE(ship.name, \'Direct/Other\')', 'shippingName')
            .addSelect('SUM(col.amount)', 'totalAmount')
            .where('col.adminId = :adminId', { adminId })
            .groupBy('ship.id')
            .addGroupBy('ship.name')
            .getRawMany();

        // counts directly from orders.collectedAmount vs finalTotal
        const result = await this.ordersRepo
            .createQueryBuilder('o')
            .select(`
                SUM(CASE WHEN COALESCE(o.collectedAmount,0) = 0 THEN 1 ELSE 0 END) AS "notCollectedCount",
                SUM(CASE WHEN COALESCE(o.collectedAmount,0) > 0 AND COALESCE(o.collectedAmount,0) < o.finalTotal THEN 1 ELSE 0 END) AS "partialCollectedCount",
                SUM(CASE WHEN COALESCE(o.collectedAmount,0) >= o.finalTotal THEN 1 ELSE 0 END) AS "fullyCollectedCount"
            `)
            .where('o.adminId = :adminId', { adminId })
            .getRawOne();

        const stats = {
            notCollectedCount: Number(result?.notCollectedCount) || 0,
            partialCollectedCount: Number(result?.partialCollectedCount) || 0,
            fullyCollectedCount: Number(result?.fullyCollectedCount) || 0,
            shippingBreakdown: shippingBreakdown.map(s => ({
                name: s.shippingName || 'Direct/Other',
                amount: parseFloat(s.totalAmount)
            }))
        };

        return stats;
    }

    async addCollection(me: any, dto: CreateOrderCollectionDto) {
        const adminId = tenantId(me)
        if (!adminId) throw new BadRequestException("Missing adminId");
        // validate order exists — but do this inside transaction to lock it
        return await this.dataSource.transaction(async (manager) => {
            // 1. Lock the order row
            const order = await manager.findOne(OrderEntity, {
                where: { id: dto.orderId },
            });

            if (!order) {
                throw new NotFoundException(`Order #${dto.orderId} not found`);
            }

            const shippingIntegration = await manager.findOne(ShippingIntegrationEntity, {
                where: { shippingCompanyId: dto.shippingCompanyId },
            });

            if (!shippingIntegration) {
                throw new NotFoundException(`You must integrate with the shipping company before assigning it to collections`);
            }

            // 2. create collection
            const collection = manager.create(OrderCollectionEntity, {
                adminId,
                orderId: dto.orderId,
                amount: dto.amount,
                currency: (dto.currency?.trim() || "EGP").toUpperCase(),
                source: dto.source,
                notes: dto.notes?.trim(),
                collectedAt: new Date(),
                shippingCompanyId: dto.shippingCompanyId ? dto.shippingCompanyId : null,
            });

            const saved = await manager.save(collection);

            // 3. update order.collectedAmount atomically
            order.collectedAmount = (Number(order.collectedAmount) || 0) + Number(dto.amount);
            await manager.save(order);

            await this.notificationService.create({
                userId: Number(adminId),
                type: NotificationType.COLLECTION_CREATED,
                title: "New Collection Added",
                message: `A collection of ${dto.amount} ${collection.currency} has been added to order #${order.orderNumber}.`,
                relatedEntityType: "order",
                relatedEntityId: String(order.id),
            });

            // 4. return saved (optionally return order too)
            return saved;
        });
    }

    async listCollections(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();

        // Sort by order creation or custom field
        const sortBy = String(q?.sortBy ?? "created_at");
        const sortDir: "ASC" | "DESC" = String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

        // Primary query is now on OrderEntity
        const qb = this.ordersRepo.createQueryBuilder("order")
            .leftJoinAndSelect("order.collections", "col") // Ensure OrderEntity has @OneToMany to OrderCollectionEntity
            .leftJoinAndSelect("order.shippingCompany", "shipping")
            .leftJoin("order.status", "st")
            .where("order.adminId = :adminId", { adminId });

        // --- 1. Filter by Shipping Company (From Order Entity) ---
        if (q?.shippingCompanyId) {
            qb.andWhere("order.shippingCompanyId = :shippingId", { shippingId: Number(q.shippingCompanyId) });
        }

        // --- 2. Collection Status Logic ---
        if (q?.collectionStatus) {
            const amt = "COALESCE(order.collectedAmount, 0)";
            const deliveredCondition = `st.code = '${OrderStatus.DELIVERED}'`;

            if (q.collectionStatus === 'not_collected') {
                qb.andWhere(`${amt} = 0`);
            }
            else if (q.collectionStatus === 'partial') {
                // تحصيل جزئي + يجب أن يكون مستلم
                qb.andWhere(`${amt} > 0 AND ${amt} < order.finalTotal`)
                    .andWhere(deliveredCondition);
            }
            else if (q.collectionStatus === 'fully_collected') {
                qb.andWhere(`${amt} >= order.finalTotal`)
                    .andWhere(deliveredCondition);
            }
            else if (q.collectionStatus === 'pending') {
                // لم يكتمل التحصيل + يجب أن يكون مستلم
                qb.andWhere(`${amt} < order.finalTotal`)
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
        if (q?.startDate) qb.andWhere("order.created_at >= :startDate", { startDate: `${q.startDate}T00:00:00.000Z` });
        if (q?.endDate) qb.andWhere("order.created_at <= :endDate", { endDate: `${q.endDate}T23:59:59.999Z` });

        qb.orderBy(`order.${sortBy}`, sortDir);

        const [orders, total] = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getManyAndCount();

        // --- 5. Data Mapping & Delay Calculation ---
        const records = orders.map(order => {
            const isFullyCollected = order.collectedAmount >= order.finalTotal;

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
                collectedAmount: order.collectedAmount || 0,
                remainingBalance: Math.max(0, order.finalTotal - (order.collectedAmount || 0)),
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
        if (!adminId) throw new BadRequestException("Missing adminId");

        const search = String(q?.search ?? "").trim();
        const statusFilter = q?.collectionStatus;

        // 1. الاستعلام الأساسي (بدون تغيير في منطق الفلترة)
        const qb = this.ordersRepo.createQueryBuilder("order")
            .leftJoinAndSelect("order.collections", "col")
            .leftJoinAndSelect("order.shippingCompany", "shipping")
            .leftJoin("order.status", "st")
            .where("order.adminId = :adminId", { adminId });

        // تطبيق نفس فلاتر البحث والشركة والحالة...
        if (q?.shippingCompanyId) qb.andWhere("order.shippingCompanyId = :shippingId", { shippingId: Number(q.shippingCompanyId) });
        if (search) {
            qb.andWhere(new Brackets(sq => {
                sq.where("order.orderNumber ILIKE :s", { s: `%${search}%` }).orWhere("order.customerName ILIKE :s", { s: `%${search}%` });
            }));
        }

        if (q?.startDate) qb.andWhere("order.created_at >= :startDate", { startDate: `${q.startDate}T00:00:00.000Z` });
        if (q?.endDate) qb.andWhere("order.created_at <= :endDate", { endDate: `${q.endDate}T23:59:59.999Z` });


        // منطق فلترة الحالة (نفس الـ listCollections)
        if (statusFilter) {
            const amt = "COALESCE(order.collectedAmount, 0)";
            const deliveredCondition = `st.code = '${OrderStatus.DELIVERED}'`;
            if (statusFilter === 'not_collected') qb.andWhere(`${amt} = 0`).andWhere(deliveredCondition);
            else if (statusFilter === 'partial') qb.andWhere(`${amt} > 0 AND ${amt} < order.finalTotal`).andWhere(deliveredCondition);
            else if (statusFilter === 'fully_collected') qb.andWhere(`${amt} >= order.finalTotal`);
            else if (statusFilter === 'pending') qb.andWhere(`${amt} < order.finalTotal`).andWhere(deliveredCondition);
        }

        const orders = await qb.orderBy("order.created_at", "DESC").getMany();

        // 2. تحديد الأعمدة بناءً على الحالة (Dynamic Columns)
        let columns = [];
        const isFullyCollected = statusFilter === 'fully_collected';

        if (isFullyCollected) {
            // أعمدة الـ collectedColumns
            columns = [
                { header: "Order Number", key: "orderNumber", width: 15 },
                { header: "Shipping Company", key: "shippingCompany", width: 20 },
                { header: "Last Collection Date", key: "lastCollectionDate", width: 20 },
                { header: "Shipping Cost", key: "shippingCost", width: 15 },
                { header: "Total Amount", key: "finalTotal", width: 15 },
                { header: "Collected Amount", key: "collectedAmount", width: 15 },
                { header: "Remaining Balance", key: "remainingBalance", width: 15 },
                { header: "Status", key: "collectionStatus", width: 15 },
            ];
        } else {
            // أعمدة الـ notCollectedColumns (تستخدم للـ partial, pending, not_collected)
            columns = [
                { header: "Order Number", key: "orderNumber", width: 15 },
                { header: "Shipping Company", key: "shippingCompany", width: 20 },
                { header: "Collected Amount", key: "collectedAmount", width: 15 },
                { header: "Remaining Balance", key: "remainingBalance", width: 15 },
                { header: "Shipping Cost", key: "shippingCost", width: 15 },
                { header: "Collection Method", key: "collectionMethod", width: 25 },
                { header: "Delivered At", key: "deliveredAt", width: 18 },
                { header: "Status", key: "collectionStatus", width: 15 },
                { header: "Delay Days", key: "delayDays", width: 12 },
            ];
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Collections");
        worksheet.columns = columns;

        // 3. تحويل البيانات (Transform)
        const rows = orders.map(order => {
            const total = Number(order.finalTotal || 0);
            const collected = Number(order.collectedAmount || 0);
            const remaining = Math.max(0, total - collected);

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
                finalTotal: total,
                collectionMethod: methods,
                deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toLocaleDateString() : "—",
                lastCollectionDate: lastCol,
                collectionStatus: remaining > 0 ? "Pending" : "Fully Collected",
                delayDays: Math.max(0, delay)
            };
        });

        // 4. إضافة البيانات وتنسيق الألوان
        worksheet.addRows(rows);
        worksheet.getRow(1).font = { bold: true };

        return await workbook.xlsx.writeBuffer();
    }

}