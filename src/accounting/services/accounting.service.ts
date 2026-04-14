import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DateFilterUtil } from 'common/date-filter.util';
import { ApprovalStatus } from 'common/enums';
import { calculateRange } from 'common/healpers';
import { endOfMonth, startOfMonth, subDays } from 'date-fns';
import { AccountingStatsDto } from 'dto/accounting.dto';
import { ManualExpenseCategoryEntity, ManualExpenseEntity, SupplierClosingEntity } from 'entities/accounting.entity';
import { OrderEntity } from 'entities/order.entity';
import { PurchaseInvoiceEntity } from 'entities/purchase.entity';
import { PurchaseReturnInvoiceEntity } from 'entities/purchase_return.entity';
import { ShipmentEntity, ShipmentStatus } from 'entities/shipping.entity';
import { SupplierEntity } from 'entities/supplier.entity';
import { tenantId } from 'src/category/category.service';
import { Between, DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
@Injectable()
export class AccountingService {
    constructor(
        private dataSource: DataSource,
        @InjectRepository(PurchaseInvoiceEntity)
        private purchaseRepo: Repository<PurchaseInvoiceEntity>,
        @InjectRepository(PurchaseReturnInvoiceEntity)
        private returnRepo: Repository<PurchaseReturnInvoiceEntity>,
        @InjectRepository(ManualExpenseEntity)
        private expenseRepo: Repository<ManualExpenseEntity>,
        @InjectRepository(OrderEntity)
        private orderRepo: Repository<OrderEntity>,
        @InjectRepository(ShipmentEntity)
        private shipmentRepo: Repository<ShipmentEntity>,
        @InjectRepository(SupplierClosingEntity)
        private supplierClosingRepo: Repository<SupplierClosingEntity>,
        @InjectRepository(SupplierEntity)
        private supplierRepo: Repository<SupplierEntity>,
    ) { }

    async getStats(me: any, filters: AccountingStatsDto) {
        const adminId = tenantId(me);
        const { startDate, endDate } = filters;

        const purchaseQuery = this.purchaseRepo
            .createQueryBuilder('inv')
            .select('SUM(inv.total)', 'total')
            .where('inv.adminId = :adminId', { adminId })
            .andWhere('inv.status = :status', { status: ApprovalStatus.ACCEPTED });


        DateFilterUtil.applyToQueryBuilder(
            purchaseQuery,
            "inv.statusUpdateDate",
            startDate,
            endDate
        );

        const returnQuery = this.returnRepo
            .createQueryBuilder('ret')
            .select('SUM(ret.totalReturn)', 'total')
            .where('ret.adminId = :adminId', { adminId })
            .andWhere('ret.status = :status', { status: ApprovalStatus.ACCEPTED });

        DateFilterUtil.applyToQueryBuilder(
            returnQuery,
            "ret.statusUpdateDate",
            startDate,
            endDate
        );

        const expenseQuery = this.expenseRepo
            .createQueryBuilder('exp')
            .select('SUM(exp.amount)', 'total')
            .where('exp.adminId = :adminId', { adminId });

        DateFilterUtil.applyToQueryBuilder(
            expenseQuery,
            "exp.collectionDate",
            startDate,
            endDate
        );

        const [purchaseRes, returnRes, expenseRes] = await Promise.all([
            purchaseQuery.getRawOne(),
            returnQuery.getRawOne(),
            expenseQuery.getRawOne(),
        ]);

        const productCost = parseFloat(purchaseRes?.total || 0);
        const returnsCost = parseFloat(returnRes?.total || 0);
        const manualExpenses = parseFloat(expenseRes?.total || 0);

        return {
            productCost,
            returnsCost,
            manualExpenses,
            netProductCost: productCost - returnsCost,
            totalOutflow: (productCost - returnsCost) + manualExpenses
        };
    }

    async getLastExpenses(me: any, { startDate, endDate }: AccountingStatsDto) {
        const adminId = tenantId(me);

        // Normalize dates to cover full day (00:00:00 to 23:59:59)
        const dateFilter = DateFilterUtil.getFindOperator(startDate, endDate);

        const [lastPurchases, lastManualExpenses] = await Promise.all([
            this.purchaseRepo.find({
                where: {
                    adminId,
                    status: ApprovalStatus.ACCEPTED,
                    ...(dateFilter && { statusUpdateDate: dateFilter }),
                },
                order: { statusUpdateDate: 'DESC' },
                take: 6,
                relations: ['supplier'],
            }),
            this.expenseRepo.find({
                where: {
                    adminId,
                    ...(dateFilter && { collectionDate: dateFilter }),
                },
                order: { collectionDate: 'DESC' },
                take: 6,
                relations: ['category'],
            }),
        ]);

        return {
            lastPurchases,
            lastManualExpenses,
        };
    }

    async getExpensesTrend(
        me: any,
        filters: {
            startDate?: string;
            endDate?: string;
            range?: string;
            points?: number;
        },
    ) {
        const adminId = tenantId(me);
        const points = filters.points || 12;

        let { start, end } = calculateRange(filters.range);
        const rawStartDate = start || (filters.startDate ? new Date(filters.startDate) : subDays(new Date(), 30));
        const rawEndDate = end || (filters.endDate ? new Date(filters.endDate) : new Date());

        // 2. ENFORCE BOUNDARIES: Align them to the absolute start and end of the local day
        rawStartDate.setHours(0, 0, 0, 0);
        rawEndDate.setHours(23, 59, 59, 999);
        const params: any[] = [rawStartDate, rawEndDate, points, adminId];


        const query = `
      WITH segments AS (
          SELECT 
              g.idx,
              $1::timestamptz + (g.idx * (($2::timestamptz - $1::timestamptz) / $3)) AS seg_start,
              $1::timestamptz + ((g.idx + 1) * (($2::timestamptz - $1::timestamptz) / $3)) AS seg_end
          FROM generate_series(0, $3 - 1) AS g(idx)
      ),
      financial_events AS (
          -- أ. المشتريات (تكلفة منتجات موجبة)
          SELECT "statusUpdateDate" AS event_date, total AS product_cost, 0 AS manual_expense
          FROM purchase_invoices 
          WHERE "adminId" = $4 AND status = 'accepted'
          
          UNION ALL
          
          -- ج. المصاريف اليدوية
          SELECT "collectionDate" AS event_date, 0 AS product_cost, amount AS manual_expense
          FROM manual_expenses 
          WHERE "adminId" = $4
      )
      SELECT 
          s.seg_start AS "date",
          COALESCE(SUM(e.product_cost), 0) AS "productCost",
          COALESCE(SUM(e.manual_expense), 0) AS "manualExpenses",
          (COALESCE(SUM(e.product_cost), 0) + COALESCE(SUM(e.manual_expense), 0)) AS "totalCost"
      FROM segments s
      LEFT JOIN financial_events e ON e.event_date >= s.seg_start AND e.event_date < s.seg_end
      GROUP BY s.idx, s.seg_start
      ORDER BY s.seg_start ASC;
    `;

        // ستحتاج إلى حقن الـ DataSource في الـ constructor لتشغيل الاستعلام
        // constructor(private dataSource: DataSource) {}
        const result = await this.dataSource.query(query, params);

        // 4. تنسيق المخرجات للرسم البياني
        return result.map((row) => ({
            label: new Date(row.date).toLocaleDateString("ar-EG", {
                day: "numeric",
                month: "short",
            }),
            productCost: parseFloat(row.productCost),
            manualExpenses: parseFloat(row.manualExpenses),
            totalCost: parseFloat(row.totalCost),
        }));
    }

    async getTopSuppliersBalances(
        me: any,
        filters: { startDate?: string; endDate?: string },
    ) {
        const adminId = tenantId(me);
        const params: any[] = [adminId];
        let dateFilter = '';
        let paramIndex = 2;


        if (filters.startDate) {
            const start = new Date(filters.startDate);
            start.setHours(0, 0, 0, 0);

            dateFilter += ` AND "statusUpdateDate" >= $${paramIndex++}`;
            params.push(start);
        }

        // 2. Enforce End of Day
        if (filters.endDate) {
            const end = new Date(filters.endDate);
            end.setHours(23, 59, 59, 999);

            dateFilter += ` AND "statusUpdateDate" <= $${paramIndex++}`;
            params.push(end);
        }

        const query = `
      WITH ledger AS (
          
          SELECT 
              "supplierId", 
              ("total" - "paidAmount") AS balance_impact
          FROM purchase_invoices
          WHERE "adminId" = $1 
            AND status = 'accepted' 
            AND "supplierId" IS NOT NULL
            ${dateFilter}
          
          UNION ALL
          
          SELECT 
              "supplierId", 
              -("totalReturn" - "paidAmount") AS balance_impact
          FROM purchase_return_invoices
          WHERE "adminId" = $1 
            AND status = 'accepted' 
            AND "supplierId" IS NOT NULL
            ${dateFilter}
      )
      SELECT 
          l."supplierId",
          s.name AS "supplierName",
          s.phone AS "supplierPhone",
          s.email AS "supplierEmail",
          COALESCE(SUM(l.balance_impact), 0) AS "dueBalance"
      FROM ledger l
      LEFT JOIN suppliers s ON s.id = l."supplierId"
      GROUP BY l."supplierId", s.name, s.phone, s.email
      HAVING COALESCE(SUM(l.balance_impact), 0) != 0 -- استبعاد الموردين الذين رصيدهم صفر (خالصين)
      ORDER BY ABS(SUM(l.balance_impact)) DESC -- الترتيب حسب حجم المبلغ سواء لك أو عليك
      LIMIT 10;
    `;

        const result = await this.dataSource.query(query, params);


        return result.map((row) => {
            const balance = parseFloat(row.dueBalance);

            return {
                supplierId: row.supplierId,
                supplierName: row.supplierName || 'غير معروف',
                supplierPhone: row.supplierPhone,
                supplierEmail: row.supplierEmail,
                netBalance: balance, // الرقم الفعلي (موجب أو سالب)
                absoluteBalance: Math.abs(balance), // الرقم المطلق لعرضه للمستخدم


                financialStatus: balance > 0
                    ? 'PAYABLE'    // عليك دفع هذا المبلغ للمورد
                    : 'RECEIVABLE', // لك تحصيل هذا المبلغ من المورد
            };
        });
    }

    async getCityReturnRates(
        adminId: string,
        filters: { startDate?: string; endDate?: string },
    ) {
        // بناء الاستعلام الأساسي
        const query = this.orderRepo.createQueryBuilder('order')
            .select('order.city', 'city')
            .addSelect('COUNT(order.id)', 'totalOrders')
            // نعتبر الطلب مرتجعاً إذا كان له تاريخ إرجاع أو مسجل له طلب استرجاع
            .addSelect(
                `SUM(CASE WHEN order."lastReturnId" IS NOT NULL THEN 1 ELSE 0 END)`,
                'returnedOrders'
            )
            .where('order.adminId = :adminId', { adminId });



        DateFilterUtil.applyToQueryBuilder(
            query,
            "order.created_at",
            filters.startDate,
            filters.endDate,
        )


        const results = await query
            .groupBy('order.city')
            .orderBy('"totalOrders"', 'DESC')
            .getRawMany();


        return results.map((row) => {
            const total = parseInt(row.totalOrders) || 0;
            const returned = parseInt(row.returnedOrders) || 0;


            const returnPercent = total > 0 ? (returned / total) * 100 : 0;

            return {
                city: row.city || null,
                totalOrders: total,
                returnedOrders: returned,
                successfulOrders: total - returned,
                returnPercent: parseFloat(returnPercent.toFixed(2)), // تقريب لعلامتين عشريتين
            };
        });
    }

    async getShipmentsCityReport(
        me: any,
        filters: {
            storeId?: string;
            startDate?: string;
            endDate?: string;
            range?: string;
            page?: number;
            limit?: number;
            search?: string;
        },
    ) {
        const adminId = tenantId(me);
        const page = Number(filters.page) || 1;
        const limit = Number(filters.limit) || 10;

        //

        const qb = this.shipmentRepo.createQueryBuilder('shipment')
            .innerJoin('shipment.order', 'order')
            .select('order.city', 'city')

            .addSelect('COUNT(shipment.id)', 'totalShipments')

            .addSelect(
                `COUNT(CASE WHEN shipment.status = :delivered THEN 1 END)`,
                'deliveredShipments'
            )

            .addSelect(
                `COUNT(CASE WHEN shipment.status IN (:failed, :cancelled) THEN 1 END)`,
                'failedShipments'
            )
            .where('shipment.adminId = :adminId', { adminId })


        DateFilterUtil.applyToQueryBuilder(
            qb,
            "shipment.created_at",
            filters.startDate,
            filters.endDate
        );

        qb.setParameters({
            delivered: ShipmentStatus.DELIVERED,
            failed: ShipmentStatus.FAILED,
            cancelled: ShipmentStatus.CANCELLED,
        });


        if (filters.storeId) {
            qb.andWhere('order.storeId = :storeId', { storeId: filters.storeId });
        }

        if (filters.search) {
            qb.andWhere('order.city ILIKE :search', { search: `%${filters.search}%` });
        }


        qb.groupBy('order.city')
            .orderBy('"totalShipments"', 'DESC');



        const totalCitiesQuery = await qb.getRawMany();
        const totalRecords = totalCitiesQuery.length;


        const results = await qb
            .offset((page - 1) * limit)
            .limit(limit)
            .getRawMany();


        const records = results.map((row) => {
            const total = parseInt(row.totalShipments);
            const delivered = parseInt(row.deliveredShipments);
            const failed = parseInt(row.failedShipments);

            return {
                city: row.city || 'غير محدد',
                totalShipments: total,
                actualDeliveries: delivered,
                failedShipments: failed,
                successRate: total > 0 ? Math.round((delivered / total) * 100) : 0,
                failureRate: total > 0 ? Math.round((failed / total) * 100) : 0,
            };
        });

        return {
            records,
            total_records: totalRecords,
            current_page: page,
            per_page: limit,
        };
    }


    async exportShipmentsCityReport(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        // 1. Build the Query (Matching your report logic)
        const qb = this.shipmentRepo.createQueryBuilder('shipment')
            .innerJoin('shipment.order', 'order')
            .select('order.city', 'city')
            .addSelect('COUNT(shipment.id)', 'totalShipments')
            .addSelect(
                `COUNT(CASE WHEN shipment.status = :delivered THEN 1 END)`,
                'deliveredShipments'
            )
            .addSelect(
                `COUNT(CASE WHEN shipment.status IN (:failed, :cancelled) THEN 1 END)`,
                'failedShipments'
            )
            .where('shipment.adminId = :adminId', { adminId });

        // Apply Parameters
        qb.setParameters({
            delivered: ShipmentStatus.DELIVERED,
            failed: ShipmentStatus.FAILED,
            cancelled: ShipmentStatus.CANCELLED,
        });

        // 2. Apply same filters as the report list
        DateFilterUtil.applyToQueryBuilder(
            qb,
            "shipment.created_at",
            q?.startDate,
            q?.endDate
        );

        if (q?.storeId) {
            qb.andWhere('order.storeId = :storeId', { storeId: q.storeId });
        }

        if (q?.search) {
            qb.andWhere('order.city ILIKE :search', { search: `%${q.search}%` });
        }

        qb.groupBy('order.city').orderBy('"totalShipments"', 'DESC');

        const rawResults = await qb.getRawMany();

        // 3. Prepare Excel data (Mapping raw DB counts to final numbers)
        const exportData = rawResults.map((row) => {
            const total = parseInt(row.totalShipments) || 0;
            const delivered = parseInt(row.deliveredShipments) || 0;
            const failed = parseInt(row.failedShipments) || 0;

            return {
                city: row.city || "Unknown",
                totalShipments: total,
                actualDeliveries: delivered,
                failedShipments: failed,
                successRate: total > 0 ? `${Math.round((delivered / total) * 100)}%` : "0%",
                failureRate: total > 0 ? `${Math.round((failed / total) * 100)}%` : "0%",
            };
        });

        // 4. Create Workbook
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Shipments City Report");

        // 5. Define English Columns
        worksheet.columns = [
            { header: "City", key: "city", width: 25 },
            { header: "Total Shipments", key: "totalShipments", width: 15 },
            { header: "Actual Deliveries", key: "actualDeliveries", width: 15 },
            { header: "Failed/Cancelled", key: "failedShipments", width: 15 },
            { header: "Success Rate", key: "successRate", width: 15 },
            { header: "Failure Rate", key: "failureRate", width: 15 },
        ];

        // Style header row (matching your pattern)
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFE0E0E0" },
        };

        // Add Rows
        exportData.forEach((row) => {
            worksheet.addRow(row);
        });

        const buffer = await workbook.xlsx.writeBuffer();
        return buffer;
    }

    async getShipmentPerformanceSummary(
        me: any,
        // filters: { startDate?: string; endDate?: string; range?: string }
    ) {
        const adminId = tenantId(me);
        // let { start, end } = calculateRange(filters.range);
        // const finalStartDate = start || (filters.startDate ? new Date(filters.startDate) : startOfMonth(new Date()));
        // const finalEndDate = end || (filters.endDate ? new Date(filters.endDate) : endOfMonth(new Date()));


        const [highest, lowest, averageData] = await Promise.all([
            // 1. أعلى محافظة تسليماً
            this.getExtremeCity(adminId, 'DESC'),

            // 2. أقل محافظة تسليماً
            this.getExtremeCity(adminId, 'ASC'),

            // 3. حساب متوسط التسليمات
            this.calculateDeliveryRate(adminId)
        ]);

        return {
            highestCity: highest || { city: 'N/A', count: 0 },
            lowestCity: lowest || { city: 'N/A', count: 0 },
            deliveriesRate: averageData?.rate || 0,
        };
    }

    //
    private async getExtremeCity(adminId: string, order: 'ASC' | 'DESC') {
        return await this.shipmentRepo.createQueryBuilder('shipment')
            .innerJoin('shipment.order', 'order')
            .select('order.city', 'city')
            .addSelect('COUNT(shipment.id)', 'count')
            .where('shipment.adminId = :adminId', { adminId })
            .andWhere('shipment.status = :status', { status: ShipmentStatus.DELIVERED })
            // .andWhere('shipment.created_at BETWEEN :start AND :end', { start, end })
            .groupBy('order.city')
            .orderBy('count', order)
            .limit(1)
            .getRawOne();
    }


    private async calculateDeliveryRate(adminId: string) {
        const result = await this.shipmentRepo
            .createQueryBuilder('shipment')
            .select('COUNT(shipment.id)', 'total')
            .addSelect(
                `COUNT(CASE WHEN shipment.status = :status THEN 1 END)`,
                'delivered'
            )
            .where('shipment.adminId = :adminId', { adminId })
            .setParameter('status', ShipmentStatus.DELIVERED)
            .getRawOne();

        const total = Number(result?.total ?? 0);
        const delivered = Number(result?.delivered ?? 0);

        return {
            rate: total > 0 ? (delivered / total) * 100 : 0,
            total,
            delivered,
        };
    }

    async closeSupplierPeriod(me: any, supplierId: string, startDate: string, endDate: string) {
        const adminId = tenantId(me);
        const newStartDate = new Date(startDate);
        const newEndDate = new Date(endDate);
        return await this.dataSource.transaction(async (manager) => {
            const supplier = await manager.findOne(SupplierEntity, {
                where: { id: supplierId, adminId }
            });

            if (!supplier) throw new NotFoundException('Supplier not found');

            if (supplier.lastClosingEndDate) {
                const lastEnd = new Date(supplier.lastClosingEndDate);

                if (newStartDate <= lastEnd) {
                    const formattedDate = lastEnd.toISOString().split('T')[0];
                    throw new BadRequestException(
                        `The new closing period must start after the last closing date (${formattedDate}).`
                    );
                }
            }

            if (newEndDate <= newStartDate) {
                throw new BadRequestException('The end date must be later than the start date.');
            }

            const { finalBalance, totalReturns, totalTaken, rCount, pCount, totalPaid, totalPurchases } = await this.getSupplierPeriodPreview(me, supplierId, startDate, endDate, manager);
            if (pCount === 0 && rCount === 0) {
                throw new BadRequestException('No unclosed accepted invoices found.');
            }

            const closing = manager.create(SupplierClosingEntity, {
                adminId,
                supplierId,
                startDate: new Date(startDate),
                endDate: new Date(endDate),
                totalPurchases,
                totalPaid,
                totalReturns,
                totalTakenFromReturns: totalTaken,
                finalBalance: finalBalance,
            });

            const savedClosing = await manager.save(closing);
            await manager.update(SupplierEntity, supplierId, {
                lastClosingId: closing.id,
                lastClosingEndDate: newEndDate
            });

            await Promise.all([
                manager.update(PurchaseInvoiceEntity,
                    { adminId, supplierId, statusUpdateDate: Between(newStartDate, newEndDate), status: ApprovalStatus.ACCEPTED, closingId: IsNull() },
                    { closingId: closing.id }
                ),
                manager.update(PurchaseReturnInvoiceEntity,
                    { adminId, supplierId, statusUpdateDate: Between(newStartDate, newEndDate), status: ApprovalStatus.ACCEPTED, closingId: IsNull() },
                    { closingId: closing.id }
                )
            ]);

            return savedClosing;
        });
    }

    async getSupplierClosing(me: any, id: string) {
        const adminId = tenantId(me);
        const closing = await this.supplierClosingRepo.findOne({
            where: { id, adminId },
            relations: ['supplier']
        });
        if (!closing) throw new NotFoundException('Supplier closing not found');
        return closing;
    }

    async listSupplierClosings(me: any, q?: any) {
        const adminId = tenantId(me);
        const page = q?.page ?? 1;
        const limit = q?.limit ?? 10;

        const qb = this.supplierClosingRepo
            .createQueryBuilder("closing")
            .leftJoinAndSelect("closing.supplier", "supplier") // تأكد من وجود العلاقة في الـ Entity
            .where("closing.adminId = :adminId", { adminId });


        if (q?.supplierId) {
            qb.andWhere("closing.supplierId = :supplierId", { supplierId: q.supplierId });
        }
        if (q?.year) {
            qb.andWhere("EXTRACT(YEAR FROM closing.endDate) = :year", { year: q.year });
        }

        if (q?.search) {
            qb.andWhere("supplier.name ILIKE :s", { s: `%${q.search}%` });
        }

        if (q?.startDate) {
            qb.andWhere("closing.endDate >= :startDate", { startDate: q.startDate });
        }
        if (q?.endDate) {
            qb.andWhere("closing.endDate <= :endDate", { endDate: q.endDate });
        }

        const allowedSortFields = ['finalBalance', 'startDate', 'endDate', 'createdAt'];
        const sortBy = allowedSortFields.includes(q?.sortBy) ? q.sortBy : 'createdAt';
        const sortOrder = q?.sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        qb.orderBy(`closing.${sortBy}`, sortOrder)
            .skip((page - 1) * limit)
            .take(limit);

        const [records, total] = await qb.getManyAndCount();

        return {
            records,
            total_records: total,
            current_page: page,
            per_page: limit,
        };
    }

    async getAccountingStats(me: any, q?: any) {
        const adminId = tenantId(me);
        const startDate = q?.startDate ? new Date(q.startDate) : startOfMonth(new Date());
        const endDate = q?.endDate ? new Date(q.endDate) : endOfMonth(new Date());

        const [totalSuppliers, totalReturns, purchaseTotal] = await Promise.all([
            this.supplierRepo.count({ where: { adminId } }),

            this.returnRepo.createQueryBuilder("exp")
                .select("SUM(exp.totalReturn)", "sum")
                .where("exp.adminId = :adminId", { adminId })
                .andWhere("exp.statusUpdateDate BETWEEN :start AND :end", { start: startDate, end: endDate })
                .getRawOne(),

            this.purchaseRepo.createQueryBuilder("p")
                .select("SUM(p.total)", "sum")
                .where("p.adminId = :adminId", { adminId })
                .andWhere("p.statusUpdateDate BETWEEN :start AND :end", { start: startDate, end: endDate })
                .getRawOne(),
        ]);

        const totalReturnsAmount = parseFloat(totalReturns?.sum || 0);
        const purchaseTotalAmount = parseFloat(purchaseTotal?.sum || 0);

        return {
            totalSuppliers,
            totalReturnsAmount,
            purchaseTotalAmount,
            totalExpenses: totalReturnsAmount + purchaseTotalAmount,
        };
    }


    async getSupplierPeriodPreview(me: any, supplierId: string | null, startDate: string, endDate: string, manager?: EntityManager) {
        const adminId = tenantId(me);

        const purchaseRepo = manager ? manager.getRepository(PurchaseInvoiceEntity) : this.purchaseRepo;
        const returnRepo = manager ? manager.getRepository(PurchaseReturnInvoiceEntity) : this.returnRepo;

        const purchaseQb = purchaseRepo.createQueryBuilder("p")
            .select("SUM(p.total)", "totalPurchases")
            .addSelect("SUM(p.paidAmount)", "totalPaid")
            .addSelect("COUNT(p.id)", "count")
            .where("p.adminId = :adminId", { adminId });

        DateFilterUtil.applyToQueryBuilder(
            purchaseQb,
            "p.statusUpdateDate",
            startDate,
            endDate
        );

        purchaseQb.andWhere("p.status = :status", { status: ApprovalStatus.ACCEPTED })
            .andWhere("p.closingId IS NULL");

        const returnQb = returnRepo.createQueryBuilder("r")
            .select("SUM(r.totalReturn)", "totalReturns")
            .addSelect("SUM(r.paidAmount)", "totalTaken")
            .addSelect("COUNT(r.id)", "count")
            .where("r.adminId = :adminId", { adminId });

        DateFilterUtil.applyToQueryBuilder(
            returnQb,
            "r.statusUpdateDate",
            startDate,
            endDate
        );


        returnQb.andWhere("r.status = :status", { status: ApprovalStatus.ACCEPTED })
            .andWhere("r.closingId IS NULL");


        if (supplierId) {
            purchaseQb.andWhere("p.supplierId = :supplierId", { supplierId });
            returnQb.andWhere("r.supplierId = :supplierId", { supplierId });
        }

        const [purchaseStats, returnStats] = await Promise.all([
            purchaseQb.getRawOne(),
            returnQb.getRawOne()
        ]);


        const totalPurchases = Number(purchaseStats?.totalPurchases || 0);
        const pCount = parseInt(purchaseStats?.count || '0');
        const rCount = parseInt(returnStats?.count || '0');
        const totalPaid = Number(purchaseStats?.totalPaid || 0);
        const totalReturns = Number(returnStats?.totalReturns || 0);
        const totalTaken = Number(returnStats?.totalTaken || 0);

        // الحسابات النهائية
        const netPurchases = totalPurchases - totalReturns;
        const netPayments = totalPaid - totalTaken;
        const finalBalance = netPurchases - netPayments;

        return {
            totalPurchases,
            totalPaid,
            totalReturns,
            totalTaken,
            netPurchases,
            netPayments,
            pCount,
            rCount,
            finalBalance: finalBalance,
            period: {
                start: startDate,
                end: endDate
            }
        };
    }

}