import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Brackets, DataSource, EntityManager, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import { MonthlyClosingEntity } from 'entities/accounting.entity';
import { OrderEntity, OrderItemEntity, OrderStatus, OrderStatusEntity, ReturnRequestEntity, ReturnRequestItemEntity, ReturnRequestStatus } from 'entities/order.entity';
import { ManualExpenseEntity } from 'entities/accounting.entity';
import { PurchaseInvoiceEntity } from 'entities/purchase.entity';
import { PurchaseReturnInvoiceEntity } from 'entities/purchase_return.entity';
import { SupplierEntity } from 'entities/supplier.entity';
import { ApprovalStatus } from 'common/enums';
import { tenantId } from 'src/category/category.service';
import * as ExcelJS from 'exceljs';
import { TranslationService } from 'common/translation.service';
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
    @InjectRepository(OrderItemEntity)
    private orderItemsRepo: Repository<OrderItemEntity>,
    @InjectRepository(ManualExpenseEntity)
    private manualExpenseRepo: Repository<ManualExpenseEntity>,
    @InjectRepository(PurchaseInvoiceEntity)
    private purchaseRepo: Repository<PurchaseInvoiceEntity>,
    @InjectRepository(PurchaseReturnInvoiceEntity)
    private purchaseReturnRepo: Repository<PurchaseReturnInvoiceEntity>,
    private translations: TranslationService,
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
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

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
    const worksheet = workbook.addWorksheet(this.translations.t('domains.closings.report_title_monthly_profit'));

    // 4. Define Columns
    worksheet.columns = [
      { header: this.translations.t('domains.closings.excel_period'), key: "period", width: 15 },
      { header: this.translations.t('domains.closings.excel_total_revenue'), key: "revenue", width: 18 },
      { header: this.translations.t('domains.closings.excel_product_cost'), key: "productCost", width: 18 },
      { header: this.translations.t('domains.closings.excel_operational_expenses'), key: "operationalExpenses", width: 22 },
      { header: this.translations.t('domains.closings.excel_returns_cost'), key: "returnsCost", width: 18 },
      { header: this.translations.t('domains.closings.excel_net_profit'), key: "netProfit", width: 18 },
      { header: this.translations.t('domains.closings.excel_closing_date'), key: "closingDate", width: 15 },
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

  async getClosing(me: any, id: string) {
    const adminId = tenantId(me);
    const rec = await this.monthlyRepo.findOne({ where: { id, adminId } });
    if (!rec) throw new BadRequestException(this.translations.t('domains.closings.closing_not_found'));
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
      throw new BadRequestException(this.translations.t('domains.closings.invalid_year_month'));
    }

    const { start, end } = getMonthRange(year, month);

    const now = new Date();
    if (end > now) {
      throw new BadRequestException(this.translations.t('domains.closings.cannot_close_future'));
    }

    const existing = await this.monthlyRepo.findOne({
      where: { adminId, year, month }
    });

    if (existing) {
      throw new BadRequestException(this.translations.t('domains.closings.month_already_closed'));
    }

    return await this.dataSource.transaction(async (manager) => {

      const preview = await this.getMonthPreview(me, { year, month }, manager);

      const closing = manager.getRepository(MonthlyClosingEntity).create({
        adminId,
        year,
        month,
        periodStart: new Date(start),
        periodEnd: new Date(end),
        revenue: preview.revenue,
        productCost: preview.cogs,
        operationalExpenses: preview.operationalExpenses,
        returnsCost: preview.returnsCost,
        grossProfit: preview.grossProfit,
        netProfit: preview.netProfit,
        createdByUserId: me?.id,
      });

      const savedClosing = await manager.getRepository(MonthlyClosingEntity).save(closing);

      await Promise.all([
        manager.getRepository(OrderEntity)
          .createQueryBuilder()
          .update()
          .set({ monthlyClosingId: savedClosing.id })
          .where('adminId = :adminId', { adminId })
          .andWhere('monthlyClosingId IS NULL')
          .andWhere('deliveredAt BETWEEN :start AND :end', { start, end })
          .execute(),

        manager.getRepository(ManualExpenseEntity)
          .createQueryBuilder()
          .update()
          .set({ monthlyClosingId: savedClosing.id })
          .where('adminId = :adminId', { adminId })
          .andWhere('monthlyClosingId IS NULL')
          .andWhere('collectionDate BETWEEN :start AND :end', { start, end })
          .execute(),

        manager.getRepository(ReturnRequestEntity)
          .createQueryBuilder()
          .update()
          .set({ monthlyClosingId: savedClosing.id })
          .where('adminId = :adminId', { adminId })
          .andWhere('status = :status', {
            status: ReturnRequestStatus.APPROVED,
          })
          .andWhere('monthlyClosingId IS NULL')
          .andWhere('createdAt BETWEEN :start AND :end', { start, end })
          .andWhere(`
    "orderId" IN (
      SELECT o.id
      FROM orders o
      WHERE o."deliveredAt" IS NOT NULL
    )
  `)
          .execute(),
      ]);

      return savedClosing;
    });
  }

  async getMonthPreview(
    me: any,
    { year, month }: { year: number; month: number },
    manager?: EntityManager
  ) {
    const adminId = tenantId(me);
    const { start, end } = getMonthRange(year, month);

    const ordersRepo = manager ? manager.getRepository(OrderEntity) : this.ordersRepo;
    const orderItemsRepo = manager ? manager.getRepository(OrderItemEntity) : this.orderItemsRepo;
    const manualExpenseRepo = manager ? manager.getRepository(ManualExpenseEntity) : this.manualExpenseRepo;
    const monthlyRepo = manager ? manager.getRepository(MonthlyClosingEntity) : this.monthlyRepo;

    const deliveredStatus = await this.orderStatusRepo.findOne({
      where: { code: OrderStatus.DELIVERED },
    });

    if (!deliveredStatus) {
      throw new BadRequestException(this.translations.t('domains.closings.delivered_status_not_found'));
    }

    const existingClosing = await monthlyRepo.findOne({
      where: { adminId, year, month }
    });

    if (existingClosing) {
      return {
        isClosed: true,
        year,
        month,
        revenue: Number(existingClosing.revenue),
        cogs: Number(existingClosing.productCost),
        operationalExpenses: Number(existingClosing.operationalExpenses),
        returnsCost: Number(existingClosing.returnsCost),
        grossProfit: Number(existingClosing.grossProfit),
        netProfit: Number(existingClosing.netProfit),
        period: {
          start: existingClosing.periodStart,
          end: existingClosing.periodEnd
        }
      };
    }

    const [
      revenueRow,
      cogsRow,
      operationalRow,
      ReturnsRow,
    ] = await Promise.all([
      ordersRepo.createQueryBuilder('o')
        .select('COALESCE(SUM(o.finalTotal - COALESCE(o.shippingCost, 0)), 0)', 'sum')
        .where('o.adminId = :adminId', { adminId })
        .andWhere('o.monthlyClosingId IS NULL')
        .andWhere('o.deliveredAt BETWEEN :start AND :end', { start, end })
        .getRawOne(),

      orderItemsRepo.createQueryBuilder('oi')
        .innerJoin('oi.order', 'o')
        .select('COALESCE(SUM(oi.unitCost * oi.quantity), 0)', 'sum')
        .where('o.adminId = :adminId', { adminId })
        .andWhere('o.monthlyClosingId IS NULL')
        .andWhere('o.deliveredAt BETWEEN :start AND :end', { start, end })
        .getRawOne(),

      manualExpenseRepo.createQueryBuilder('e')
        .select('COALESCE(SUM(e.amount), 0)', 'sum')
        .where('e.adminId = :adminId', { adminId })
        .andWhere('e.monthlyClosingId IS NULL')
        .andWhere('e.collectionDate BETWEEN :start AND :end', { start, end })
        .getRawOne(),

      this.dataSource.getRepository(ReturnRequestItemEntity).createQueryBuilder('ri')
        .innerJoin('ri.returnRequest', 'rr')
        .innerJoin('ri.originalItem', 'oi')
        .innerJoin('oi.order', 'o')
        .select('COALESCE(SUM(oi.unitCost * ri.quantity), 0)', 'sum')
        .where('rr.adminId = :adminId', { adminId })
        .andWhere('rr.status = :status', { status: ReturnRequestStatus.APPROVED })
        .andWhere('o."deliveredAt" IS NOT NULL')
        .andWhere('rr.monthlyClosingId IS NULL')
        .andWhere('rr.createdAt BETWEEN :start AND :end', { start, end })
        .getRawOne(),
    ]);

    const revenue = Number(revenueRow?.sum || 0);
    const cogs = Number(cogsRow?.sum || 0);
    const operationalExpenses = Number(operationalRow?.sum || 0);
    const returnsCost = Number(ReturnsRow?.sum || 0);

    const finalCOGS = cogs + returnsCost;
    const grossProfit = revenue - finalCOGS;
    const netProfit = grossProfit - operationalExpenses;

    return {
      isClosed: !!existingClosing,
      year,
      month,
      revenue,
      cogs: finalCOGS,
      operationalExpenses,
      returnsCost,
      grossProfit,
      netProfit,
      period: { start, end }
    };
  }

  async exportDetailedClosing(me: any, q: { year: number; month: number }) {
    const adminId = tenantId(me);
    const year = Number(q.year);
    const month = Number(q.month);
    const { start, end } = getMonthRange(year, month);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const preview = await this.getMonthPreview(me, { year, month });

    const existingClosing = await this.monthlyRepo.findOne({ where: { adminId, year, month } });
    const closingId = existingClosing?.id;

    const [revenueOrders, expenses, returnOrders] = await Promise.all([
      this.ordersRepo.createQueryBuilder('o')
        .leftJoinAndSelect('o.admin', 'admin')
        .select([
          'o.id', 'o."orderNumber"', 'o."customerName"', 'o."finalTotal"', 'o."shippingCost"',
          'o."deliveredAt"'
        ])
        .addSelect('(SELECT SUM(oi."unitCost" * oi.quantity) FROM order_items oi WHERE oi."orderId" = o.id)', 'itemsCost')
        .addSelect('(SELECT SUM(oi.quantity) FROM order_items oi WHERE oi."orderId" = o.id)', 'itemCount')
        .where('o."adminId" = :adminId', { adminId })
        .andWhere(closingId ? 'o."monthlyClosingId" = :closingId' : 'o."monthlyClosingId" IS NULL', { closingId })
        .andWhere('o."deliveredAt" BETWEEN :start AND :end', { start, end })
        .getRawMany(),

      this.manualExpenseRepo.createQueryBuilder('e')
        .leftJoinAndSelect('e.category', 'cat')
        .where('e."adminId" = :adminId', { adminId })
        .andWhere(closingId ? 'e."monthlyClosingId" = :closingId' : 'e."monthlyClosingId" IS NULL', { closingId })
        .andWhere('e."collectionDate" BETWEEN :start AND :end', { start, end })
        .getMany(),

      this.dataSource.getRepository(ReturnRequestItemEntity).createQueryBuilder('ri')
        .innerJoinAndSelect('ri.returnRequest', 'rr')
        .innerJoinAndSelect('rr.order', 'o')
        .innerJoinAndSelect('ri.originalItem', 'oi')
        .leftJoinAndSelect('oi.variant', 'v')
        .leftJoinAndSelect('v.product', 'p')
        .where('rr.adminId = :adminId', { adminId })
        .andWhere('rr.status = :status', { status: ReturnRequestStatus.APPROVED})
        .andWhere('o."deliveredAt" IS NOT NULL')
        .andWhere(closingId ? 'rr.monthlyClosingId = :closingId' : 'rr.monthlyClosingId IS NULL', { closingId })
        .andWhere('rr.createdAt BETWEEN :start AND :end', { start, end })
        .getMany(),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Madar";
    workbook.created = new Date();

    // --- SHEET 1: Summary ---
    const summarySheet = workbook.addWorksheet(this.translations.t('domains.closings.excel_sheet_summary'), {
      views: [{ state: 'frozen', ySplit: 2 }]
    });

    summarySheet.columns = [
      { header: this.translations.t('domains.closings.excel_metric'), key: 'metric', width: 30 },
      { header: this.translations.t('domains.closings.excel_value'), key: 'value', width: 25 },
    ];

    summarySheet.addRows([
      { metric: this.translations.t('common.status'), value: preview.isClosed ? this.translations.t('domains.closings.status_closed') : this.translations.t('domains.closings.status_pending') },
      { metric: this.translations.t('domains.closings.excel_total_revenue'), value: preview.revenue },
      { metric: this.translations.t('domains.closings.product_cost_cogs'), value: preview.cogs },
      { metric: this.translations.t('domains.closings.excel_operational_expenses'), value: preview.operationalExpenses },
      { metric: this.translations.t('domains.closings.excel_returns_cost'), value: preview.returnsCost },
      { metric: this.translations.t('domains.closings.excel_net_profit'), value: preview.netProfit },
    ]);

    // --- SHEET 2: Revenue Orders ---
    const revSheet = workbook.addWorksheet(this.translations.t('domains.closings.excel_sheet_revenue_orders'), {
      views: [{ state: 'frozen', ySplit: 2 }]
    });
    const revColumns = [
      { header: this.translations.t('domains.closings.excel_order_number'), key: 'orderNumber', width: 18 },
      { header: this.translations.t('domains.closings.excel_customer'), key: 'customerName', width: 25 },
      { header: this.translations.t('domains.closings.excel_revenue_net'), key: 'revenue', width: 18 },
      { header: this.translations.t('domains.closings.excel_items_count'), key: 'itemCount', width: 12 },
      { header: this.translations.t('domains.closings.excel_items_cost'), key: 'itemsCost', width: 15 },
      { header: this.translations.t('domains.closings.excel_delivered_at'), key: 'deliveredAt', width: 22 },
      { header: this.translations.t('domains.closings.excel_system_link'), key: 'link', width: 20 },
    ];
    revSheet.columns = revColumns;

    revenueOrders.forEach(o => {
      const row = revSheet.addRow({
        orderNumber: o.orderNumber,
        customerName: o.customerName,
        revenue: Number(o.finalTotal) - Number(o.shippingCost || 0),
        itemCount: Number(o.itemCount || 0),
        itemsCost: Number(o.itemsCost || 0),
        deliveredAt: o.deliveredAt ? new Date(o.deliveredAt).toLocaleString() : '-',
      });
      row.getCell('link').value = {
        text: this.translations.t('domains.closings.excel_view_order'),
        hyperlink: `${frontendUrl}/orders/details/${o.o_id}`,
        tooltip: `${frontendUrl}/orders/details/${o.o_id}`,
      };
      row.getCell('link').font = { color: { argb: 'FF3b82f6' }, underline: true };
    });

    if (revenueOrders.length > 0) {
      const revTotalRow = revSheet.addRow({
        orderNumber: this.translations.t('common.totals'),
        revenue: { formula: `SUM(C2:C${revenueOrders.length + 1})` },
        itemsCost: { formula: `SUM(E2:E${revenueOrders.length + 1})` },
      });
      revTotalRow.font = { bold: true };
      revTotalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
    }

    // --- SHEET 3: Operational Expenses ---
    const expSheet = workbook.addWorksheet(this.translations.t('domains.closings.excel_sheet_expenses'), {
      views: [{ state: 'frozen', ySplit: 2 }]
    });
    const expColumns = [
      { header: this.translations.t('common.date'), key: 'date', width: 18 },
      { header: this.translations.t('common.category'), key: 'category', width: 22 },
      { header: this.translations.t('common.description'), key: 'description', width: 45 },
      { header: this.translations.t('common.amount'), key: 'amount', width: 18 },
    ];
    expSheet.columns = expColumns;

    expenses.forEach(e => {
      expSheet.addRow({
        date: new Date(e.collectionDate).toLocaleDateString(),
        category: e.category?.name || '-',
        description: e.description,
        amount: Number(e.amount),
      });
    });

    if (expenses.length > 0) {
      const expTotalRow = expSheet.addRow({
        description: this.translations.t('common.total'),
        amount: { formula: `SUM(D2:D${expenses.length + 1})` },
      });
      expTotalRow.font = { bold: true };
      expTotalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
    }

    // --- SHEET 4: Returns ---
    const retSheet = workbook.addWorksheet(this.translations.t('domains.closings.excel_sheet_returns'), {
      views: [{ state: 'frozen', ySplit: 2 }]
    });
    const retColumns = [
      { header: this.translations.t('domains.closings.excel_order_number'), key: 'orderNumber', width: 18 },
      { header: this.translations.t('domains.closings.excel_customer'), key: 'customerName', width: 25 },
      { header: this.translations.t('domains.closings.excel_delivered_at'), key: 'deliveredAt', width: 22 },
      { header: this.translations.t('domains.closings.excel_returned_at'), key: 'returnedAt', width: 22 },
      { header: this.translations.t('domains.closings.excel_return_cost'), key: 'itemsCost', width: 18 },
      { header: this.translations.t('domains.closings.excel_system_link'), key: 'link', width: 20 },
    ];
    retSheet.columns = retColumns;

    returnOrders.forEach(item => {
      const row = retSheet.addRow({
        orderNumber: item.returnRequest?.order?.orderNumber || '',
        customerName: item.returnRequest?.order?.customerName || '',
        deliveredAt: item.returnRequest?.order?.deliveredAt ? new Date(item.returnRequest.order.deliveredAt).toLocaleString() : '-',
        returnedAt: item.returnRequest?.createdAt ? new Date(item.returnRequest.createdAt).toLocaleString() : '-',
        itemsCost: Number(item.originalItem?.unitCost || 0) * item.quantity,
      });
      row.getCell('link').value = {
        text: this.translations.t('domains.closings.excel_view_order'),
        hyperlink: `${frontendUrl}/orders/details/${item.returnRequest?.order?.id}`,
        tooltip: `${frontendUrl}/orders/details/${item.returnRequest?.order?.id}`,
      };
      row.getCell('link').font = { color: { argb: 'FF3b82f6' }, underline: true };
    });

    if (returnOrders.length > 0) {
      const retTotalRow = retSheet.addRow({
        orderNumber: this.translations.t('common.total'),
        itemsCost: { formula: `SUM(E2:E${returnOrders.length + 1})` },
      });
      retTotalRow.font = { bold: true };
      retTotalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
    }

    workbook.views = [{
      x: 0, y: 0, width: 10000, height: 20000,
      firstSheet: 0, activeTab: 0, visibility: 'visible'
    }];

    return await workbook.xlsx.writeBuffer();
  }

  private applyNoteRow(sheet: ExcelJS.Worksheet, note: string, colCount: number) {
    const noteRow = sheet.getRow(1);
    noteRow.values = [note];
    sheet.mergeCells(1, 1, 1, colCount);
    noteRow.font = { italic: true, color: { argb: 'FF6B7280' }, size: 10 };
    noteRow.height = 25;
    noteRow.alignment = { vertical: 'middle', horizontal: 'center' };
  }

  private applyHeaderStyle(sheet: ExcelJS.Worksheet, rowNum: number) {
    const headerRow = sheet.getRow(rowNum);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF3b82f6' }
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 30;
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

    const totalCosts =
      (currentPreview.cogs ?? 0) +
      (currentPreview.operationalExpenses ?? 0);

    return {
      lastMonthProfit: {
        year: lastClosing?.year ?? null,
        month: lastClosing?.month ?? null,
        netProfit: lastClosing?.netProfit ?? 0
      },

      currentMonthStats: {
        revenue: currentPreview.revenue ?? 0,
        totalCosts,
        netProfit: currentPreview.netProfit ?? 0,
        productCost: currentPreview.cogs ?? 0,
        operationalExpenses: currentPreview.operationalExpenses ?? 0,
        returnsCost: currentPreview.returnsCost ?? 0
      }
    };
  }
}

