// purchases-return/purchases-return.service.ts
import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, In, Repository } from "typeorm";
import { CRUD } from "common/crud.service";
import { PurchaseReturnInvoiceEntity, PurchaseReturnInvoiceItemEntity, PurchaseReturnAuditLogEntity, PurchaseReturnAuditAction } from "entities/purchase_return.entity";
import { CreatePurchaseReturnDto, UpdatePaidAmountDto, UpdatePurchaseReturnDto } from "dto/purchase_return.dto";
import { ApprovalStatus, PurchaseReturnType, ReturnStatus } from "common/enums";
import { tenantId } from "../category/category.service"; // or duplicate helper locally
import { ProductVariantEntity } from "entities/sku.entity";
import { SupplierEntity } from "entities/supplier.entity";
import { DateFilterUtil } from "common/date-filter.util";
import * as fs from "fs";
import * as path from "path";
import * as ExcelJS from "exceljs";

function calcLine(cost: number, qty: number, taxRate: number, taxInclusive: boolean) {
  const lineSubtotal = cost * qty;
  const lineTax = taxInclusive ? Math.round((lineSubtotal * taxRate) / 100) : 0;
  const lineTotal = lineSubtotal + lineTax;
  return { lineSubtotal, lineTax, lineTotal };
}

@Injectable()
export class PurchaseReturnsService {
  constructor(
    private dataSource: DataSource,
    @InjectRepository(PurchaseReturnInvoiceEntity) private invRepo: Repository<PurchaseReturnInvoiceEntity>,
    @InjectRepository(PurchaseReturnInvoiceItemEntity) private itemRepo: Repository<PurchaseReturnInvoiceItemEntity>,
    @InjectRepository(PurchaseReturnAuditLogEntity) private auditRepo: Repository<PurchaseReturnAuditLogEntity>,
    @InjectRepository(ProductVariantEntity) private pvRepo: Repository<ProductVariantEntity>,
    @InjectRepository(SupplierEntity) private supplierRepo: Repository<SupplierEntity>,
  ) { }

  private async log(params: {
    adminId: string;
    invoiceId: string;
    userId?: string | null;
    action: PurchaseReturnAuditAction | string;
    oldData?: any;
    newData?: any;
    changes?: any;
    description?: string;
    ipAddress?: string;
    manager?: EntityManager;
  }) {
    const row = this.auditRepo.create({
      adminId: params.adminId,
      invoiceId: params.invoiceId,
      userId: params.userId ?? null,
      action: params.action as any,
      oldData: params.oldData ?? null,
      newData: params.newData ?? null,
      changes: params.changes ?? null,
      description: params.description ?? null,
      ipAddress: params.ipAddress ?? null,
    });

    if (params.manager) {
      await params.manager.save(row);
    } else {
      await this.auditRepo.save(row);
    }
  }

  private async syncSupplierFinancials(params: {
    oldStatus?: ApprovalStatus;
    newStatus?: ApprovalStatus;
    oldSupplierId?: string | null;
    newSupplierId?: string | null;
    totalReturn: number;
    paidAmount: number;
    manager?: EntityManager;
  }) {
    const {
      oldStatus,
      newStatus,
      oldSupplierId,
      newSupplierId,
      totalReturn,
      paidAmount,
    } = params;

    const wasAccepted = oldStatus === ApprovalStatus.ACCEPTED;
    const isAccepted = newStatus === ApprovalStatus.ACCEPTED;
    const repo = params?.manager ? params?.manager.getRepository(SupplierEntity) : this.supplierRepo;

    // In returns, remaining = totalReturn - paidAmount
    const remaining = totalReturn - paidAmount;

    // Helper to update supplier safely
    const updateSupplier = async (
      supplierId: string | null | undefined,
      op: "add" | "subtract"
    ) => {
      if (!supplierId) return;

      const supplier = await repo.findOne({
        where: { id: supplierId },
      });

      if (!supplier) return;

      const currentPurchase = Number(supplier.purchaseValue || 0);
      const currentDue = Number(supplier.dueBalance || 0);

      // In returns: 
      // op "subtract" means the return is ACCEPTED (so it subtracts from supplier's balance)
      // op "add" means the return left ACCEPTED (so it adds back to supplier's balance)
      if (op === "subtract") {
        supplier.purchaseValue = currentPurchase - Number(totalReturn);
        supplier.dueBalance = currentDue - Number(remaining);
      } else {
        supplier.purchaseValue = currentPurchase + Number(totalReturn);
        supplier.dueBalance = currentDue + Number(remaining);
      }

      await repo.save(supplier);
    };

    // CASE 1: entering ACCEPTED (return is accepted, subtract from supplier)
    if (!wasAccepted && isAccepted) {
      await updateSupplier(newSupplierId, "subtract");
    }

    // CASE 2: leaving ACCEPTED (return is cancelled/rejected, add back to supplier)
    if (wasAccepted && !isAccepted) {
      await updateSupplier(oldSupplierId, "add");
    }

    // CASE 3: supplier changed while ACCEPTED
    if (
      wasAccepted &&
      isAccepted &&
      oldSupplierId &&
      newSupplierId &&
      oldSupplierId !== newSupplierId
    ) {
      await updateSupplier(oldSupplierId, "add");
      await updateSupplier(newSupplierId, "subtract");
    }
  }

