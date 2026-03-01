import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { endOfDay, endOfMonth, startOfDay, startOfMonth, startOfWeek, startOfYear, subDays, subMonths } from 'date-fns';
import { OrderEntity, OrderItemEntity, OrderStatus, OrderStatusEntity } from 'entities/order.entity';
import { tenantId } from 'src/category/category.service';
import { Brackets, DataSource, Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { calculateRange } from 'common/healpers';
import { User } from 'entities/user.entity';

@Injectable()
export class DashboardService {
    constructor(
        private dataSource: DataSource,
        @InjectRepository(OrderEntity)
        private orderRepo: Repository<OrderEntity>,


        @InjectRepository(OrderStatusEntity)
        private statusRepo: Repository<OrderStatusEntity>,

        @InjectRepository(User)
        private usersRepo: Repository<User>,

    ) { }


    async getSummary(user, filters: { storeId?: number; startDate?: string; endDate?: string; range?: string; search?: string }) {
        const adminId = tenantId(user);

        // 1. معالجة الفترات الزمنية (Quick Ranges)
        let { start, end } = calculateRange(filters.range);

        // إذا لم يوجد range جاهز، نستخدم التواريخ المرسلة يدوياً
        const finalStartDate = start || filters.startDate;
        const finalEndDate = end || filters.endDate;

        const query = this.orderRepo.createQueryBuilder('o')
            .leftJoin('o.status', 's')
            .where('o.adminId = :adminId', { adminId });

        if (filters.storeId) query.andWhere('o.storeId = :storeId', { storeId: filters.storeId });
        if (finalStartDate) query.andWhere('o.created_at >= :startDate', { startDate: finalStartDate });
        if (finalEndDate) query.andWhere('o.created_at <= :endDate', { endDate: finalEndDate });

        if (filters.search) {
            query.andWhere(new Brackets(qb => {
                qb.where('o.orderNumber ILIKE :search', { search: `%${filters.search}%` })
                    .orWhere('o.customerName ILIKE :search', { search: `%${filters.search}%` });
            }));
        }

        // 2. تعديل الاستعلام لحساب المبيعات والأرباح للطلبات المستلمة فقط
        const rawData = await query
            .select([
                'COUNT(o.id) as totalOrders',
                // حساب المبيعات والأرباح فقط للحالة DELIVERED
                'SUM(o.collectedAmount) as totalCollected',
                'SUM(CASE WHEN s.code = :deliveredStatus THEN o.finalTotal ELSE 0 END) as totalSales',
                'SUM(CASE WHEN s.code = :deliveredStatus THEN o.profit ELSE 0 END) as totalProfit',
                'COUNT(CASE WHEN s.code = :newStatus THEN 1 END) as newOrders',
                'COUNT(CASE WHEN s.code = :confirmedStatus THEN 1 END) as confirmedOrders',
                'COUNT(CASE WHEN s.code = :deliveredStatus THEN 1 END) as deliveredOrders',
                'COUNT(CASE WHEN s.code = :cancelledStatus THEN 1 END) as cancelledOrders',
                'COUNT(CASE WHEN s.code = :shippedStatus THEN 1 END) as inDelivery',
                'COUNT(CASE WHEN s.code = :returnedStatus THEN 1 END) as returnedOrders',
            ])
            .setParameters({
                newStatus: OrderStatus.NEW,
                confirmedStatus: OrderStatus.CONFIRMED,
                deliveredStatus: OrderStatus.DELIVERED,
                cancelledStatus: OrderStatus.CANCELLED,
                shippedStatus: OrderStatus.SHIPPED,
                returnedStatus: OrderStatus.RETURNED,
            })
            .getRawOne();

        const totalOrders = Number(rawData.totalorders) || 0;
        const totalSales = Number(rawData.totalsales) || 0;
        const totalProfit = Number(rawData.totalprofit) || 0;
        const delivered = Number(rawData.deliveredorders) || 0;
        const confirmed = Number(rawData.confirmedorders) || 0;
        const cancelled = Number(rawData.cancelledorders) || 0;
        const returned = Number(rawData.returnedorders) || 0;
        const totalCollected = Number(rawData.totalCollected) || 0;

        return {
            totalOrders,
            totalSales,
            totalProfit,
            costOfGoods: totalSales - totalProfit,
            profitMargin: totalSales > 0 ? (totalProfit / totalSales) * 100 : 0,
            confirmRate: totalOrders > 0 ? (confirmed / totalOrders) * 100 : 0,
            deliveryRate: totalOrders > 0 ? (delivered / totalOrders) * 100 : 0,
            cancelled: totalOrders > 0 ? (cancelled / totalOrders) * 100 : 0,
            inDelivery: Number(rawData.indelivery) || 0,
            newOrders: Number(rawData.neworders) || 0,
            returned: totalOrders > 0 ? (returned / totalOrders) * 100 : 0,
            totalCollected
        };
    }

    async getTrends(user, filters: { storeId?: number; startDate?: string; endDate?: string; range?: string; search?: string; points?: number }) {
        const adminId = tenantId(user);
        const points = filters.points || 12; // عدد النقاط على الرسم البياني

        // 1. حساب الفترة الزمنية (نفس منطق الـ Summary)
        let { start, end } = calculateRange(filters.range);
        const finalStartDate = start || (filters.startDate ? new Date(filters.startDate) : subDays(new Date(), 30));
        const finalEndDate = end || (filters.endDate ? new Date(filters.endDate) : new Date());

        // 2. بناء بارامترات الاستعلام الخام (Raw Query)
        const params: any[] = [finalStartDate, finalEndDate, points, adminId];
        let paramIndex = 5;

        // تجهيز شروط الفلاتر الإضافية للـ SQL الخام
        let extraFilters = "";
        if (filters.storeId) {
            extraFilters += ` AND o."storeId" = $${paramIndex++}`;
            params.push(filters.storeId);
        }
        if (filters.search) {
            extraFilters += ` AND (o."orderNumber" ILIKE $${paramIndex} OR o."customerName" ILIKE $${paramIndex})`;
            params.push(`%${filters.search}%`);
            paramIndex++;
        }

        // 3. الاستعلام الشامل (يستخدم generate_series لإنشاء جداول زمنية متساوية)
        const query = `
            WITH segments AS (
                SELECT 
                    g.idx,
                    $1::timestamptz + (g.idx * (($2::timestamptz - $1::timestamptz) / $3)) AS seg_start,
                    $1::timestamptz + ((g.idx + 1) * (($2::timestamptz - $1::timestamptz) / $3)) AS seg_end
                FROM generate_series(0, $3 - 1) AS g(idx)
            )
            SELECT 
                s.seg_start AS "date",
                COUNT(o.id) AS "orders",
                COALESCE(SUM(CASE WHEN st.code = 'delivered' THEN o."finalTotal" ELSE 0 END), 0) AS "sales"
            FROM segments s
            LEFT JOIN orders o ON o.created_at >= s.seg_start AND o.created_at < s.seg_end AND o."adminId" = $4 ${extraFilters}
            LEFT JOIN order_statuses st ON st.id = o."statusId"
            GROUP BY s.idx, s.seg_start
            ORDER BY s.seg_start ASC;
        `;

        const result = await this.dataSource.query(query, params);

        // 4. تنسيق المخرجات لتناسب الـ Chart (Trimmed Output)
        return result.map(row => ({
            label: new Date(row.date).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' }),
            orders: parseInt(row.orders),
            sales: parseFloat(row.sales)
        }));
    }

    async getTopProducts(user, filters: { storeId?: number; startDate?: string; endDate?: string; range?: string; search?: string; limit?: number }) {
        const adminId = tenantId(user);
        const limit = filters.limit || 4;

        let { start, end } = calculateRange(filters.range);
        const finalStartDate = start || filters.startDate;
        const finalEndDate = end || filters.endDate;

        const query = this.orderRepo.manager.createQueryBuilder(OrderItemEntity, 'item')
            .innerJoin('item.order', 'o')
            .leftJoin('o.status', 's')
            // ✅ الربط للوصول إلى اسم المنتج
            .innerJoin('item.variant', 'v')
            .innerJoin('v.product', 'p')
            .where('o.adminId = :adminId', { adminId })
            .andWhere('s.code = :deliveredStatus', {
                deliveredStatus: OrderStatus.DELIVERED
            });


        if (filters.storeId) query.andWhere('o.storeId = :storeId', { storeId: filters.storeId });
        if (finalStartDate) query.andWhere('o.created_at >= :startDate', { startDate: finalStartDate });
        if (finalEndDate) query.andWhere('o.created_at <= :endDate', { endDate: finalEndDate });


        // if (filters.search) {
        //     query.andWhere('item.productName ILIKE :search', { search: `%${filters.search}%` });

        // }

        const rawData = await query
            .select([
                'p.name AS name',
                'p.mainImage AS "mainImage"', // استخدام double quotes للحفاظ على حالة الأحرف (CamelCase) في Postgres
                'SUM(item.quantity) AS total_quantity',
            ])
            .groupBy('item.variantId')
            .addGroupBy('p.name')
            .addGroupBy('p.mainImage')
            .orderBy('total_quantity', 'DESC')
            .limit(limit)
            .getRawMany();

        return rawData.map((row, index) => ({
            id: index + 1,
            name: row.name || 'منتج غير معروف',
            image: row.mainImage || null,
            count: Number(row.total_quantity) || 0,
        }));
    }

    async getProfitReport(user, filters: { storeId?: number; startDate?: string; endDate?: string; range?: string }) {
        const adminId = tenantId(user);
        const points = 4; // تقسيم الشهر إلى 4 فترات زمنية (أسابيع تقريباً)

        // حساب الفترة (الافتراضي الشهر الحالي إذا لم يحدد المستخدم)
        let { start, end } = calculateRange(filters.range || 'thisMonth');
        const finalStartDate = start || (filters.startDate ? new Date(filters.startDate) : startOfMonth(new Date()));
        const finalEndDate = end || (filters.endDate ? new Date(filters.endDate) : endOfMonth(new Date()));

        const params: any[] = [finalStartDate, finalEndDate, points, adminId];
        let extraFilters = "";
        if (filters.storeId) {
            extraFilters += ` AND o."storeId" = $5`;
            params.push(filters.storeId);
        }

        const query = `
        WITH segments AS (
            SELECT 
                g.idx,
                $1::timestamptz + (g.idx * (($2::timestamptz - $1::timestamptz) / $3)) AS seg_start,
                $1::timestamptz + ((g.idx + 1) * (($2::timestamptz - $1::timestamptz) / $3)) AS seg_end
            FROM generate_series(0, $3 - 1) AS g(idx)
        )
        SELECT 
            s.idx,
            s.seg_start,
            s.seg_end,
            -- المبيعات: الطلبات التي تم تسليمها فقط
            COALESCE(SUM(CASE WHEN st.code = 'delivered' THEN o."finalTotal" ELSE 0 END), 0) AS "sales",
            -- التكاليف: مجموع تكلفة المنتجات داخل الطلبات المسلمة
            COALESCE(SUM(CASE WHEN st.code = 'delivered' THEN (
                SELECT SUM(oi."unitCost" * oi.quantity) 
                FROM order_items oi WHERE oi."orderId" = o.id
            ) ELSE 0 END), 0) AS "costs"
        FROM segments s
        LEFT JOIN orders o ON o.created_at >= s.seg_start AND o.created_at < s.seg_end AND o."adminId" = $4 ${extraFilters}
        LEFT JOIN order_statuses st ON st.id = o."statusId"
        GROUP BY s.idx, s.seg_start, s.seg_end
        ORDER BY s.seg_start ASC;
    `;

        const result = await this.dataSource.query(query, params);

        return result.map(row => {
            const sales = parseFloat(row.sales);
            const costs = parseFloat(row.costs);
            const profit = sales - costs;
            const margin = sales > 0 ? (profit / sales) * 100 : 0;

            // --- منطق تنسيق التاريخ الجديد ---
            const startDate = new Date(row.seg_start);
            const endDate = new Date(row.seg_end);

            // تنسيق اليوم (مثلاً: 1)
            const startDay = startDate.getDate();
            const endDay = endDate.getDate();

            // تنسيق الشهر باللغة العربية (مثلاً: يوليو)
            const monthName = startDate.toLocaleDateString('ar-EG', { month: 'long' });

            return {
                // الناتج سيكوم مثلاً: "1 - 7 يوليو"
                period: `${startDay} - ${endDay} ${monthName}`,
                sales: sales,
                costs: costs,
                profit: profit,
                margin: Math.round(margin)
            };
        });
    }

    async exportProfitExcel(user: any, q?: any) {
        // 1. جلب البيانات باستخدام الدالة التي أنشأناها سابقاً (لضمان تطابق الأرقام)
        const reportData = await this.getProfitReport(user, q);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("تقرير الأرباح");

        // 2. تعريف الأعمدة (تطابق profitCols في الفرونت إند)
        worksheet.columns = [
            { header: "الفترة الزمنية", key: "period", width: 25 },
            { header: "إجمالي المبيعات", key: "sales", width: 20 },
            { header: "تكلفة البضاعة", key: "costs", width: 20 },
            { header: "إجمالي الربح", key: "profit", width: 20 },
            { header: "نسبة الربح (%)", key: "margin", width: 15 },
        ];

        // 3. تنسيق الهيدر (استخدام ألوان هويتك البرتقالية)
        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: 'FFFF8B00' }, // لونك الأساسي --primary
        };
        worksheet.getRow(1).alignment = { horizontal: 'center' };

        // 4. إضافة البيانات وتنسيق الصفوف
        reportData.forEach((row) => {
            const newRow = worksheet.addRow({
                ...row,
                margin: `${row.margin}%` // إضافة علامة النسبة المئوية
            });

            // تنسيق الأرقام والعملات
            newRow.getCell('sales').numFmt = '#,##0.00';
            newRow.getCell('costs').numFmt = '#,##0.00';
            newRow.getCell('profit').numFmt = '#,##0.00';

            // تلوين صافي الربح (أخضر للربح، أحمر للخسارة)
            const profitCell = newRow.getCell('profit');
            profitCell.font = {
                color: { argb: row.profit >= 0 ? 'FF008000' : 'FFFF0000' },
                bold: true
            };

            // محاذاة البيانات
            newRow.alignment = { horizontal: 'right' };
        });

        // إضافة صف الإجمالي في النهاية
        const totalSales = reportData.reduce((sum, r) => sum + r.sales, 0);
        const totalProfit = reportData.reduce((sum, r) => sum + r.profit, 0);

        const footerRow = worksheet.addRow({
            period: "الإجمالي الكلي",
            sales: totalSales,
            profit: totalProfit,
            margin: totalSales > 0 ? `${Math.round((totalProfit / totalSales) * 100)}%` : '0%'
        });
        footerRow.font = { bold: true };
        footerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };

        return await workbook.xlsx.writeBuffer();
    }

    async getOrderAnalysisStats(user: any, filters: any) {
        const adminId = tenantId(user);
        if (!adminId) throw new BadRequestException("Missing adminId");

        // 1. حساب النطاق الزمني
        let { start, end } = calculateRange(filters.range);
        const finalStartDate = start || (filters.startDate ? new Date(filters.startDate) : null);
        const finalEndDate = end || (filters.endDate ? new Date(filters.endDate) : null);

        // 2. بناء شروط الـ JOIN ديناميكياً
        // نستخدم مصفوفة لتجميع الشروط التي ستوضع داخل الـ ON الخاص بالـ Join
        let joinConditions = 'o.statusId = status.id AND o.adminId = :adminId';
        const joinParams: any = { adminId };

        if (filters.storeId) {
            joinConditions += ' AND o.storeId = :storeId';
            joinParams.storeId = Number(filters.storeId);
        }
        if (finalStartDate) {
            joinConditions += ' AND o.created_at >= :startDate';
            joinParams.startDate = finalStartDate;
        }
        if (finalEndDate) {
            joinConditions += ' AND o.created_at <= :endDate';
            joinParams.endDate = finalEndDate;
        }
        if (filters.search) {
            joinConditions += ' AND (o.orderNumber ILIKE :search OR o.customerName ILIKE :search)';
            joinParams.search = `%${filters.search}%`;
        }


        const stats = await this.statusRepo
            .createQueryBuilder('status')
            // use relation path only (no join condition)
            .leftJoin('status.orders', 'o', joinConditions, joinParams)
            .select([
                'status.id AS id',
                'status.name AS name',
                'status.code AS code',
                'status.color  AS color',
                'status.system AS system',
                'status.sortOrder AS sortOrder'
            ])
            .addSelect('COUNT(o.id)', 'count')
            .where(new Brackets(qb => {
                qb.where('status.adminId = :adminId', { adminId })
                    .orWhere('status.system = :system', { system: true });
            }))
            // GROUP BY every non-aggregated selected column (Postgres requires this)
            .groupBy('status.id')
            .addGroupBy('status.name')
            .addGroupBy('status.code')
            .addGroupBy('status.color')
            .addGroupBy('status.system')
            .addGroupBy('status.sortOrder')
            .orderBy('status.sortOrder', 'ASC')
            .getRawMany();

        return stats.map(stat => ({
            ...stat,
            id: Number(stat.id),
            count: Number(stat.count) || 0,
            system: stat.system || stat.system
        }));
    }

    async getOrdersTrends(user, filters: { storeId?: number; startDate?: string; endDate?: string; range?: string; search?: string; points?: number }) {
        const adminId = tenantId(user);
        const points = filters.points || 12;

        let { start, end } = calculateRange(filters.range);
        const finalStartDate = start || (filters.startDate ? new Date(filters.startDate) : subDays(new Date(), 30));
        const finalEndDate = end || (filters.endDate ? new Date(filters.endDate) : new Date());

        const params: any[] = [finalStartDate, finalEndDate, points, adminId];
        let paramIndex = 5;

        let extraFilters = "";
        if (filters.storeId) {
            extraFilters += ` AND o."storeId" = $${paramIndex++}`;
            params.push(filters.storeId);
        }
        if (filters.search) {
            extraFilters += ` AND (o."orderNumber" ILIKE $${paramIndex} OR o."customerName" ILIKE $${paramIndex})`;
            params.push(`%${filters.search}%`);
            paramIndex++;
        }

        const query = `
    WITH segments AS (
        SELECT 
            g.idx,
            $1::timestamptz + (g.idx * (($2::timestamptz - $1::timestamptz) / $3)) AS seg_start,
            $1::timestamptz + ((g.idx + 1) * (($2::timestamptz - $1::timestamptz) / $3)) AS seg_end
        FROM generate_series(0, $3 - 1) AS g(idx)
    )
    SELECT 
        s.seg_start AS "date",
        COUNT(o.id) AS "total_orders",
        COUNT(CASE WHEN st.code = '${OrderStatus.NEW}' THEN o.id END) AS "new_orders",
        -- تم إزالة الفاصلة من نهاية السطر التالي
        COUNT(CASE WHEN st.code = '${OrderStatus.DELIVERED}' THEN o.id END) AS "delivered_orders"
    FROM segments s
    LEFT JOIN orders o ON o.created_at >= s.seg_start AND o.created_at < s.seg_end AND o."adminId" = $4 ${extraFilters}
    LEFT JOIN order_statuses st ON st.id = o."statusId"
    GROUP BY s.idx, s.seg_start
    ORDER BY s.seg_start ASC;
`;

        const result = await this.dataSource.query(query, params);

        return result.map(row => ({
            label: new Date(row.date).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' }),
            newOrders: parseInt(row.new_orders),
            deliveredOrders: parseInt(row.delivered_orders)
        }));
    }

    async getTopAreasReport(user, filters: { storeId?: number; startDate?: string; endDate?: string; range?: string; limit?: number }) {
        const adminId = tenantId(user);
        const limit = filters.limit || 5; // افتراضياً أعلى 5 مناطق

        let { start, end } = calculateRange(filters.range || 'thisMonth');
        const finalStartDate = start || (filters.startDate ? new Date(filters.startDate) : startOfMonth(new Date()));
        const finalEndDate = end || (filters.endDate ? new Date(filters.endDate) : endOfMonth(new Date()));

        const params: any[] = [finalStartDate, finalEndDate, adminId, limit];
        let extraFilters = "";
        if (filters.storeId) {
            extraFilters += ` AND o."storeId" = $5`;
            params.push(filters.storeId);
        }
        const query = `
        SELECT 
            o.city,
            -- إجمالي الطلبات
            COUNT(o.id) AS "totalOrders",
            -- طلبات مؤكدة (Confirmed)
            COUNT(CASE WHEN st.code = '${OrderStatus.CONFIRMED}' THEN o.id END) AS "confirmedOrders",
            -- طلبات مشحونة (Shipped)
            COUNT(CASE WHEN st.code = '${OrderStatus.SHIPPED}' THEN o.id END) AS "shippedOrders",
            -- طلبات مستلمة (Delivered)
            COUNT(CASE WHEN st.code = '${OrderStatus.DELIVERED}' THEN o.id END) AS "deliveredOrders",
            -- إجمالي المبيعات (للطلبات المسلمة فقط)
            COALESCE(SUM(CASE WHEN st.code = '${OrderStatus.DELIVERED}' THEN o."finalTotal" ELSE 0 END), 0) AS "sales"
        FROM orders o
        LEFT JOIN order_statuses st ON st.id = o."statusId"
        WHERE o."adminId" = $3 
          AND o.created_at >= $1 
          AND o.created_at <= $2
          ${extraFilters}
        GROUP BY o.city
        ORDER BY "sales" DESC
        LIMIT $4;
    `;

        const result = await this.dataSource.query(query, params);

        return result.map(row => {
            const sales = parseFloat(row.sales);
            const delivered = parseInt(row.deliveredOrders);
            const total = parseInt(row.totalOrders);

            return {
                label: row.city,
                city: row.city,
                totalOrders: total,
                confirmedOrders: parseInt(row.confirmedOrders),
                shippedOrders: parseInt(row.shippedOrders),
                deliveredOrders: delivered,
                sales: sales,
                // نسبة نجاح التوصيل للمنطقة
                deliveryRate: total > 0 ? Math.round((delivered / total) * 100) : 0
            };
        });
    }

    async exportTopAreasReport(user: any, filters: any) {
        // 1. جلب البيانات من الدالة التي قمنا بتعديلها (Top Selling Areas)
        const reportData = await this.getTopAreasReport(user, filters);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("تقرير مبيعات المناطق");

        // 2. تعريف الأعمدة بناءً على التعديلات الأخيرة
        worksheet.columns = [
            { header: "المدينة", key: "city", width: 20 },
            { header: "إجمالي الطلبات", key: "totalOrders", width: 15 },
            { header: "الطلبات المؤكدة", key: "confirmedOrders", width: 15 },
            { header: "الطلبات المشحونة", key: "shippedOrders", width: 15 },
            { header: "الطلبات المستلمة", key: "deliveredOrders", width: 15 },
            { header: "إجمالي المبيعات", key: "sales", width: 20 },
            { header: "نسبة التوصيل (%)", key: "deliveryRate", width: 15 },
        ];

        // 3. تنسيق الهيدر (اللون البرتقالي الأساسي)
        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: 'FFFF8B00' },
        };
        worksheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };

        // 4. إضافة البيانات وتنسيق الصفوف
        reportData.forEach((row) => {
            const newRow = worksheet.addRow({
                ...row,
                deliveryRate: `${row.deliveryRate}%`
            });

            // تنسيق العملات لخانة المبيعات
            newRow.getCell('sales').numFmt = '#,##0.00';

            // تلوين نسبة التوصيل (أخضر إذا كانت فوق 70%)
            const rateCell = newRow.getCell('deliveryRate');
            const rateValue = parseInt(row.deliveryRate);
            rateCell.font = {
                color: { argb: rateValue >= 70 ? 'FF008000' : 'FFFF0000' },
                bold: true
            };

            newRow.alignment = { horizontal: 'center' };
            newRow.getCell('city').alignment = { horizontal: 'right' }; // محاذاة النص العربي لليمين
        });

        // 5. إضافة صف الإجمالي الكلي
        const totals = reportData.reduce((acc, r) => ({
            total: acc.total + r.totalOrders,
            delivered: acc.delivered + r.deliveredOrders,
            sales: acc.sales + r.sales
        }), { total: 0, delivered: 0, sales: 0 });

        const footerRow = worksheet.addRow({
            city: "الإجمالي الكلي",
            totalOrders: totals.total,
            deliveredOrders: totals.delivered,
            sales: totals.sales,
            deliveryRate: totals.total > 0 ? `${Math.round((totals.delivered / totals.total) * 100)}%` : '0%'
        });

        footerRow.font = { bold: true };
        footerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
        footerRow.getCell('sales').numFmt = '#,##0.00';

        return await workbook.xlsx.writeBuffer();
    }

    async getEmployeePerformance(user: any, q: any) {
        const adminId = tenantId(user);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();

        const qb = this.usersRepo.createQueryBuilder('u');

        // Joins
        qb.leftJoin('u.assignments', 'oa')
            .leftJoin('oa.lastStatus', 'la')
            .leftJoin('oa.order', 'o')
            .leftJoin('o.status', 'st');

        // Fields selection
        qb.select([
            'u.id AS id',
            'u.name AS name',
            'u.avatarUrl AS avatarUrl'
        ])
            .addSelect('COUNT(DISTINCT oa.id)', 'totalAssigned') // DISTINCT هنا مهمة لمنع التكرار
            .addSelect(`COUNT(DISTINCT CASE WHEN la.code = '${OrderStatus.CONFIRMED}' THEN oa.id END)`, 'confirmedCount')
            .addSelect(`COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.SHIPPED}' THEN oa.id END)`, 'shippedCount')
            .addSelect(`COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.DELIVERED}' THEN oa.id END)`, 'deliveredCount');

        // Filters
        qb.where('u.adminId = :adminId', { adminId });

        if (search) {
            qb.andWhere(
                new Brackets((sq) => {
                    sq.where("u.name ILIKE :s", { s: `%${search}%` })
                        .orWhere("o.orderNumber ILIKE :s", { s: `%${search}%` });
                }),
            );
        }

        if (q?.storeId) {
            qb.andWhere("o.storeId = :storeId", { storeId: Number(q.storeId) });
        }

        if (q?.startDate) {
            qb.andWhere("o.created_at >= :startDate", { startDate: `${q.startDate}T00:00:00.000Z` });
        }

        if (q?.endDate) {
            qb.andWhere("o.created_at <= :endDate", { endDate: `${q.endDate}T23:59:59.999Z` });
        }

        // Grouping
        qb.groupBy('u.id')
            .addGroupBy('u.name')
            .addGroupBy('u.avatarUrl');

        const [totalRecordsResult, stats] = await Promise.all([
            // استعلام العدد (Count Query)
            qb.clone()
                .select('COUNT(DISTINCT u.id)', 'count')
                .orderBy() // تفريغ الـ OrderBy لحل مشكلة Postgres
                .getRawOne(),

            // استعلام البيانات (Data Query)
            qb.orderBy('COUNT(oa.id)', 'DESC')
                .offset((page - 1) * limit)
                .limit(limit)
                .getRawMany()
        ]);

        // استخراج العدد الإجمالي
        const totalRecords = Number(totalRecordsResult?.count || 0);

        // Format output
        const records = stats.map(row => {
            const total = Number(row.totalAssigned) || 0;
            const confirmed = Number(row.confirmedCount) || 0;
            const shipped = Number(row.shippedCount) || 0;
            const delivered = Number(row.deliveredCount) || 0;

            return {
                id: Number(row.id),
                name: row.name,
                avatarUrl: row.avatarUrl,
                totalAssigned: total,
                confirmed: {
                    count: confirmed,
                    percent: total > 0 ? Math.round((confirmed / total) * 100) : 0
                },
                shipped: {
                    count: shipped,
                    percent: total > 0 ? Math.round((shipped / total) * 100) : 0
                },
                delivered: {
                    count: delivered,
                    percent: total > 0 ? Math.round((delivered / total) * 100) : 0
                }
            };
        });

        return {
            total_records: totalRecords,
            current_page: page,
            per_page: limit,
            total_pages: Math.ceil(totalRecords / limit),
            records,
        };
    }

    async exportEmployeePerformance(user: any, q: any) {
        const adminId = tenantId(user);
        const qb = this.usersRepo.createQueryBuilder('u')
            .leftJoin('u.assignments', 'oa')
            .leftJoin('oa.lastStatus', 'la')
            .leftJoin('oa.order', 'o')
            .leftJoin('o.status', 'st')
            .select([
                'u.id AS id',
                'u.name AS name'
            ])
            .addSelect('COUNT(oa.id)', 'totalAssigned')
            .addSelect(`COUNT(CASE WHEN la.code = '${OrderStatus.CONFIRMED}' THEN oa.id END)`, 'confirmedCount')
            .addSelect(`COUNT(CASE WHEN st.code = '${OrderStatus.SHIPPED}' THEN oa.id END)`, 'shippedCount')
            .addSelect(`COUNT(CASE WHEN st.code = '${OrderStatus.DELIVERED}' THEN oa.id END)`, 'deliveredCount')
            .where('u.adminId = :adminId', { adminId });

        // تطبيق الفلاتر (نفس منطق الـ list تماماً)
        if (q?.search) {
            qb.andWhere(new Brackets(sq => {
                sq.where("u.name ILIKE :s", { s: `%${q.search}%` })
                    .orWhere("o.orderNumber ILIKE :s", { s: `%${q.search}%` });
            }));
        }
        if (q?.storeId) qb.andWhere("o.storeId = :storeId", { storeId: Number(q.storeId) });
        if (q?.startDate) qb.andWhere("o.created_at >= :startDate", { startDate: `${q.startDate}T00:00:00.000Z` });
        if (q?.endDate) qb.andWhere("o.created_at <= :endDate", { endDate: `${q.endDate}T23:59:59.999Z` });

        const stats = await qb
            .groupBy('u.id').addGroupBy('u.name')
            .orderBy('COUNT(oa.id)', 'DESC')
            .getRawMany();

        // --- إنشاء ملف ExcelJS ---
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("أداء الموظفين");

        worksheet.columns = [
            { header: "اسم الموظف", key: "name", width: 25 },
            { header: "إجمالي التكليفات", key: "totalAssigned", width: 15 },
            { header: "المؤكدة", key: "confirmedCount", width: 12 },
            { header: "نسبة التأكيد", key: "confirmedPercent", width: 15 },
            { header: "المشحونة", key: "shippedCount", width: 12 },
            { header: "المستلمة", key: "deliveredCount", width: 15 },
            { header: "نسبة النجاح", key: "deliveryRate", width: 15 },
        ];

        // تنسيق الهيدر (اللون البرتقالي)
        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: 'FFFF8B00' } };
        worksheet.getRow(1).alignment = { horizontal: 'center' };

        stats.forEach((row) => {
            const total = Number(row.totalAssigned) || 0;
            const delivered = Number(row.deliveredCount) || 0;
            const confirmed = Number(row.confirmedCount) || 0;
            const rate = total > 0 ? Math.round((delivered / total) * 100) : 0;

            const newRow = worksheet.addRow({
                name: row.name,
                totalAssigned: total,
                confirmedCount: confirmed,
                confirmedPercent: total > 0 ? `${Math.round((confirmed / total) * 100)}%` : '0%',
                shippedCount: Number(row.shippedCount) || 0,
                deliveredCount: delivered,
                deliveryRate: `${rate}%`
            });

            // تلوين نسبة النجاح (أخضر إذا كانت فوق 75%)
            const rateCell = newRow.getCell('deliveryRate');
            rateCell.font = {
                bold: true,
                color: { argb: rate >= 75 ? 'FF008000' : 'FFFF0000' }
            };

            newRow.alignment = { horizontal: 'center' };
            newRow.getCell('name').alignment = { horizontal: 'right' };
        });

        return await workbook.xlsx.writeBuffer();
    }

    async getEmployeeAnalysisStats(user: any, q: any) {
        const adminId = tenantId(user);
        if (!adminId) throw new BadRequestException("Missing adminId");

        // 1. تحديد الحالات المطلوبة للتفصيل
        const targetCodes = [
            OrderStatus.CONFIRMED,
            OrderStatus.SHIPPED,
            OrderStatus.DELIVERED,
            OrderStatus.CANCELLED
        ];

        // --- الجزء الأول: جلب إحصائيات الحالات المحددة ---
        const qb = this.statusRepo.createQueryBuilder('status')
            .leftJoin('status.orders', 'o')
            .select([
                'status.id AS id',
                'status.name AS name',
                'status.code AS code',
                'status.color AS color',
                'status.sortOrder AS sortOrder'
            ])
            .addSelect('COUNT(DISTINCT o.id)', 'count') // عد التكليفات المرتبطة بهذه الحالة
            .where('status.code IN (:...codes)', { codes: targetCodes });

        // فلتر الآدمن والنظام للحالات
        qb.andWhere(new Brackets(sq => {
            sq.where('status.adminId = :adminId', { adminId })
                .orWhere('status.system = :system', { system: true });
        }));

        // --- الجزء الثاني: جلب إجمالي التكليفات (Total) بشكل منفصل ---
        // سنستخدم استعلاماً فرعياً أو QueryBuilder منفصل لضمان دقة الإجمالي العام
        const totalQb = this.orderRepo.createQueryBuilder('o')
            .where('o.adminId = :adminId', { adminId });

        // تنفيذ الاستعلامات
        const [stats, totalCount] = await Promise.all([
            qb.groupBy('status.id')
                .addGroupBy('status.name')
                .addGroupBy('status.code')
                .addGroupBy('status.color')
                .addGroupBy('status.sortOrder')
                .orderBy('status.sortOrder', 'ASC')
                .getRawMany(),
            totalQb.getCount() // جلب العدد الإجمالي للتكليفات
        ]);

        // تنسيق النتائج
        const formattedStats = stats.map(stat => ({
            id: Number(stat.id),
            name: stat.name,
            code: stat.code,
            color: stat.color,
            count: Number(stat.count) || 0
        }));

        // إضافة سطر "الإجمالي" في بداية المصفوفة ليتعرف عليه الفرونت إند
        formattedStats.unshift({
            id: 0,
            name: 'Total Assignments',
            code: 'total',
            color: '#ff8b00', // نفس لون الـ Total في الإعدادات لديك
            count: totalCount
        });

        return formattedStats;
    }
}