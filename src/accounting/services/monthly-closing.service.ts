import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Brackets, DataSource, EntityManager, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import { MonthlyClosingEntity } from 'entities/accounting.entity';
import { OrderEntity, OrderStatus, OrderStatusEntity } from 'entities/order.entity';
import { ManualExpenseEntity } from 'entities/accounting.entity';
import { PurchaseInvoiceEntity } from 'entities/purchase.entity';
import { PurchaseReturnInvoiceEntity } from 'entities/purchase_return.entity';
import { SupplierEntity } from 'entities/supplier.entity';
import { ApprovalStatus } from 'common/enums';
import { tenantId } from 'src/category/category.service';
import * as ExcelJS from 'exceljs';
function getMonthRange(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59));
  return { start, end };
}

@Injectable()
export class MonthlyClosingService {
  constructor(
    private dataSource: DataSource,
    @InjectRepository(MonthlyClosingEntity)
    private monthlyRepo: Repository<MonthlyClosingEntity>,
    @InjectRepository(OrderStatusEntity)
    private orderStatusRepo: Repository<OrderStatusEntity>,
    @InjectRepository(SupplierEntity)
    private supplierRepo: Repository<SupplierEntity>,
    @InjectRepository(OrderEntity)
    private ordersRepo: Repository<OrderEntity>,
    @InjectRepository(ManualExpenseEntity)
    private manualExpenseRepo: Repository<ManualExpenseEntity>,
    @InjectRepository(PurchaseInvoiceEntity)
    private purchaseRepo: Repository<PurchaseInvoiceEntity>,
    @InjectRepository(PurchaseReturnInvoiceEntity)
    private purchaseReturnRepo: Repository<PurchaseReturnInvoiceEntity>,
  ) { }

  async listClosings(me: any, q?: any) {
    const adminId = tenantId(me);
    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);

    const qb = this.monthlyRepo.createQueryBuilder("closing")
      .where("closing.adminId = :adminId", { adminId });

    // 1. Year Filter
    if (q?.year) {
      qb.andWhere("closing.year = :year", { year: Number(q.year) });
    }

    // 2. Month Filter
    if (q?.month) {
      qb.andWhere("closing.month = :month", { month: Number(q.month) });
    }