  async stats(me: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const acceptedCount = await this.invRepo.count({ where: { adminId, status: ApprovalStatus.ACCEPTED } as any });
    const pendingCount = await this.invRepo.count({ where: { adminId, status: ApprovalStatus.PENDING } as any });
    const rejectedCount = await this.invRepo.count({ where: { adminId, status: ApprovalStatus.REJECTED } as any });

    const totalReturnValueRaw = await this.invRepo
      .createQueryBuilder("r")
      .select("COALESCE(SUM(r.totalReturn),0)", "sum")
      .where("r.adminId = :adminId", { adminId })
      .andWhere("r.status = :status", { status: ApprovalStatus.ACCEPTED })
      .getRawOne();

    return {
      returnInvoicesCount: acceptedCount + pendingCount + rejectedCount,
      accepted: acceptedCount,
      pending: pendingCount,
      rejected: rejectedCount,
      totalReturnValue: Number(totalReturnValueRaw?.sum || 0),
    };
  }

  async list(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? "").trim();

    const supplierId = q?.supplierId && q.supplierId !== "all" ? q.supplierId : null;
    const status = q?.status && q.status !== "all" ? String(q.status) : null;
    const returnType = q?.returnType && q.returnType !== "all" ? String(q.returnType) : null;
    const startDate = q?.startDate ? String(q.startDate) : null;
    const endDate = q?.endDate ? String(q.endDate) : null;
    const hasReceipt = q?.hasReceipt && q.hasReceipt !== "all" ? String(q.hasReceipt) : null;

    const qb = this.invRepo
      .createQueryBuilder("inv")
      .where("inv.adminId = :adminId", { adminId })
      .leftJoinAndSelect("inv.supplier", "supplier")
      .leftJoinAndSelect("inv.createdBy", "createdBy");

    if (supplierId && supplierId != 'none')
      qb.andWhere("inv.supplierId = :supplierId", { supplierId });
    else if (supplierId === 'none') {
      qb.andWhere("inv.supplierId IS NULL");
    }
    if (status) qb.andWhere("inv.status = :status", { status });
    if (returnType) qb.andWhere("inv.returnType = :returnType", { returnType });

    if (hasReceipt === "yes") qb.andWhere("inv.receiptAsset IS NOT NULL");
    if (hasReceipt === "no") qb.andWhere("inv.receiptAsset IS NULL");

    DateFilterUtil.applyToQueryBuilder(qb, "inv.created_at", startDate, endDate);

    if (search) {
      qb.andWhere(
        "(inv.returnNumber ILIKE :s OR inv.invoiceNumber ILIKE :s OR inv.supplierNameSnapshot ILIKE :s OR inv.notes ILIKE :s)",
        { s: `%${search}%` }
      );
    }

    if (q?.closingId) qb.andWhere("inv.closingId = :closingId", { closingId: q?.closingId });
    else {
      if (q?.closed && q?.closed !== "none") {
        if (q?.closed === "false") {
          qb.andWhere("inv.closingId IS NULL");
        } else if (q?.closed === "true") {
          qb.andWhere("inv.closingId IS NOT NULL");
        }
      }
    }

