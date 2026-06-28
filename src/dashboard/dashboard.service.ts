import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
  endOfDay,
  endOfMonth,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths,
} from "date-fns";
import {
  OrderEntity,
  OrderItemEntity,
  OrderStatus,
  OrderStatusEntity,
  OrderScanLogEntity,
  ScanLogType,
} from "entities/order.entity";
import { OrderAssignmentEntity } from "entities/assignment.entity";
import { tenantId } from "src/category/category.service";
import { Brackets, DataSource, Repository } from "typeorm";
import * as ExcelJS from "exceljs";
import { calculateRange, calculatePreviousRange } from "common/healpers";
import { User } from "entities/user.entity";
import { DateFilterUtil } from "common/date-filter.util";
import { OrderFailStatus, WebhookOrderFailureEntity } from "entities/stores.entity";

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

    @InjectRepository(WebhookOrderFailureEntity)
    private webhookOrderFailureRepo: Repository<WebhookOrderFailureEntity>,
  ) { }

  async getSummary(
    user,
    filters: {
      storeId?: string;
      startDate?: string;
      endDate?: string;
      range?: string;
      search?: string;
    },
  ) {
    const adminId = tenantId(user);

    // 1. Calculate current range
    const { start, end } = calculateRange(filters.range);
    const finalStartDate = start || filters.startDate;
    const finalEndDate = end || filters.endDate;

    // 2. Calculate previous range for comparison
    const prevRange = calculatePreviousRange(
      filters.range,
      finalStartDate ? new Date(finalStartDate) : undefined,
      finalEndDate ? new Date(finalEndDate) : undefined
    );

    // Function to fetch data for a specific range
    const fetchData = async (startDate: Date | string, endDate: Date | string) => {
      const query = this.orderRepo
        .createQueryBuilder("o")
        .leftJoin("o.status", "s")
        .where("o.adminId = :adminId", { adminId });

      if (filters.storeId)
        query.andWhere("o.storeId = :storeId", { storeId: filters.storeId });

      DateFilterUtil.applyToQueryBuilder(query, "o.created_at", startDate, endDate);

      if (filters.search) {
        query.andWhere(
          new Brackets((qb) => {
            qb.where("o.orderNumber ILIKE :search", {
              search: `%${filters.search}%`,
            }).orWhere("o.customerName ILIKE :search", {
              search: `%${filters.search}%`,
            });
          }),
        );
      }

      const rawData = await query
        .select([
          "COUNT(o.id) as totalOrders",
          "SUM(o.collectedAmount) as totalCollected",
          "SUM(CASE WHEN s.code = :deliveredStatus THEN o.finalTotal ELSE 0 END) as totalSales",
          "SUM(CASE WHEN s.code = :deliveredStatus THEN o.profit ELSE 0 END) as totalProfit",
          "COUNT(CASE WHEN s.code = :newStatus THEN 1 END) as newOrders",
          'COUNT(CASE WHEN s."isConfirmed" THEN 1 END) as confirmedOrders',
          "COUNT(CASE WHEN s.code = :deliveredStatus THEN 1 END) as deliveredOrders",
          "COUNT(CASE WHEN s.code = :cancelledStatus THEN 1 END) as cancelledOrders",
          "COUNT(CASE WHEN s.code = :shippedStatus THEN 1 END) as inDelivery",
          "COUNT(CASE WHEN s.code = :returnedStatus THEN 1 END) as returnedOrders",
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
      const totalCollected = Number(rawData.totalcollected) || 0;

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
        totalCollected,
      };
    };

    // Fetch current and comparison data
    const [currentStats, comparisonStats] = await Promise.all([
      fetchData(finalStartDate, finalEndDate),
      prevRange.start && prevRange.end
        ? fetchData(prevRange.start, prevRange.end)
        : Promise.resolve(null),
    ]);

    return {
      ...currentStats,
      comparison: comparisonStats,
    };
  }

  async getTrends(
    user,
    filters: {
      storeId?: string;
      startDate?: string;
      endDate?: string;
      range?: string;
      search?: string;
      points?: number;
    },
  ) {
    const adminId = tenantId(user);
    const points = filters.points || 12; // عدد النقاط على الرسم البياني

    // 1. حساب الفترة الزمنية (نفس منطق الـ Summary)
    let { start, end } = calculateRange(filters.range);
    const finalStartDate =
      start ||
      (filters.startDate
        ? new Date(filters.startDate)
        : subDays(new Date(), 30));
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
            WITH params AS (
            SELECT
                $1::timestamptz AS start_date,
                $2::timestamptz AS end_date,
                $3::int AS points
        ),
        calc AS (
            SELECT
                start_date,
                end_date,
                points,
                CEIL(
                    EXTRACT(EPOCH FROM (end_date - start_date)) 
                    / (points * 86400.0)
                )::int AS segment_days
            FROM params
        ),
        segments AS (
            SELECT 
                g.idx,

                c.start_date 
                + (g.idx * (c.segment_days || ' days')::interval) AS seg_start,

                LEAST(
                    c.start_date 
                    + ((g.idx + 1) * (c.segment_days || ' days')::interval),
                    c.end_date
                ) AS seg_end,
                 c.end_date AS final_end

            FROM calc c,
            generate_series(
                0,
                FLOOR(
                    EXTRACT(EPOCH FROM (c.end_date - c.start_date)) 
                    / (c.segment_days * 86400.0)
                )
            ) AS g(idx)
        )
            SELECT 
                s.seg_start AS "date",
                COUNT(o.id) AS "orders",
                COALESCE(SUM(CASE WHEN st.code = 'delivered' THEN o."finalTotal" ELSE 0 END), 0) AS "sales"
            FROM segments s
            LEFT JOIN orders o ON o.created_at >= s.seg_start  
            AND (
            o.created_at < s.seg_end
            OR (s.seg_end = s.final_end AND o.created_at <= s.seg_end) -- ✅ only last segment inclusive
            ) AND o."adminId" = $4 ${extraFilters}
            LEFT JOIN order_statuses st ON st.id = o."statusId"
            GROUP BY s.idx, s.seg_start
            ORDER BY s.seg_start ASC;
        `;

    const result = await this.dataSource.query(query, params);

    // 4. تنسيق المخرجات لتناسب الـ Chart (Trimmed Output)
    return result.map((row) => ({
      date: row.date,
      orders: parseInt(row.orders),
      sales: parseFloat(row.sales),
    }));
  }

  async getTopProducts(
    user,
    filters: {
      storeId?: string;
      startDate?: string;
      endDate?: string;
      range?: string;
      search?: string;
      limit?: number;
    },) {
    const adminId = tenantId(user);
    const limit = filters.limit || 5;

    let { start, end } = calculateRange(filters.range);
    const finalStartDate =
      start ||
      (filters.startDate
        ? new Date(filters.startDate)
        : subDays(new Date(), 30));
    const finalEndDate = end || (filters.endDate ? new Date(filters.endDate) : new Date());


    // 1️⃣ بناء الاستعلام الأساسي المشترك
    const baseQuery = this.orderRepo.manager
      .createQueryBuilder(OrderItemEntity, "item")
      .innerJoin("item.order", "o")
      .innerJoin("o.status", "s")
      .where("o.adminId = :adminId", { adminId })
      .andWhere("s.code = :deliveredStatus", {
        deliveredStatus: OrderStatus.DELIVERED,
      });

    if (filters.storeId)
      baseQuery.andWhere("o.storeId = :storeId", { storeId: filters.storeId });
    if (finalStartDate)
      baseQuery.andWhere("o.created_at  >= :startDate", {
        startDate: finalStartDate,
      });
    if (finalEndDate)
      baseQuery.andWhere("o.created_at  <= :endDate", {
        endDate: finalEndDate,
      });

    // 2️⃣ تنفيذ الاستعلامين معاً باستخدام Promise.all
    const [totalSumResult, rawData] = await Promise.all([
      // الاستعلام الأول: إجمالي الكمية المباعة لكل المنتجات
      baseQuery.clone().select("SUM(item.quantity)", "total").getRawOne(),

      // الاستعلام الثاني: قائمة أفضل المنتجات
      baseQuery
        .clone()
        .innerJoin("item.variant", "v")
        .innerJoin("v.product", "p")
        .select([
          "p.name AS name",
          'p.mainImage AS "mainImage"',
          "SUM(item.quantity) AS total_quantity",
        ])
        .groupBy("p.id")
        .addGroupBy("p.name")
        .addGroupBy("p.mainImage")
        .orderBy("total_quantity", "DESC")
        .limit(limit)
        .getRawMany(),
    ]);

    const allProductsTotalQuantity = Number(totalSumResult?.total || 0);

    // 3️⃣ معالجة النتائج وحساب النسب
    const records = rawData.map((row, index) => {
      const count = Number(row.total_quantity) || 0;
      const percentage =
        allProductsTotalQuantity > 0
          ? (count / allProductsTotalQuantity) * 100
          : 0;

      return {
        id: index + 1,
        name: row.name || "منتج غير معروف",
        image: row.mainImage || null,
        count: count,
        percentage: Number(percentage.toFixed(2)),
      };
    });

    return records;
  }

  async getProfitReport(
    user,
    filters: {
      storeId?: string;
      startDate?: string;
      endDate?: string;
      range?: string;
    },
  ) {
    const adminId = tenantId(user);
    const points = 4; // تقسيم الشهر إلى 4 فترات زمنية (أسابيع تقريباً)

    // حساب الفترة (الافتراضي الشهر الحالي إذا لم يحدد المستخدم)
    let { start, end } = calculateRange(filters.range || "thisMonth");
    const finalStartDate =
      start ||
      (filters.startDate
        ? new Date(filters.startDate)
        : startOfMonth(new Date()));
    const finalEndDate =
      end ||
      (filters.endDate ? new Date(filters.endDate) : endOfMonth(new Date()));
    finalStartDate?.setHours(0, 0, 0, 0);
    finalEndDate?.setHours(23, 59, 59, 999);
    const params: any[] = [finalStartDate, finalEndDate, points, adminId];
    let extraFilters = "";
    if (filters.storeId) {
      extraFilters += ` AND o."storeId" = $5`;
      params.push(filters.storeId);
    }

    const query = `
        WITH params AS (
            SELECT
                $1::timestamptz AS start_date,
                $2::timestamptz AS end_date,
                $3::int AS points
        ),
        calc AS (
            SELECT
                start_date,
                end_date,
                points,
                CEIL(
                    EXTRACT(EPOCH FROM (end_date - start_date)) 
                    / (points * 86400.0)
                )::int AS segment_days
            FROM params
        ),
        segments AS (
            SELECT 
                g.idx,

                c.start_date 
                + (g.idx * (c.segment_days || ' days')::interval) AS seg_start,

                LEAST(
                    c.start_date 
                    + ((g.idx + 1) * (c.segment_days || ' days')::interval),
                    c.end_date
                ) AS seg_end,
                 c.end_date AS final_end

            FROM calc c,
            generate_series(
                0,
                FLOOR(
                    EXTRACT(EPOCH FROM (c.end_date - c.start_date)) 
                    / (c.segment_days * 86400.0)
                )
            ) AS g(idx)
        )
        SELECT 
            s.idx,
            s.seg_start,
            s.seg_end,
            -- المبيعات: الطلبات التي تم تسليمها فقط
            COALESCE(SUM(CASE WHEN st.code = 'delivered' THEN (o."finalTotal" - COALESCE(o."shippingCost", 0)) ELSE 0 END), 0) AS "sales",
            -- التكاليف: مجموع تكلفة المنتجات داخل الطلبات المسلمة
            COALESCE(SUM(CASE WHEN st.code = 'delivered' THEN (
                SELECT SUM(oi."unitCost" * oi.quantity) 
                FROM order_items oi WHERE oi."orderId" = o.id
            ) ELSE 0 END), 0) AS "costs"
        FROM segments s
        LEFT JOIN 
        orders o ON o."deliveredAt" >= s.seg_start 
         AND (
            o."deliveredAt" < s.seg_end
            OR (s.seg_end = s.final_end AND o."deliveredAt" <= s.seg_end) -- ✅ only last segment inclusive
        )

        AND o."adminId" = $4 ${extraFilters}
        LEFT JOIN order_statuses st ON st.id = o."statusId"
        GROUP BY s.idx, s.seg_start, s.seg_end
        ORDER BY s.seg_start ASC;
    `;

    const result = await this.dataSource.query(query, params);

    return result.map((row) => {
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
      const monthName = startDate.toLocaleDateString("ar-EG", {
        month: "long",
      });

      return {
        // الناتج سيكوم مثلاً: "1 - 7 يوليو"
        period: `${startDay} - ${endDay} ${monthName}`,
        startDate,
        endDate,
        sales: sales,
        costs: costs,
        profit: profit,
        margin: Math.round(margin),
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
    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFF8B00" }, // لونك الأساسي --primary
    };
    worksheet.getRow(1).alignment = { horizontal: "center" };

    // 4. إضافة البيانات وتنسيق الصفوف
    reportData.forEach((row) => {
      const newRow = worksheet.addRow({
        ...row,
        margin: `${row.margin}%`, // إضافة علامة النسبة المئوية
      });

      // تنسيق الأرقام والعملات
      newRow.getCell("sales").numFmt = "#,##0.00";
      newRow.getCell("costs").numFmt = "#,##0.00";
      newRow.getCell("profit").numFmt = "#,##0.00";

      // تلوين صافي الربح (أخضر للربح، أحمر للخسارة)
      const profitCell = newRow.getCell("profit");
      profitCell.font = {
        color: { argb: row.profit >= 0 ? "FF008000" : "FFFF0000" },
        bold: true,
      };

      // محاذاة البيانات
      newRow.alignment = { horizontal: "right" };
    });

    // إضافة صف الإجمالي في النهاية
    const totalSales = reportData.reduce((sum, r) => sum + r.sales, 0);
    const totalProfit = reportData.reduce((sum, r) => sum + r.profit, 0);

    const footerRow = worksheet.addRow({
      period: "الإجمالي الكلي",
      sales: totalSales,
      profit: totalProfit,
      margin:
        totalSales > 0
          ? `${Math.round((totalProfit / totalSales) * 100)}%`
          : "0%",
    });
    footerRow.font = { bold: true };
    footerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF9FAFB" },
    };

    return await workbook.xlsx.writeBuffer();
  }

  async getOrderAnalysisStats(user: any, filters: any) {
    const adminId = tenantId(user);
    if (!adminId) throw new BadRequestException("Missing adminId");

    // 1. حساب النطاق الزمني
    let { start, end } = calculateRange(filters.range);
    const finalStartDate =
      start || (filters.startDate ? new Date(filters.startDate) : null);
    const finalEndDate =
      end || (filters.endDate ? new Date(filters.endDate) : null);

    // 2. بناء شروط الـ JOIN ديناميكياً
    // نستخدم مصفوفة لتجميع الشروط التي ستوضع داخل الـ ON الخاص بالـ Join
    let joinConditions = "o.statusId = status.id AND o.adminId = :adminId";
    const joinParams: any = { adminId };

    if (filters.storeId) {
      joinConditions += " AND o.storeId = :storeId";
      joinParams.storeId = filters.storeId;
    }
    if (finalStartDate) {
      joinConditions += " AND o.created_at >= :startDate";
      joinParams.startDate = finalStartDate;
    }
    if (finalEndDate) {
      joinConditions += " AND o.created_at <= :endDate";
      joinParams.endDate = finalEndDate;
    }
    if (filters.search) {
      joinConditions +=
        " AND (o.orderNumber ILIKE :search OR o.customerName ILIKE :search)";
      joinParams.search = `%${filters.search}%`;
    }

    const stats = await this.statusRepo
      .createQueryBuilder("status")
      // use relation path only (no join condition)
      .leftJoin("status.orders", "o", joinConditions, joinParams)
      .select([
        "status.id AS id",
        "status.name AS name",
        "status.code AS code",
        "status.color  AS color",
        "status.system AS system",
        "status.sortOrder AS sortOrder",
      ])
      .addSelect("COUNT(o.id)", "count")
      .where(
        new Brackets((qb) => {
          qb.where("status.adminId = :adminId", { adminId }).orWhere(
            "status.system = :system",
            { system: true },
          );
        }),
      )
      .andWhere("status.isActive = true")
      // GROUP BY every non-aggregated selected column (Postgres requires this)
      .groupBy("status.id")
      .addGroupBy("status.name")
      .addGroupBy("status.code")
      .addGroupBy("status.color")
      .addGroupBy("status.system")
      .addGroupBy("status.sortOrder")
      .orderBy("status.sortOrder", "ASC")
      .getRawMany();

    return stats.map((stat) => ({
      ...stat,
      id: stat.id,
      count: Number(stat.count) || 0,
      system: stat.system || stat.system,
    }));
  }

  async getOrdersTrends(
    user,
    filters: {
      storeId?: string;
      startDate?: string;
      endDate?: string;
      range?: string;
      search?: string;
      points?: number;
    },
  ) {
    const adminId = tenantId(user);
    const points = filters.points || 12;

    let { start, end } = calculateRange(filters.range);

    const finalStartDate =
      start ||
      (filters.startDate
        ? new Date(filters.startDate)
        : subDays(new Date(), 30));
    const finalEndDate =
      end || (filters.endDate ? new Date(filters.endDate) : new Date());


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
    WITH params AS (
            SELECT
                $1::timestamptz AS start_date,
                $2::timestamptz AS end_date,
                $3::int AS points
        ),
        calc AS (
            SELECT
                start_date,
                end_date,
                points,
                CEIL(
                    EXTRACT(EPOCH FROM (end_date - start_date)) 
                    / (points * 86400.0)
                )::int AS segment_days
            FROM params
        ),
        segments AS (
            SELECT 
                g.idx,

                c.start_date 
                + (g.idx * (c.segment_days || ' days')::interval) AS seg_start,

                LEAST(
                    c.start_date 
                    + ((g.idx + 1) * (c.segment_days || ' days')::interval),
                    c.end_date
                ) AS seg_end,
                 c.end_date AS final_end

            FROM calc c,
            generate_series(
                0,
                FLOOR(
                    EXTRACT(EPOCH FROM (c.end_date - c.start_date)) 
                    / (c.segment_days * 86400.0)
                )
            ) AS g(idx)
        )
    SELECT 
        s.seg_start AS "date",
        COUNT(o.id) AS "total_orders",
        COUNT(CASE WHEN st.code = '${OrderStatus.NEW}' THEN o.id END) AS "new_orders",
        -- تم إزالة الفاصلة من نهاية السطر التالي
        COUNT(CASE WHEN st.code = '${OrderStatus.DELIVERED}' THEN o.id END) AS "delivered_orders"
    FROM segments s
    LEFT JOIN orders o 

    ON o.created_at >= s.seg_start 
    AND 

    (
      o.created_at < s.seg_end
      OR (s.seg_end = s.final_end AND o.created_at <= s.seg_end) -- ✅ only last segment inclusive
      )

    AND o."adminId" = $4 ${extraFilters}
    LEFT JOIN order_statuses st ON st.id = o."statusId"
    GROUP BY s.idx, s.seg_start
    ORDER BY s.seg_start ASC;
`;

    const result = await this.dataSource.query(query, params);

    return result.map((row) => ({
      date: row.date,
      newOrders: parseInt(row.new_orders),
      deliveredOrders: parseInt(row.delivered_orders),
    }));
  }

  async getTopAreasReport(
    user,
    filters: {
      storeId?: string;
      startDate?: string;
      endDate?: string;
      range?: string;
      limit?: number;
    },
  ) {
    const adminId = tenantId(user);
    const limit = filters.limit || 5; // افتراضياً أعلى 5 مناطق

    let { start, end } = calculateRange(filters.range || "thisMonth");
    const finalStartDate =
      start ||
      (filters.startDate
        ? new Date(filters.startDate)
        : startOfMonth(new Date()));
    const finalEndDate =
      end ||
      (filters.endDate ? new Date(filters.endDate) : endOfMonth(new Date()));
    finalStartDate?.setHours(0, 0, 0, 0);
    finalEndDate?.setHours(23, 59, 59, 999);
    const params: any[] = [finalStartDate, finalEndDate, adminId, limit];
    let extraFilters = "";
    if (filters.storeId) {
      extraFilters += ` AND o."storeId" = $5`;
      params.push(filters.storeId);
    }
    const query = `
        SELECT 
            COALESCE(cd."nameAr", o.city) AS city,
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
        LEFT JOIN cities cd ON cd.id = o."cityId"
        WHERE o."adminId" = $3 
          AND o.created_at >= $1 
          AND o.created_at <= $2
          ${extraFilters}
        GROUP BY COALESCE(cd."nameAr", o.city)
        ORDER BY "sales" DESC
        LIMIT $4;
    `;

    const result = await this.dataSource.query(query, params);

    return result.map((row) => {
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
        deliveryRate: total > 0 ? Math.round((delivered / total) * 100) : 0,
      };
    });
  }

  async exportTopAreasReport(user: any, filters: any) {
    // 1. Get the data from our getTopCitiesStats method
    const reportData = await this.getTopCitiesStats(user, filters);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Top Areas Report");

    // 2. Define columns matching the frontend table
    worksheet.columns = [
      { header: "City Area", key: "cityArea", width: 25 },
      { header: "Total Orders", key: "totalOrders", width: 15 },
      { header: "Corrected Orders", key: "correctedOrders", width: 18 },
      { header: "Confirmed Count", key: "confirmedCount", width: 18 },
      { header: "Shipped Orders", key: "shippedOrders", width: 18 },
      { header: "Delivered Total", key: "deliveredTotal", width: 18 },
      { header: "Delivered from Confirmed", key: "deliveredFromConfirmed", width: 22 },
    ];

    // 3. Format header
    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF6366F1" }, // Primary color
    };
    worksheet.getRow(1).alignment = {
      horizontal: "center",
      vertical: "middle",
    };

    // 4. Add data and format rows
    reportData.forEach((row) => {
      const newRow = worksheet.addRow({
        cityArea: row.nameEn || row.nameAr || '',
        totalOrders: row.totalOrders,
        correctedOrders: row.correctedOrders,
        confirmedCount: row.confirmedCount,
        shippedOrders: row.shippedOrders,
        deliveredTotal: row.deliveredTotal,
        deliveredFromConfirmed: row.deliveredFromConfirmed,
      });
      newRow.alignment = { horizontal: "center" };
    });

    return await workbook.xlsx.writeBuffer();
  }

  async exportTopProductsReport(user: any, filters: any) {
    // 1. Get the data from our getTopProductsStats method
    const reportData = await this.getTopProductsStats(user, filters);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Top Products Report");

    // 2. Define columns matching the frontend table
    worksheet.columns = [
      { header: "Product Name", key: "name", width: 30 },
      { header: "Total Orders", key: "totalOrders", width: 15 },
      { header: "Corrected Orders", key: "correctedOrders", width: 18 },
      { header: "Confirmed Count", key: "confirmedCount", width: 18 },
      { header: "Shipped Orders", key: "shippedOrders", width: 18 },
      { header: "Delivered Total", key: "deliveredTotal", width: 18 },
      { header: "Delivered from Confirmed", key: "deliveredFromConfirmed", width: 22 },
    ];

    // 3. Format header
    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF6366F1" }, // Primary color
    };
    worksheet.getRow(1).alignment = {
      horizontal: "center",
      vertical: "middle",
    };

    // 4. Add data and format rows
    reportData.forEach((row) => {
      const newRow = worksheet.addRow({
        name: row.name,
        totalOrders: row.totalOrders,
        correctedOrders: row.correctedOrders,
        confirmedCount: row.confirmedCount,
        shippedOrders: row.shippedOrders,
        deliveredTotal: row.deliveredTotal,
        deliveredFromConfirmed: row.deliveredFromConfirmed,
      });
      newRow.alignment = { horizontal: "center" };
    });

    return await workbook.xlsx.writeBuffer();
  }

  async getEmployeePerformance(user: any, q: any) {
    const adminId = tenantId(user);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? "").trim();
    const { start, end } = DateFilterUtil.getBoundaries(q?.startDate, q?.endDate);

    const qb = this.usersRepo.createQueryBuilder("u");

    // Scope assignments to the selected period on lastActionAt (same rows as totalAssigned)
    const oaRangeParts: string[] = [];
    if (start) oaRangeParts.push(`oa."lastActionAt" >= :empPerfRangeStart`);
    if (end) oaRangeParts.push(`oa."lastActionAt" <= :empPerfRangeEnd`);
    const oaJoinOn = oaRangeParts.length > 0 ? oaRangeParts.join(" AND ") : "1=1";

    qb.leftJoin("u.assignments", "oa", oaJoinOn)
      .leftJoin("oa.lastStatus", "la")
      .leftJoin("oa.order", "o")
      .leftJoin("o.status", "st");

    if (start) qb.setParameter("empPerfRangeStart", start);
    if (end) qb.setParameter("empPerfRangeEnd", end);

    // Filters
    qb.where("u.adminId = :adminId", { adminId });

    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("u.name ILIKE :s", { s: `%${search}%` }).orWhere(
            "o.orderNumber ILIKE :s",
            { s: `%${search}%` },
          );
        }),
      );
    }

    if (q?.storeId) {
      qb.andWhere("o.storeId = :storeId", { storeId: q.storeId });
    }

    qb.select(["u.id AS id", "u.name AS name", "u.avatarUrl AS avatarUrl", "u.isActive AS isActive"])
      .addSelect(
        "COUNT(DISTINCT oa.id)",
        "totalAssigned"
      )
      .addSelect(
        `COUNT(DISTINCT CASE WHEN la.code = '${OrderStatus.CONFIRMED}' THEN oa.id END)`,
        "confirmedCount",
      )
      .addSelect(
        `COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.SHIPPED}' THEN oa.id END)`,
        "shippedCount",
      )
      .addSelect(
        `COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.DELIVERED}' THEN oa.id END)`,
        "deliveredCount",
      )
      .addSelect((sub) => {
        return sub
          .select("COUNT(oa_active.id)", "activeCount")
          .from(OrderAssignmentEntity, "oa_active")
          .where("oa_active.employeeId = u.id")
          .andWhere("oa_active.isAssignmentActive = true");
      }, "activeAssignments")
      .addSelect((sub) => {
        return sub
          .select("COUNT(oa_locked.id)", "lockedCount")
          .from(OrderAssignmentEntity, "oa_locked")
          .where("oa_locked.employeeId = u.id")
          .andWhere("oa_locked.lockedUntil > CURRENT_TIMESTAMP");
      }, "lockedAssignments")
      .addSelect((sub) => {
        const s = sub
          .select("COUNT(sl.id)", "prepFailedCount")
          .from(OrderScanLogEntity, "sl")
          .where("sl.userId = u.id")
          .andWhere("sl.phase = :prepPhase", { prepPhase: ScanLogType.PREPARATION });
        if (q?.startDate && start)
          s.andWhere("sl.createdAt >= :empPerfRangeStart");
        if (q?.endDate && end)
          s.andWhere("sl.createdAt <= :empPerfRangeEnd");
        return s;
      }, "preparationFailedCount")
      .addSelect((sub) => {
        const s = sub
          .select("COUNT(sl.id)", "outFailedCount")
          .from(OrderScanLogEntity, "sl")
          .where("sl.userId = u.id")
          .andWhere("sl.phase = :shipPhase", { shipPhase: ScanLogType.SHIPPING });
        if (q?.startDate && start)
          s.andWhere("sl.createdAt >= :empPerfRangeStart");
        if (q?.endDate && end)
          s.andWhere("sl.createdAt <= :empPerfRangeEnd");
        return s;
      }, "outgoingFailedCount");

    // Grouping
    qb.groupBy("u.id").addGroupBy("u.name").addGroupBy("u.avatarUrl").addGroupBy("u.isActive");

    const [totalRecordsResult, stats] = await Promise.all([
      // استعلام العدد (Count Query)
      qb
        .clone()
        .select("COUNT(DISTINCT u.id)", "count")
        .orderBy() // تفريغ الـ OrderBy لحل مشكلة Postgres
        .getRawOne(),

      // استعلام البيانات (Data Query)
      qb
        .orderBy("COUNT(DISTINCT oa.id)", "DESC")
        .offset((page - 1) * limit)
        .limit(limit)
        .getRawMany(),
    ]);

    // استخراج العدد الإجمالي
    const totalRecords = Number(totalRecordsResult?.count || 0);

    // Format output
    const records = stats.map((row) => {
      const total = Number(row?.totalAssigned) || 0;
      const confirmed = Number(row?.confirmedCount) || 0;
      const shipped = Number(row?.shippedCount) || 0;
      const delivered = Number(row?.deliveredCount) || 0;
      const activeCount = Number(row?.activeAssignments) || 0;
      const lockedCount = Number(row?.lockedAssignments) || 0;
      const prepFailedCount =
        Number(
          row?.preparationfailedcount ??
          row?.preparationFailedRate,
        ) || 0;
      const outFailedCount =
        Number(
          row?.outgoingfailedcount ??
          row?.outgoingFailedRate,
        ) || 0;

      return {
        id: row?.id,
        name: row?.name,
        avatarUrl: row?.avatarurl,
        isActive: row?.isactive,
        totalAssigned: total,
        activeAssignments: activeCount,
        lockedAssignments: lockedCount,
        preparationFailedRate: prepFailedCount,
        outgoingFailedRate: outFailedCount,
        confirmed: {
          count: confirmed,
          percent: total > 0 ? Math.round((confirmed / total) * 100) : 0,
        },
        shipped: {
          count: shipped,
          percent: total > 0 ? Math.round((shipped / total) * 100) : 0,
        },
        delivered: {
          count: delivered,
          percent: total > 0 ? Math.round((delivered / total) * 100) : 0,
        },
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
    const exportLimit = Math.min(Number(q?.exportLimit ?? 100_000), 500_000);
    const { records: stats } = await this.getEmployeePerformance(user, {
      ...q,
      page: 1,
      limit: exportLimit,
    });

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
    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFF8B00" },
    };
    worksheet.getRow(1).alignment = { horizontal: "center" };

    stats.forEach((row) => {
      const total = Number(row.totalAssigned) || 0;
      const delivered = Number(row.delivered?.count) || 0;
      const confirmed = Number(row.confirmed?.count) || 0;
      const shipped = Number(row.shipped?.count) || 0;
      const rate = total > 0 ? Math.round((delivered / total) * 100) : 0;

      const newRow = worksheet.addRow({
        name: row.name,
        totalAssigned: total,
        confirmedCount: confirmed,
        confirmedPercent:
          total > 0 ? `${Math.round((confirmed / total) * 100)}%` : "0%",
        shippedCount: shipped,
        deliveredCount: delivered,
        deliveryRate: `${rate}%`,
      });

      // تلوين نسبة النجاح (أخضر إذا كانت فوق 75%)
      const rateCell = newRow.getCell("deliveryRate");
      rateCell.font = {
        bold: true,
        color: { argb: rate >= 75 ? "FF008000" : "FFFF0000" },
      };

      newRow.alignment = { horizontal: "center" };
      newRow.getCell("name").alignment = { horizontal: "right" };
    });

    return await workbook.xlsx.writeBuffer();
  }

  async getEmployeeAnalysisStats(user: any, q: any) {
    const adminId = tenantId(user);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const targetCodes = [
      OrderStatus.NEW,
      OrderStatus.CONFIRMED,
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
      OrderStatus.CANCELLED,
    ];

    const rawExcept = q?.except;
    const exceptCodes: string[] = Array.isArray(rawExcept)
      ? rawExcept.map((c) => String(c).trim().toLowerCase()).filter(Boolean)
      : typeof rawExcept === "string" && rawExcept.length > 0
        ? rawExcept.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
        : [];


    const { start, end } = DateFilterUtil.getBoundaries(q.startDate, q.endDate);
    const startDate = start;
    const endDate = end;

    const dateMatchedAssignments = `(:startDate::timestamp IS NULL OR oa."lastActionAt" >= :startDate::timestamp) AND (:endDate::timestamp IS NULL OR oa."lastActionAt" <= :endDate::timestamp)`;

    const assignmentCountExpr =
      exceptCodes.length > 0
        ? `COUNT(DISTINCT CASE WHEN status.code IN (:...exceptCodes) THEN oa.id WHEN ${dateMatchedAssignments} THEN oa.id END)`
        : `COUNT(DISTINCT CASE WHEN ${dateMatchedAssignments} THEN oa.id END)`;


    const qb = this.statusRepo
      .createQueryBuilder("status")
      .leftJoin(
        OrderAssignmentEntity,
        "oa",
        `oa."lastStatusId" = status.id AND oa."assignedByAdminId" = :adminId`,
      )
      .select([
        "status.id AS id",
        "status.name AS name",
        "status.code AS code",
        "status.color AS color",
        `status."sortOrder" AS sortOrder`,
      ])
      .addSelect(assignmentCountExpr, "count");

    if (exceptCodes.length > 0) qb.setParameter("exceptCodes", exceptCodes);

    qb.setParameter("adminId", adminId)
      .setParameter("startDate", startDate)
      .setParameter("endDate", endDate)
      .where("status.code IN (:...codes)", { codes: targetCodes });

    qb.andWhere(
      new Brackets((sq) => {
        sq.where("status.adminId = :adminId", { adminId }).orWhere(
          "status.system = :system",
          { system: true },
        );
      }),
    );

    const totalCountQb = this.dataSource
      .getRepository(OrderAssignmentEntity)
      .createQueryBuilder("oa")
      .leftJoin("oa.lastStatus", "status")
      .where("oa.assignedByAdminId = :adminId", { adminId: adminId })
      .select(assignmentCountExpr, "totalCount");

    if (exceptCodes.length > 0)
      totalCountQb.setParameter("exceptCodes", exceptCodes);

    totalCountQb
      .setParameter("adminId", adminId)
      .setParameter("startDate", startDate)
      .setParameter("endDate", endDate);

    const scanStatsQb = this.dataSource.getRepository(OrderScanLogEntity)
      .createQueryBuilder("sl")
      .where("sl.adminId = :adminId", { adminId })
      .andWhere(startDate ? "sl.createdAt >= :startDate" : "1=1", { startDate })
      .andWhere(endDate ? "sl.createdAt <= :endDate" : "1=1", { endDate })
      .select([])
      .addSelect(
        `COUNT(sl.id) FILTER (WHERE sl.phase = :prepPhase)`,
        "preparationFailedCount",
      )
      .addSelect(
        `COUNT(sl.id) FILTER (WHERE sl.phase = :shipPhase)`,
        "outgoingFailedCount",
      )
      .setParameter("prepPhase", ScanLogType.PREPARATION)
      .setParameter("shipPhase", ScanLogType.SHIPPING);

    const [stats, totalRes, scanRes] = await Promise.all([
      qb
        .groupBy("status.id")
        .addGroupBy("status.name")
        .addGroupBy("status.code")
        .addGroupBy("status.color")
        .addGroupBy("status.sortOrder")
        .orderBy("status.sortOrder", "ASC")
        .getRawMany(),
      totalCountQb.getRawOne(),
      scanStatsQb.getRawOne(),
    ]);

    const totalCount = Number(totalRes?.totalCount || 0);

    const calculatePercent = (count: number) => {
      if (totalCount === 0) return 0;
      return parseFloat(((count / totalCount) * 100).toFixed(2));
    };

    const formattedStats = stats.map((stat) => {
      const count = Number(stat.count) || 0;
      return {
        id: stat.id,
        name: stat.name,
        code: stat.code,
        color: stat.color,
        count: count,
        percent: calculatePercent(count),
      };
    });

    formattedStats.unshift({
      id: 0,
      name: "Total Assignments",
      code: "total",
      color: "var(--primary)",
      count: totalCount,
      percent: 0,
    });

    formattedStats.push({
      id: 998,
      name: "Preparation Failed Count",
      code: "preparationFailedCount",
      color: "#f59e0b",
      count: Number(scanRes?.preparationFailedCount || 0),
      percent: 0,
    });

    formattedStats.push({
      id: 999,
      name: "Outgoing Failed Count",
      code: "outgoingFailedCount",
      color: "#ef4444",
      count: Number(scanRes?.outgoingFailedCount || 0),
      percent: 0,
    });

    return formattedStats;
  }

  async getAdvancedStats(user: any, filters: any) {
    const adminId = tenantId(user);
    if (!adminId) throw new BadRequestException("Missing adminId");

    // Calculate Date Boundaries
    let { start: startRange, end: endRange } = calculateRange(filters.range);
    const { start, end } = DateFilterUtil.getBoundaries(filters.startDate, filters.endDate);
    const startDate = startRange ? startRange : start;
    const endDate = endRange ? endRange : end;
    
    // Calculate previous range for comparison
    const prevRange = calculatePreviousRange(
      filters.range,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined
    );

    // Function to fetch data for a specific range
    const fetchData = async (rangeStart: Date | string, rangeEnd: Date | string) => {
      const mainQb = this.orderRepo.createQueryBuilder("o")
        .leftJoin("o.status", "st")
        .leftJoin("o.oldStatus", "oldSt")
        .where("o.adminId = :adminId", { adminId });

      // Apply Filters to Main Query
      if (filters.storeId) mainQb.andWhere("o.storeId = :storeId", { storeId: filters.storeId });
      if (filters.cityId) mainQb.andWhere("o.cityId = :cityId", { cityId: filters.cityId });
      if (filters.shippingCompanyId) {
        mainQb.andWhere("o.shippingCompanyId = :shippingCompanyId", { shippingCompanyId: filters.shippingCompanyId });
      }
      if (rangeStart) mainQb.andWhere("o.created_at >= :rangeStart", { rangeStart });
      if (rangeEnd) mainQb.andWhere("o.created_at <= :rangeEnd", { rangeEnd });

      if (filters.productIds && filters.productIds.length > 0) {
        const pIds = Array.isArray(filters.productIds) ? filters.productIds : filters.productIds.split(',');
        mainQb.andWhere(`EXISTS (
          SELECT 1 FROM order_items oi
          INNER JOIN product_variants pv ON oi."variantId" = pv.id
          WHERE oi."orderId" = o.id AND pv."productId" IN (:...pIds)
        )`, { pIds });
      }

      if (filters.assignedUserId) {
        mainQb.andWhere(`
          :assignedUserId = (
            SELECT oa."employeeId"
            FROM order_assignments oa
            WHERE oa."orderId" = o.id
            ORDER BY oa."assignedAt" DESC
            LIMIT 1
          )
        `, { assignedUserId: filters.assignedUserId });
      }

      mainQb.select([
        `COUNT(DISTINCT o.id) AS "totalOrders"`,
        `COUNT(DISTINCT CASE WHEN st.code NOT IN ('${OrderStatus.DUPLICATE}', '${OrderStatus.OUT_OF_DELIVERY_AREA}', '${OrderStatus.WRONG_NUMBER}') THEN o.id END) AS "correctedOrders"`,
        `COUNT(DISTINCT CASE WHEN o."isConfirmed" = true THEN o.id END) AS "confirmedCount"`,
        `COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.DELIVERED}' AND o."isConfirmed" = true THEN o.id END) AS "deliveredFromConfirmed"`,
        `COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.DELIVERED}' THEN o.id END) AS "deliveredFromTotal"`,
        `COALESCE(SUM(o."finalTotal"), 0) AS "totalSales"`,
        `COALESCE(SUM(CASE WHEN st.code = '${OrderStatus.DELIVERED}' THEN o."finalTotal" ELSE 0 END), 0) AS "deliveredSales"`,
        `COALESCE(SUM(o."collectedAmount"), 0) AS "collectedAmount"`,
        `COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.NEW}' THEN o.id END) AS "newOrders"`,
        `COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.RETURNED}' THEN o.id END) AS "returnedOrders"`,
        `COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.POSTPONED}' THEN o.id END) AS "postponedOrders"`,
        `COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.OUT_OF_DELIVERY_AREA}' THEN o.id END) AS "outOfDeliveryOrders"`,
        `COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.WRONG_NUMBER}' THEN o.id END) AS "wrongNumberOrders"`,
        `COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.CANCELLED}' THEN o.id END) AS "canceledOrders"`,
        `COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.CONFIRMED}' THEN o.id END) AS "statusConfirmedOrders"`,
        `COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.SHIPPED}' THEN o.id END) AS "shippedOrders"`,
        `COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.DELIVERED}' THEN o.id END) AS "statusDeliveredOrders"`,
        `COUNT(DISTINCT CASE 
          WHEN (st.code = '${OrderStatus.CANCELLED}' AND EXISTS (SELECT 1 FROM order_assignments oa WHERE oa."orderId" = o.id AND oa."isAssignmentActive" = true))
          OR (st.code = '${OrderStatus.UNDER_REVIEW}' AND oldSt.code = '${OrderStatus.CANCELLED}') 
        THEN o.id END) AS "canceledAndUnderReview"`,
        `COUNT(DISTINCT CASE WHEN st.code IN ('${OrderStatus.DISTRIBUTED}', '${OrderStatus.PRINTED}', '${OrderStatus.PREPARING}', '${OrderStatus.READY}', '${OrderStatus.PACKED}', '${OrderStatus.SHIPPED}') THEN o.id END) AS "inWarehouseOrders"`
      ]);

      // QUERY 2: Pending/Failed Webhook Orders
      const pendingQb = this.webhookOrderFailureRepo
        .createQueryBuilder("wf")
        .where("wf.adminId = :adminId", { adminId })
        .andWhere("wf.status != :successStatus", { successStatus: OrderFailStatus.SUCCESS });

      if (filters.storeId) pendingQb.andWhere("wf.storeId = :storeId", { storeId: filters.storeId });
      if (rangeStart) pendingQb.andWhere("wf.created_at >= :rangeStart", { rangeStart });
      if (rangeEnd) pendingQb.andWhere("wf.created_at <= :rangeEnd", { rangeEnd });
      
      pendingQb.select("COUNT(DISTINCT wf.id)", "count");

      const [mainStats, pendingStats] = await Promise.all([
        mainQb.getRawOne(),
        pendingQb.getRawOne()
      ]);

      const getVal = (key1: string, key2: string) => Number(mainStats[key1] ?? mainStats[key2]) || 0;

      return {
        totalOrders: getVal("totalOrders", "totalorders"),
        correctedOrders: getVal("correctedOrders", "correctedorders"),
        confirmedCount: getVal("confirmedCount", "confirmedcount"),
        deliveredFromConfirmed: getVal("deliveredFromConfirmed", "deliveredfromconfirmed"),
        deliveredFromTotal: getVal("deliveredFromTotal", "deliveredfromtotal"),
        totalSales: getVal("totalSales", "totalsales"),
        deliveredSales: getVal("deliveredSales", "deliveredsales"),
        collectedAmount: getVal("collectedAmount", "collectedamount"),
        statuses: {
          new: getVal("newOrders", "neworders"),
          returned: getVal("returnedOrders", "returnedorders"),
          postponed: getVal("postponedOrders", "postponedorders"),
          outOfDelivery: getVal("outOfDeliveryOrders", "outofdeliveryorders"),
          wrongNumber: getVal("wrongNumberOrders", "wrongnumberorders"),
          canceled: getVal("canceledOrders", "canceledorders"),
          confirmed: getVal("statusConfirmedOrders", "statusconfirmedorders"),
          shipped: getVal("shippedOrders", "shippedorders"),
          delivered: getVal("statusDeliveredOrders", "statusdeliveredorders"),
        },
        canceledAndUnderReview: getVal("canceledAndUnderReview", "canceledandunderreview"),
        pendingOrders: Number(pendingStats?.count || 0),
        inWarehouseOrders: getVal("inWarehouseOrders", "inwarehouseorders"),
      };
    };

    // Fetch current range status breakdown separately
    const statusQb = this.orderRepo.createQueryBuilder("o")
      .leftJoin("o.status", "st")
      .where("o.adminId = :adminId", { adminId });

    if (filters.storeId) statusQb.andWhere("o.storeId = :storeId", { storeId: filters.storeId });
    if (filters.cityId) statusQb.andWhere("o.cityId = :cityId", { cityId: filters.cityId });
    if (filters.shippingCompanyId) {
      statusQb.andWhere("o.shippingCompanyId = :shippingCompanyId", { shippingCompanyId: filters.shippingCompanyId });
    }
    if (startDate) statusQb.andWhere("o.created_at >= :startDate", { startDate });
    if (endDate) statusQb.andWhere("o.created_at <= :endDate", { endDate });

    if (filters.productIds && filters.productIds.length > 0) {
      const pIds = Array.isArray(filters.productIds) ? filters.productIds : filters.productIds.split(',');
      statusQb.andWhere(`EXISTS (
        SELECT 1 FROM order_items oi
        INNER JOIN product_variants pv ON oi."variantId" = pv.id
        WHERE oi."orderId" = o.id AND pv."productId" IN (:...pIds)
      )`, { pIds });
    }

    if (filters.assignedUserId) {
      statusQb.andWhere(`
        :assignedUserId = (
          SELECT oa."employeeId"
          FROM order_assignments oa
          WHERE oa."orderId" = o.id
          ORDER BY oa."assignedAt" DESC
          LIMIT 1
        )
      `, { assignedUserId: filters.assignedUserId });
    }

    statusQb.select([
      `st.id AS "statusId"`,
      `st.name AS "name"`,
      `st.system AS "system"`,
      `st.code AS "code"`,
      `COUNT(DISTINCT o.id) AS "count"`
    ])
    .groupBy('st.id, st.name, st.system, st.code');

    const [currentStats, comparisonStats, statusBreakdown] = await Promise.all([
      fetchData(startDate, endDate),
      prevRange.start && prevRange.end ? fetchData(prevRange.start, prevRange.end) : Promise.resolve(null),
      statusQb.getRawMany(),
    ]);

    return {
      ...currentStats,
      statusBreakdown,
      comparison: comparisonStats,
    };
  }

  async getWeeklyTrend(user: any, filters: any) {
    const adminId = tenantId(user);
    if (!adminId) throw new BadRequestException("Missing adminId");

    // Calculate exact timeframe: Last 7 days including today
    const endDate = new Date();
    endDate.setHours(23, 59, 59, 999);

    const startDate = subDays(new Date(), 6);
    startDate.setHours(0, 0, 0, 0);

    const qb = this.orderRepo.createQueryBuilder("o")
      .leftJoin("o.status", "st")
      .where("o.adminId = :adminId", { adminId })
      .andWhere("TO_CHAR(o.created_at, 'YYYY-MM-DD') >= :startDate", { startDate })
      .andWhere("TO_CHAR(o.created_at, 'YYYY-MM-DD') <= :endDate", { endDate });

    // Apply exact same filters as advanced-stats
    if (filters.storeId) qb.andWhere("o.storeId = :storeId", { storeId: filters.storeId });
    if (filters.cityId) qb.andWhere("o.cityId = :cityId", { cityId: filters.cityId });
    if (filters.shippingCompanyId) {
      qb.andWhere("o.shippingCompanyId = :shippingCompanyId", { shippingCompanyId: filters.shippingCompanyId });
    }

    if (filters.productIds && filters.productIds.length > 0) {
      const pIds = Array.isArray(filters.productIds) ? filters.productIds : filters.productIds.split(',');
      qb.andWhere(`EXISTS (
        SELECT 1 FROM order_items oi
        INNER JOIN product_variants pv ON oi."variantId" = pv.id
        WHERE oi."orderId" = o.id AND pv."productId" IN (:...pIds)
      )`, { pIds });
    }

    if (filters.assignedUserId) {
      qb.andWhere(`
        :assignedUserId = (
          SELECT oa."employeeId"
          FROM order_assignments oa
          WHERE oa."orderId" = o.id
          ORDER BY oa."assignedAt" DESC
          LIMIT 1
        )
      `, { assignedUserId: filters.assignedUserId });
    }

    // Group by the date of creation
    // Replace the select and groupBy lines with this:
    qb.select(`TO_CHAR(o.created_at, 'YYYY-MM-DD')`, 'date')
      .addSelect(`COUNT(DISTINCT o.id)`, 'created')
      .addSelect(`COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.DELIVERED}' THEN o.id END)`, 'delivered')
      .groupBy(`TO_CHAR(o.created_at, 'YYYY-MM-DD')`);

    const rawResults = await qb.getRawMany();

    // Format output to guarantee all 7 days exist in the array (even if counts are 0)

    const results = [];

    for (let i = 6; i >= 0; i--) {
      const targetDate = subDays(new Date(), i);

      // Use date-fns format to safely get the local YYYY-MM-DD without UTC shifts
      const dateString = format(targetDate, 'yyyy-MM-dd');

      const dayOfWeek = targetDate.toLocaleDateString('en-US', { weekday: 'long' });

      // Now we just strictly match the string from Postgres
      const foundData = rawResults.find((row) => row.date === dateString);

      results.push({
        date: dateString,
        day_of_week: dayOfWeek,
        created: Number(foundData?.created || 0),
        delivered: Number(foundData?.delivered || 0)
      });
    }

    return results;
  }

  async getTopCitiesStats(user: any, filters: any) {
    const adminId = tenantId(user);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const { start, end } = DateFilterUtil.getBoundaries(filters.startDate, filters.endDate);
    const limit = filters.limit ? Number(filters.limit) : 5;

    const qb = this.orderRepo.createQueryBuilder("o")
      .leftJoin("o.status", "st")
      .leftJoin("o.cityDetails", "cityDetails") // Join using the requested relation
      .where("o.adminId = :adminId", { adminId })
      .andWhere("cityDetails.id IS NOT NULL");

    // Apply Filters
    if (filters.storeId) qb.andWhere("o.storeId = :storeId", { storeId: filters.storeId });
    if (filters.shippingCompanyId) {
      qb.andWhere("o.shippingCompanyId = :shippingCompanyId", { shippingCompanyId: filters.shippingCompanyId });
    }
    if (start) qb.andWhere("o.created_at >= :start", { start });
    if (end) qb.andWhere("o.created_at <= :end", { end });

    if (filters.productIds && filters.productIds.length > 0) {
      const pIds = Array.isArray(filters.productIds) ? filters.productIds : filters.productIds.split(',');
      qb.andWhere(`EXISTS (
        SELECT 1 FROM order_items oi
        INNER JOIN product_variants pv ON oi."variantId" = pv.id
        WHERE oi."orderId" = o.id AND pv."productId" IN (:...pIds)
      )`, { pIds });
    }

    if (filters.assignedUserId) {
      qb.andWhere(`
        :assignedUserId = (
          SELECT oa."employeeId"
          FROM order_assignments oa
          WHERE oa."orderId" = o.id
          ORDER BY oa."assignedAt" DESC
          LIMIT 1
        )
      `, { assignedUserId: filters.assignedUserId });
    }

    // Selects and Aggregations grouped by City Entity Details
    qb.select('cityDetails.id', 'id')
      .addSelect('cityDetails.nameEn', 'nameEn')
      .addSelect('cityDetails.nameAr', 'nameAr')
      .addSelect(`COUNT(DISTINCT o.id)`, 'totalOrders')
      .addSelect(`COUNT(DISTINCT CASE WHEN st.code NOT IN ('${OrderStatus.DUPLICATE}', '${OrderStatus.OUT_OF_DELIVERY_AREA}', '${OrderStatus.WRONG_NUMBER}') THEN o.id END)`, 'correctedOrders')
      .addSelect(`COUNT(DISTINCT CASE WHEN o."isConfirmed" = true THEN o.id END)`, 'confirmedCount')
      .addSelect(`COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.SHIPPED}' THEN o.id END)`, 'shippedOrders')
      .addSelect(`COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.DELIVERED}' THEN o.id END)`, 'deliveredTotal')
      .addSelect(`COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.DELIVERED}' AND o."isConfirmed" = true THEN o.id END)`, 'deliveredFromConfirmed')
      .groupBy('cityDetails.id')
      .addGroupBy('cityDetails.nameEn')
      .addGroupBy('cityDetails.nameAr')
      .orderBy('"deliveredTotal"', 'DESC')
      .addOrderBy('"totalOrders"', 'DESC')
      .limit(limit);

    const rawResults = await qb.getRawMany();

    // Map results while safely handling case flattening variations across DB drivers
    return rawResults.map(row => ({
      id: row.id,
      nameEn: row.nameEn || row.nameen,
      nameAr: row.nameAr || row.namear,
      totalOrders: Number(row.totalOrders || row.totalorders || 0),
      correctedOrders: Number(row.correctedOrders || row.correctedorders || 0),
      confirmedCount: Number(row.confirmedCount || row.confirmedcount || 0),
      shippedOrders: Number(row.shippedOrders || row.shippedorders || 0),
      deliveredTotal: Number(row.deliveredTotal || row.deliveredtotal || 0),
      deliveredFromConfirmed: Number(row.deliveredFromConfirmed || row.deliveredfromconfirmed || 0),
    }));
  }

  async getTopProductsStats(user: any, filters: any) {
    const adminId = tenantId(user);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const { start, end } = DateFilterUtil.getBoundaries(filters.startDate, filters.endDate);
    const limit = filters.limit ? Number(filters.limit) : 5;

    // Use OrderItems as the base to join products properly, then join back to Order
    const qb = this.orderRepo.createQueryBuilder("o")
      .innerJoin("o.items", "oi")
      .innerJoin("oi.variant", "pv")
      .innerJoin("pv.product", "p")
      .leftJoin("o.status", "st")
      .where("o.adminId = :adminId", { adminId });

    // Apply Filters
    if (filters.storeId) qb.andWhere("o.storeId = :storeId", { storeId: filters.storeId });
    if (filters.cityId) qb.andWhere("o.cityId = :cityId", { cityId: filters.cityId });
    if (filters.shippingCompanyId) {
      qb.andWhere("o.shippingCompanyId = :shippingCompanyId", { shippingCompanyId: filters.shippingCompanyId });
    }
    if (start) qb.andWhere("o.created_at >= :start", { start });
    if (end) qb.andWhere("o.created_at <= :end", { end });

    if (filters.assignedUserId) {
      qb.andWhere(`
        :assignedUserId = (
          SELECT oa."employeeId"
          FROM order_assignments oa
          WHERE oa."orderId" = o.id
          ORDER BY oa."assignedAt" DESC
          LIMIT 1
        )
      `, { assignedUserId: filters.assignedUserId });
    }

    // Selects and Aggregations grouped by Product
    qb.select('p.id', 'id')
      .addSelect('p.name', 'name')
      .addSelect('p.mainImage', 'image')
      .addSelect(`COUNT(DISTINCT o.id)`, 'totalOrders') // Distinct ensures 1 order = 1 count even if multiple items
      .addSelect(`COUNT(DISTINCT CASE WHEN st.code NOT IN ('${OrderStatus.DUPLICATE}', '${OrderStatus.OUT_OF_DELIVERY_AREA}', '${OrderStatus.WRONG_NUMBER}') THEN o.id END)`, 'correctedOrders')
      .addSelect(`COUNT(DISTINCT CASE WHEN o."isConfirmed" = true THEN o.id END)`, 'confirmedCount')
      .addSelect(`COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.SHIPPED}' THEN o.id END)`, 'shippedOrders')
      .addSelect(`COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.DELIVERED}' THEN o.id END)`, 'deliveredTotal')
      .addSelect(`COUNT(DISTINCT CASE WHEN st.code = '${OrderStatus.DELIVERED}' AND o."isConfirmed" = true THEN o.id END)`, 'deliveredFromConfirmed')
      .groupBy('p.id')
      .addGroupBy('p.name')
      .addGroupBy('p.mainImage')
      .orderBy('"deliveredTotal"', 'DESC')
      .addOrderBy('"totalOrders"', 'DESC')
      .limit(limit);

    const rawResults = await qb.getRawMany();

    // Map results safely handling PostgreSQL lowercase aliases
    return rawResults.map(row => ({
      id: row.id,
      name: row.name,
      image: row.image,
      totalOrders: Number(row.totalOrders || row.totalorders || 0),
      correctedOrders: Number(row.correctedOrders || row.correctedorders || 0),
      confirmedCount: Number(row.confirmedCount || row.confirmedcount || 0),
      shippedOrders: Number(row.shippedOrders || row.shippedorders || 0),
      deliveredTotal: Number(row.deliveredTotal || row.deliveredtotal || 0),
      deliveredFromConfirmed: Number(row.deliveredFromConfirmed || row.deliveredfromconfirmed || 0),
    }));
  }
}