    // 3. Search Filter (Search by Status or specific Year/Month as string)
    if (q?.search) {
      const searchTerm = `%${q.search}%`;
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("CAST(closing.netProfit AS TEXT) LIKE :s", { s: searchTerm })
            .orWhere("CAST(closing.revenue AS TEXT) LIKE :s", { s: searchTerm })
        }),
      );
    }
    // Sorting
    const allowedSortFields = ['year', 'month', 'netProfit', 'createdAt'];
    const sortBy = allowedSortFields.includes(q?.sortBy) ? q.sortBy : 'year';
    const sortOrder = q?.sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Apply Order & Pagination
    // We order by year THEN month for a logical chronological list
    qb.orderBy(`closing.${sortBy}`, sortOrder)
      .addOrderBy('closing.month', 'DESC')
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

  async exportClosings(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    // 1. Build the Query
    const qb = this.monthlyRepo.createQueryBuilder("closing")
      .where("closing.adminId = :adminId", { adminId });

    // Apply filters (Year, Month, Search)
    if (q?.year) {
      qb.andWhere("closing.year = :year", { year: Number(q.year) });
    }

    if (q?.month) {
      qb.andWhere("closing.month = :month", { month: Number(q.month) });
    }

    if (q?.search) {
      const searchTerm = `%${q.search}%`;
      qb.andWhere(
        new Brackets((sq) => {
          sq.where("CAST(closing.netProfit AS TEXT) LIKE :s", { s: searchTerm })
            .orWhere("CAST(closing.revenue AS TEXT) LIKE :s", { s: searchTerm });
        }),
      );
    }

    // Sort chronologically
    qb.orderBy('closing.year', 'DESC').addOrderBy('closing.month', 'DESC');

    const records = await qb.getMany();

    // 2. Prepare Excel data
    const exportData = records.map(r => ({
      period: `${r.month} / ${r.year}`,
      revenue: Number(r.revenue),
      productCost: Number(r.productCost),
      operationalExpenses: Number(r.operationalExpenses),
      returnsCost: Number(r.returnsCost),
      netProfit: Number(r.netProfit),
      closingDate: new Date(r.createdAt).toLocaleDateString('en-GB'),
    }));

    // 3. Create Workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Monthly Profit Report");

    // 4. Define Columns
    worksheet.columns = [
      { header: "Period (M/Y)", key: "period", width: 15 },
      { header: "Total Revenue", key: "revenue", width: 18 },
      { header: "Product Cost", key: "productCost", width: 18 },
      { header: "Operational Expenses", key: "operationalExpenses", width: 22 },
      { header: "Returns Cost", key: "returnsCost", width: 18 },
      { header: "Net Profit", key: "netProfit", width: 18 },
      { header: "Closing Date", key: "closingDate", width: 15 },
    ];

    // Style header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };

    // 5. Add Rows
    exportData.forEach((row) => {
      worksheet.addRow(row);
    });

    // 6. Return Buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }

  async getClosing(me: any, id: number) {
    const adminId = tenantId(me);
    const rec = await this.monthlyRepo.findOne({ where: { id, adminId } });
    if (!rec) throw new BadRequestException('Closing not found');
    return rec;
  }

  async closeMonth(
    me: any,
    payload: { year: number; month: number }
  ) {
    const adminId = tenantId(me);
    const year = Number(payload.year);
    const month = Number(payload.month);
    if (!year || !month || month < 1 || month > 12) {
      throw new BadRequestException('Invalid year/month');
    }
    const { start, end } = getMonthRange(year, month);
    //chack that closed month is not in future or this month is not end yet
    const now = new Date();
    if (end > now) {
      throw new BadRequestException('Cannot close a month that has not ended yet.');
    }

    // Check duplicate closing
    const existing = await this.monthlyRepo.findOne({ where: { adminId, year, month } });
    if (existing) {
      throw new BadRequestException('This month is already closed');
    }

    // Validation: Ensure suppliers are closed up to the end date
    // const suppliersNeedingClosure = await this.supplierRepo.createQueryBuilder('s')
    //   .where('s.adminId = :adminId', { adminId })
    //   .andWhere('(s.lastClosingEndDate IS NULL OR s.lastClosingEndDate < :end)', { end })
    //   .getCount();
    // if (suppliersNeedingClosure > 0) {
    //   throw new BadRequestException('Cannot close month while some supplier closing periods are not completed up to period end.');
    // }

    // Fetch delivered status id (from system statuses) by code = 'delivered'
    const deliveredStatus = await this.orderStatusRepo.findOne({
      where: [{ code: OrderStatus.DELIVERED }],
    });
    const [unclosedPurchases, unclosedReturns] = await Promise.all([
      this.purchaseRepo.createQueryBuilder('p')
        .select('p.receiptNumber', 'num')
        .where('p.adminId = :adminId', { adminId })
        .andWhere('p.statusUpdateDate <= :end', { end })
        .andWhere('p.closingId IS NULL')
        .limit(5)
        .getRawMany(),

      this.purchaseReturnRepo.createQueryBuilder('r')
        .select('r.returnNumber', 'num')
        .where('r.adminId = :adminId', { adminId })
        .andWhere('r.statusUpdateDate <= :end', { end })
        .andWhere('r.closingId IS NULL')
        .limit(5)
        .getRawMany()
    ]);
    if (unclosedPurchases.length > 0) {
      throw new BadRequestException(`Cannot close month while some purchases are not closed yet: ${unclosedPurchases.map(p => p.num).join(', ')}`);
    }
    if (unclosedReturns.length > 0) {
      throw new BadRequestException(`Cannot close month while some returns are not closed yet: ${unclosedReturns.map(r => r.num).join(', ')}`);
    }
    return await this.dataSource.transaction(async (manager) => {
      // 1. Fetch all financial data in parallel
      const { revenue, productCost, operationalExpenses, returnsCost, grossProfit, operatingProfit, netProfit } = await this.getMonthPreview(me, { year, month }, manager);
      const closing = manager.getRepository(MonthlyClosingEntity).create({
        adminId,
        year,
        month,
        periodStart: new Date(start),
        periodEnd: new Date(end),
        revenue,
        productCost,
        operationalExpenses,
        returnsCost,
        grossProfit,
        operatingProfit,
        netProfit,
        createdByUserId: me?.id,
      });
      const savedClosing = await manager.getRepository(MonthlyClosingEntity).save(closing);

      // 2. Link all transactions to this closing in parallel
      await Promise.all([
        manager.getRepository(OrderEntity).update(
          {
            adminId,
            statusId: deliveredStatus?.id,
            deliveredAt: LessThanOrEqual(end),
            monthlyClosingId: IsNull(),
          },
          { monthlyClosingId: savedClosing.id }
        ),

        manager.getRepository(ManualExpenseEntity).update(
          {
            adminId,
            collectionDate: LessThanOrEqual(end),
            monthlyClosingId: IsNull(),
          },
          { monthlyClosingId: savedClosing.id }
        ),

        manager.getRepository(PurchaseReturnInvoiceEntity).update(
          {
            adminId,
            statusUpdateDate: LessThanOrEqual(end),
            monthlyClosingId: IsNull(),
          },
          { monthlyClosingId: savedClosing.id }
        ),

        manager.getRepository(PurchaseInvoiceEntity).update(
          {
            adminId,
            statusUpdateDate: LessThanOrEqual(end),
            monthlyClosingId: IsNull(),
          },
          { monthlyClosingId: savedClosing.id }
        )
      ]);

      return savedClosing;
    });
  }

  async getMonthPreview(me: any, { year, month }: { year: number; month: number }, manager?: EntityManager) {
    const adminId = tenantId(me);
    const { start, end } = getMonthRange(year, month);
    const ordersRepo = manager ? manager.getRepository(OrderEntity) : this.ordersRepo;
    const manualExpenseRepo = manager ? manager.getRepository(ManualExpenseEntity) : this.manualExpenseRepo;
    const purchaseRepo = manager ? manager.getRepository(PurchaseInvoiceEntity) : this.purchaseRepo;
    const purchaseReturnRepo = manager ? manager.getRepository(PurchaseReturnInvoiceEntity) : this.purchaseReturnRepo;

    const deliveredStatus = await this.orderStatusRepo.findOne({
      where: [{ code: OrderStatus.DELIVERED }],
    });


    const [revenueRow, productCostRow, operationalRow, returnsRow, isClosedRow] = await Promise.all([
      // Revenue = sum of finalTotal of delivered orders in period
      ordersRepo.createQueryBuilder('o')
        // Exclude shippingCost from finalTotal because the client pay it
        .select('COALESCE(SUM(o.finalTotal - o.shippingCost), 0)', 'sum')
        .where('o.adminId = :adminId', { adminId })
        .andWhere('o.monthlyClosingId IS NULL')
        //Between start an end 
        .andWhere('o.deliveredAt BETWEEN :start AND :end', { start, end })
        .andWhere('o.statusId = :deliveredId', { deliveredId: deliveredStatus?.id ?? -1 })
        .getRawOne(),

      // Product cost = accepted purchases in period
      purchaseRepo.createQueryBuilder('p')
        .select('COALESCE(SUM(p.total), 0)', 'sum')
        .where('p.adminId = :adminId', { adminId })
        .andWhere('p.monthlyClosingId IS NULL')
        .andWhere('p.statusUpdateDate BETWEEN :start AND :end', { start, end })
        .andWhere('p.status = :status', { status: ApprovalStatus.ACCEPTED })
        .getRawOne(),

      // Operational expenses = manual expenses in period
      manualExpenseRepo.createQueryBuilder('e')
        .select('COALESCE(SUM(e.amount), 0)', 'sum')
        .where('e.adminId = :adminId', { adminId })
        .andWhere('e.monthlyClosingId IS NULL')
        .andWhere('e.collectionDate BETWEEN :start AND :end', { start, end })
        .getRawOne(),

      // Returns = accepted purchase returns in period
      purchaseReturnRepo.createQueryBuilder('r')
        .select('COALESCE(SUM(r.totalReturn), 0)', 'sum')
        .where('r.adminId = :adminId', { adminId })
        .andWhere('r.monthlyClosingId IS NULL')
        .andWhere('r.statusUpdateDate BETWEEN :start AND :end', { start, end })
        .andWhere('r.status = :status', { status: ApprovalStatus.ACCEPTED })
        .getRawOne(),

      // Is closed = any closing exists for this month
      this.monthlyRepo.createQueryBuilder('mc')
        .select('mc.id IS NOT NULL', 'isClosed')
        .where('mc.adminId = :adminId', { adminId })
        .andWhere('mc.year = :year', { year })
        .andWhere('mc.month = :month', { month })
        .getRawOne()
    ]);

    const revenue = Number(revenueRow?.sum || 0);
    const productCost = Number(productCostRow?.sum || 0);
    const operationalExpenses = Number(operationalRow?.sum || 0);
    const returnsCost = Number(returnsRow?.sum || 0);

    const grossProfit = revenue - productCost;
    const operatingProfit = grossProfit - operationalExpenses;
    const netProfit = operatingProfit - returnsCost;


    return {
      isClosed: isClosedRow?.isClosed || false,
      year,
      month,
      revenue,
      productCost,
      operationalExpenses,
      returnsCost,
      grossProfit,
      operatingProfit,
      netProfit,
      period: {
        start,
        end
      }

    };
  }

  async getMonthStats(me: any) {
    const adminId = tenantId(me);
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;


    const lastClosing = await this.monthlyRepo.findOne({
      where: { adminId },
      order: { year: 'DESC', month: 'DESC' }
    });


    const currentPreview = await this.getMonthPreview(me, {
      year: currentYear,
      month: currentMonth
    });

    const totalCosts = currentPreview.productCost + currentPreview.operationalExpenses;

    return {

      lastMonthProfit: {
        year: lastClosing?.year || null,
        month: lastClosing?.month || null,
        netProfit: Number(lastClosing?.netProfit || 0)
      },

      currentMonthStats: {
        revenue: currentPreview.revenue,
        totalCosts: totalCosts,
        netProfit: currentPreview.netProfit,
        productCost: currentPreview.productCost,
        operationalExpenses: currentPreview.operationalExpenses,
        returnsCost: currentPreview.returnsCost

      }
    };
  }
}