    qb.orderBy("inv.created_at", (q?.sortOrder ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC");

    const total = await qb.getCount();
    const records = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  async get(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const inv = await this.invRepo.findOne({
      where: { id, adminId } as any,
      relations: ["items", "items.variant", "items.variant.product"], // ✅ better details modal
    });

    const supplier = await this.supplierRepo.findOne({
      where: { id: inv.supplierId }
    });

    if (!inv) throw new BadRequestException("purchase invoice not found");
    return { ...inv, supplier };
  }


  async getAuditLogs(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    // ensure invoice exists and belongs to tenant
    await this.get(me, id);

    return this.auditRepo.find({
      where: { adminId, invoiceId: id } as any,
      order: { created_at: "DESC" },
    });
  }

  async acceptPreview(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const inv = await this.invRepo.findOne({
      where: { id, adminId } as any,
      relations: ["items", "items.variant", "items.variant.product"],
    });
    if (!inv) throw new BadRequestException("purchase return invoice not found");

    const oldStatus = inv.status;
    const willApply = oldStatus !== ApprovalStatus.ACCEPTED;

    const rows = (inv.items ?? []).map((it) => {
      const v = it.variant;
      if (!v) {
        return {
          variantId: it.variantId,
          error: "Variant not found",
        };
      }

      const removeQty = Number(it.returnedQuantity) || 0;
      const oldStock = Number(v.stockOnHand) || 0;
      const newStock = willApply ? oldStock - removeQty : oldStock;

      return {
        variantId: v.id,
        sku: v.sku ?? null,
        name: v.product?.name ?? "N/A",
        oldStock,
        removeQty,
        newStock,
        // Financials from line item
        unitCost: Number(it.unitCost) || 0,
        taxInclusive: !!it.taxInclusive,
        taxRate: Number(it.taxRate) || 0,
        lineTax: Number(it.lineTax) || 0,
        lineTotal: Number(it.lineTotal) || 0,
      };
    });

    return {
      invoiceId: inv.id,
      returnNumber: inv.returnNumber,
      currentStatus: inv.status,
      canApply: inv.status !== ApprovalStatus.ACCEPTED,
      rows,
    };
  }

  async updatePaidAmount(me: any, id: string, dto: UpdatePaidAmountDto, ipAddress?: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const inv = await this.get(me, id);
    if (inv.closingId) {
      throw new BadRequestException("Cannot update a purchase return that has been closed.");
    }

    const oldStatus = inv.status;
    const oldPaidAmount = Number(inv.paidAmount || 0);
    const totalReturn = Number(inv.totalReturn || 0);

    (inv as any).paidAmount = dto.paidAmount;
    (inv as any).totalReturn = Number((inv as any).subtotal) + Number((inv as any).taxTotal);

    const saved = await this.invRepo.save(inv as any);

    // Sync supplier if status is ACCEPTED
    if (oldStatus === ApprovalStatus.ACCEPTED) {
      await this.syncSupplierFinancials({
        oldStatus: ApprovalStatus.ACCEPTED,
        newStatus: ApprovalStatus.ACCEPTED,
        oldSupplierId: inv.supplierId,
        newSupplierId: inv.supplierId,
        totalReturn: 0, // No change in total items value
        paidAmount: dto.paidAmount - oldPaidAmount, // Difference in refund
      });
    }

    await this.log({
      adminId,
      invoiceId: saved.id,
      userId: me?.id ?? null,
      action: PurchaseReturnAuditAction.PAID_AMOUNT_UPDATED,
      description: `Refunded amount updated to ${dto.paidAmount}`,
      ipAddress,
    });

    return saved;
  }

  async create(me: any, dto: CreatePurchaseReturnDto, ipAddress?: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");
    if (!dto.items?.length) throw new BadRequestException("Items are required");

    const exists = await this.invRepo.findOne({ where: { adminId, returnNumber: dto.returnNumber } as any });
    if (exists) throw new BadRequestException("returnNumber already exists");

    if (dto.supplierId) {
      const supplier = await this.supplierRepo.findOne({ where: { id: dto.supplierId } as any });
      if (!supplier) throw new BadRequestException("supplier not found");
    }

    const items = dto.items.map((it) => {
      const taxRate = it.taxRate ?? 5;
      const taxInclusive = !!it.taxInclusive;
      const { lineSubtotal, lineTax, lineTotal } = calcLine(it.unitCost, it.returnedQuantity, taxRate, taxInclusive);

      return this.itemRepo.create({
        adminId,
        variantId: it.variantId,
        returnedQuantity: it.returnedQuantity,
        unitCost: it.unitCost,
        taxInclusive,
        taxRate,
        lineSubtotal,
        lineTax,
        lineTotal,
      } as any);
    });

    const subtotal = items.reduce((s, x: any) => s + x.lineSubtotal, 0);
    const taxTotal = items.reduce((s, x: any) => s + x.lineTax, 0);
    const totalReturn = subtotal + taxTotal;

    const inv = this.invRepo.create({
      adminId,
      returnNumber: dto.returnNumber,
      supplierId: dto.supplierId ?? null,
      supplierNameSnapshot: dto.supplierNameSnapshot ?? null,
      supplierCodeSnapshot: dto.supplierCodeSnapshot ?? null,
      invoiceNumber: dto.invoiceNumber ?? null,
      returnReason: dto.returnReason ?? null,
      safeId: dto.safeId ?? null,
      returnType: dto.returnType ?? null,
      status: ApprovalStatus.PENDING,
      notes: dto.notes ?? null,
      paidAmount: dto.paidAmount ?? 0,
      receiptAsset: dto.receiptAsset ?? null,
      subtotal,
      taxTotal,
      totalReturn,
      createdByUserId: me?.id ?? null,
      items,
    } as any);

    const saved: any = await this.invRepo.save(inv);

    await this.log({
      adminId,
      invoiceId: saved.id,
      userId: me?.id ?? null,
      action: PurchaseReturnAuditAction.CREATED,
      description: `Purchase return invoice created`,
      ipAddress,
    });

    return saved;
  }

  async update(me: any, id: string, dto: UpdatePurchaseReturnDto, ipAddress?: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const inv = await this.get(me, id);
    if (inv.closingId) {
      throw new BadRequestException("Cannot update a purchase return that has been closed.");
    }
    const oldStatus = inv.status;
    const oldSupplierId = inv.supplierId;

    // Delete old file if a new one is uploaded
    if (dto.receiptAsset && inv.receiptAsset && dto.receiptAsset !== inv.receiptAsset) {
      const oldPath = path.join(process.cwd(), inv.receiptAsset);
      if (fs.existsSync(oldPath)) {
        try {
          fs.unlinkSync(oldPath);
        } catch (e) {
          console.error(`Failed to delete old file: ${oldPath}`, e);
        }
      }
    }

    // if items provided -> replace
    let saved;
    if (dto.items) {
      await this.itemRepo.delete({ invoiceId: id } as any);

      const items = dto.items.map((it) => {
        const taxRate = it.taxRate ?? 5;
        const taxInclusive = !!it.taxInclusive;
        const { lineSubtotal, lineTax, lineTotal } = calcLine(it.unitCost, it.returnedQuantity, taxRate, taxInclusive);

        return this.itemRepo.create({
          adminId,
          invoiceId: id,
          variantId: it.variantId,
          returnedQuantity: it.returnedQuantity,
          unitCost: it.unitCost,
          taxInclusive,
          taxRate,
          lineSubtotal,
          lineTax,
          lineTotal,
        } as any);
      });

      const subtotal = items.reduce((s, x: any) => s + x.lineSubtotal, 0);
      const taxTotal = items.reduce((s, x: any) => s + x.lineTax, 0);
      const paidAmount = dto.paidAmount ?? inv.paidAmount ?? 0;
      const totalReturn = subtotal + taxTotal;

      Object.assign(inv as any, dto, { subtotal, taxTotal, totalReturn, items, paidAmount });
      saved = await this.invRepo.save(inv as any);
    } else {
      Object.assign(inv as any, dto);
      if (typeof dto.paidAmount === "number") {
        (inv as any).totalReturn = Number(((inv as any).subtotal ?? 0)) + Number(((inv as any).taxTotal ?? 0));
      }
      saved = await this.invRepo.save(inv as any);
    }

    // --- Sync supplier financials only if status is ACCEPTED ---
    await this.syncSupplierFinancials({
      oldStatus: oldStatus,
      newStatus: saved.status,
      oldSupplierId: oldSupplierId,
      newSupplierId: saved.supplierId,
      totalReturn: Number(saved.totalReturn || 0),
      paidAmount: Number(saved.paidAmount || 0),
    });

    await this.log({
      adminId,
      invoiceId: saved.id,
      userId: me?.id ?? null,
      action: PurchaseReturnAuditAction.UPDATED,
      description: `Purchase return invoice updated`,
      ipAddress,
    });

    return saved;
  }

  async updateStatus(me: any, id: string, status: ApprovalStatus, ipAddress?: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    return this.dataSource.transaction(async (manager) => {
      const inv = await manager.findOne(PurchaseReturnInvoiceEntity, {
        where: { id, adminId } as any,
        relations: ["items", "items.variant"],
      });
      if (!inv) throw new BadRequestException("purchase return invoice not found");
      if (inv.closingId) {
        throw new BadRequestException("Cannot update a purchase return that has been closed.");
      }

      const oldStatus = inv.status;
      if (oldStatus === status) return inv;

      // =========================================================
      // 1) IF going ACCEPTED from non-accepted:
      //    - deduct stock
      //    - check if enough stock exists
      //    - write audit logs (STOCK_REMOVED)
      // =========================================================
      if (status === ApprovalStatus.ACCEPTED && oldStatus !== ApprovalStatus.ACCEPTED) {
        const byVariant = new Map<string, number>();

        for (const it of inv.items ?? []) {
          const vid = it.variantId;
          const qty = Number(it.returnedQuantity) || 0;
          byVariant.set(vid, (byVariant.get(vid) ?? 0) + qty);
        }

        const variantIds = [...byVariant.keys()];
        if (!variantIds.length) throw new BadRequestException("No items to return");

        const variants = await manager.find(ProductVariantEntity, {
          where: { adminId, id: In(variantIds) } as any,
        });

        const byId = new Map<string, ProductVariantEntity>();
        for (const v of variants) byId.set(v.id, v);

        const changedVariants: ProductVariantEntity[] = [];
        const stockChanges: any[] = [];

        for (const variantId of variantIds) {
          const v = byId.get(variantId);
          if (!v) throw new BadRequestException(`Variant not found: ${variantId}`);

          const removeQty = byVariant.get(variantId)!;
          const oldStock = Number(v.stockOnHand) || 0;
          const nextStock = oldStock - removeQty;

          if (nextStock < 0) {
            throw new BadRequestException(
              `Insufficient stock for variant ${v.sku || variantId}. Required: ${removeQty}, Available: ${oldStock}`
            );
          }

          v.stockOnHand = nextStock;
          stockChanges.push({ variantId, sku: v.sku, oldStock, removeQty, newStock: nextStock });
          changedVariants.push(v);
        }

        await manager.save(ProductVariantEntity, changedVariants);

        await this.log({
          adminId,
          invoiceId: inv.id,
          userId: me?.id ?? null,
          action: PurchaseReturnAuditAction.STOCK_REMOVED,
          changes: stockChanges,
          description: `Stock deducted (status -> ACCEPTED)`,
          ipAddress,
          manager,
        });
      }

      // =========================================================
      // 2) IF leaving ACCEPTED:
      //    - rollback stock (add back)
      //    - write audit logs (STOCK_APPLIED)
      // =========================================================
      if (oldStatus === ApprovalStatus.ACCEPTED && status !== ApprovalStatus.ACCEPTED) {
        const byVariant = new Map<string, number>();

        for (const it of inv.items ?? []) {
          const vid = it.variantId;
          const qty = Number(it.returnedQuantity) || 0;
          byVariant.set(vid, (byVariant.get(vid) ?? 0) + qty);
        }

        const variantIds = [...byVariant.keys()];
        if (variantIds.length) {
          const variants = await manager.find(ProductVariantEntity, {
            where: { adminId, id: In(variantIds) } as any,
          });

          const byId = new Map<string, ProductVariantEntity>();
          for (const v of variants) byId.set(v.id, v);

          const changedVariants: ProductVariantEntity[] = [];
          const stockChanges: any[] = [];

          for (const variantId of variantIds) {
            const v = byId.get(variantId);
            if (!v) throw new BadRequestException(`Variant not found: ${variantId}`);

            const addQty = byVariant.get(variantId)!;
            const oldStock = Number(v.stockOnHand) || 0;
            const nextStock = oldStock + addQty;

            v.stockOnHand = nextStock;
            stockChanges.push({ variantId, sku: v.sku, oldStock, addQty, newStock: nextStock });
            changedVariants.push(v);
          }

          await manager.save(ProductVariantEntity, changedVariants);

          await this.log({
            adminId,
            invoiceId: inv.id,
            userId: me?.id ?? null,
            action: PurchaseReturnAuditAction.STOCK_APPLIED,
            changes: stockChanges,
            description: `Stock restored (status left ACCEPTED)`,
            ipAddress,
            manager,
          });
        }
      }

      // =========================================================
      // 3) Update invoice status + financial sync + audit log
      // =========================================================
      inv.status = status;
      const saved = await manager.save(PurchaseReturnInvoiceEntity, inv);

      await this.syncSupplierFinancials({
        oldStatus: oldStatus,
        newStatus: status,
        oldSupplierId: inv.supplierId,
        newSupplierId: inv.supplierId,
        totalReturn: Number(saved.totalReturn || 0),
        paidAmount: Number(saved.paidAmount || 0),
        manager,
      });

      await this.log({
        adminId,
        invoiceId: saved.id,
        userId: me?.id ?? null,
        action: PurchaseReturnAuditAction.STATUS_CHANGED,
        oldData: { status: oldStatus },
        newData: { status },
        description: `Status changed from ${oldStatus} to ${status}`,
        ipAddress,
        manager,
      });

      return saved;
    });
  }

  async remove(me: any, id: string, ipAddress?: string) {
    const adminId = tenantId(me);
    const inv = await this.get(me, id);
    if (inv.closingId) {
      throw new BadRequestException("Cannot delete a purchase return that has been closed.");
    }

    await this.log({
      adminId,
      invoiceId: inv.id,
      userId: me?.id ?? null,
      action: PurchaseReturnAuditAction.DELETED,
      description: `Purchase return invoice deleted`,
      ipAddress,
    });

    return CRUD.delete(this.invRepo, "purchase_return_invoices", id);
  }

  async exportPurchaseReturns(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const search = String(q?.search ?? "").trim();
    const supplierId = q?.supplierId && q.supplierId !== "all" ? q.supplierId : null;
    const status = q?.status && q.status !== "all" ? String(q.status) : null;
    const returnType = q?.returnType && q.returnType !== "all" ? String(q.returnType) : null;
    const startDate = q?.startDate ? String(q.startDate) : null;
    const endDate = q?.endDate ? String(q.endDate) : null;
    const hasReceipt = q?.hasReceipt && q.hasReceipt !== "all" ? String(q.hasReceipt) : null;

    const qb = this.invRepo
      .createQueryBuilder("inv")
      .where("inv.adminId = :adminId", { adminId })
      .leftJoinAndSelect("inv.supplier", "supplier")
      .leftJoinAndSelect("inv.createdBy", "createdBy");

    if (supplierId && supplierId != 'none')
      qb.andWhere("inv.supplierId = :supplierId", { supplierId });
    else if (supplierId === 'none') {
      qb.andWhere("inv.supplierId IS NULL");
    }
    if (status) qb.andWhere("inv.status = :status", { status });
    if (returnType) qb.andWhere("inv.returnType = :returnType", { returnType });

    if (hasReceipt === "yes") qb.andWhere("inv.receiptAsset IS NOT NULL");
    if (hasReceipt === "no") qb.andWhere("inv.receiptAsset IS NULL");

    DateFilterUtil.applyToQueryBuilder(qb, "inv.created_at", startDate, endDate);

    if (search) {
      qb.andWhere(
        "(inv.returnNumber ILIKE :s OR inv.invoiceNumber ILIKE :s OR inv.supplierNameSnapshot ILIKE :s OR inv.notes ILIKE :s)",
        { s: `%${search}%` }
      );
    }

    qb.orderBy("inv.created_at", (q?.sortOrder ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC");

    const records = await qb.getMany();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Purchase Returns");

    worksheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Return #", key: "returnNumber", width: 20 },
      { header: "Invoice #", key: "invoiceNumber", width: 20 },
      { header: "Supplier", key: "supplier", width: 25 },
      { header: "Status", key: "status", width: 15 },
      { header: "Return Type", key: "returnType", width: 15 },
      { header: "Subtotal", key: "subtotal", width: 15 },
      { header: "Tax Total", key: "taxTotal", width: 15 },
      { header: "Total Return", key: "totalReturn", width: 15 },
      { header: "Refunded", key: "paidAmount", width: 15 },
      { header: "Created At", key: "created_at", width: 18 },
    ];

    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6C5CE7" } };

    records.forEach((inv) => {
      worksheet.addRow({
        id: inv.id,
        returnNumber: inv.returnNumber,
        invoiceNumber: inv.invoiceNumber,
        supplier: inv.supplier?.name || inv.supplierNameSnapshot || "N/A",
        status: inv.status,
        returnType: inv.returnType,
        subtotal: inv.subtotal,
        taxTotal: inv.taxTotal,
        totalReturn: inv.totalReturn,
        paidAmount: inv.paidAmount,
        created_at: inv.created_at ? new Date(inv.created_at).toLocaleDateString("en-US") : "",
      });
    });

    return await workbook.xlsx.writeBuffer();
  }
}
