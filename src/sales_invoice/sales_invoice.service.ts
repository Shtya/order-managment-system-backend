// sales-invoices/sales-invoices.service.ts
import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { CRUD } from "common/crud.service";
import { SalesInvoiceEntity, SalesInvoiceItemEntity } from "entities/sales_invoice.entity";
import {
  CreateSalesInvoiceDto,
  UpdateSalesInvoiceDto,
} from "dto/sales_invoice.dto";
import { PaymentStatus } from "common/enums";

// ✅ same helper style as your code
export function tenantId(me: any): any | null {
  if (!me) return null;
  const roleName = me.role?.name;
  if (roleName === "super_admin") return null;
  if (roleName === "admin") return me.id;
  return me.adminId;
}

function calcLine(unitPrice: number, qty: number, discount: number, taxRate: number, taxInclusive: boolean) {
  const raw = unitPrice * qty;
  const lineSubtotal = Math.max(raw - (discount || 0), 0);

  // follows your earlier convention (tax only when taxInclusive = true)
  const lineTax = taxInclusive ? Math.round((lineSubtotal * (taxRate || 0)) / 100) : 0;

  const lineTotal = lineSubtotal + lineTax;
  return { lineSubtotal, lineTax, lineTotal };
}

function calcPaymentStatus(total: number, paid: number): PaymentStatus {
  const p = Math.max(paid || 0, 0);
  if (p <= 0) return PaymentStatus.UNPAID;
  if (p >= total) return PaymentStatus.PAID;
  return PaymentStatus.PARTIALLY_PAID;
}

@Injectable()
export class SalesInvoicesService {
  constructor(
    @InjectRepository(SalesInvoiceEntity) private invRepo: Repository<SalesInvoiceEntity>,
    @InjectRepository(SalesInvoiceItemEntity) private itemRepo: Repository<SalesInvoiceItemEntity>,
  ) {}

  async stats(me: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const totalInvoices = await this.invRepo.count({ where: { adminId } as any });

    const totalsRaw = await this.invRepo
      .createQueryBuilder("s")
      .select("COALESCE(SUM(s.total),0)", "totalSales")
      .addSelect("COALESCE(SUM(s.paidAmount),0)", "totalPaid")
      .addSelect("COALESCE(SUM(s.remainingAmount),0)", "totalRemaining")
      .where("s.adminId = :adminId", { adminId })
      .getRawOne();

    return {
      invoicesCount: totalInvoices,
      totalSales: Number(totalsRaw?.totalSales || 0),
      totalPaid: Number(totalsRaw?.totalPaid || 0),
      totalRemaining: Number(totalsRaw?.totalRemaining || 0),
    };
  }

  async list(me: any, q?: any) {
    const filters: Record<string, any> = {};

    if (q?.paymentStatus && q?.paymentStatus !== "all") filters.paymentStatus = q.paymentStatus;
    if (q?.paymentMethod && q?.paymentMethod !== "all") filters.paymentMethod = q.paymentMethod;
    if (q?.safeId && q?.safeId !== "none") filters.safeId = Number(q.safeId);

    return CRUD.findAll(
      this.invRepo,
      "sales_invoices",
      q?.search,
      q?.page ?? 1,
      q?.limit ?? 10,
      q?.sortBy ?? "created_at",
      (q?.sortOrder ?? "DESC") as any,
      [],
      ["invoiceNumber", "customerName", "phone", "notes"],
      {
        __tenant: { role: me?.role?.name, userId: me?.id, adminId: me?.adminId },
        filters,
      } as any
    );
  }

  async get(me: any, id: number) {
    return CRUD.findOne(this.invRepo, "sales_invoices", id);
  }

  async create(me: any, dto: CreateSalesInvoiceDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");
    if (!dto.items?.length) throw new BadRequestException("Items are required");

    const exists = await this.invRepo.findOne({ where: { adminId, invoiceNumber: dto.invoiceNumber } as any });
    if (exists) throw new BadRequestException("invoiceNumber already exists");

    const items = dto.items.map((it) => {
      const discount = it.discount ?? 0;
      const taxRate = it.taxRate ?? 0;
      const taxInclusive = !!it.taxInclusive;

      const { lineSubtotal, lineTax, lineTotal } = calcLine(
        it.unitPrice,
        it.quantity,
        discount,
        taxRate,
        taxInclusive
      );

      return this.itemRepo.create({
        adminId,
        variantId: it.variantId,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        discount,
        taxInclusive,
        taxRate,
        lineSubtotal,
        lineTax,
        lineTotal,
      } as any);
    });

    const subtotal = items.reduce((s, x:any) => s + x.lineSubtotal, 0);
    const taxTotal = items.reduce((s, x:any) => s + x.lineTax, 0);
    const discountTotal = items.reduce((s, x:any) => s + (x.discount || 0), 0);

    const shippingCost = dto.shippingCost ?? 0;
    const total = subtotal + taxTotal + shippingCost;

    const paidAmount = dto.paidAmount ?? 0;
    const remainingAmount = Math.max(total - paidAmount, 0);

    const paymentStatus = dto.paymentStatus ?? calcPaymentStatus(total, paidAmount);

    const inv = this.invRepo.create({
      adminId,
      invoiceNumber: dto.invoiceNumber,
      customerName: dto.customerName,
      phone: dto.phone ?? null,
      paymentMethod: dto.paymentMethod ?? null,
      paymentStatus,
      safeId: dto.safeId ?? null,
      notes: dto.notes ?? null,
      subtotal,
      taxTotal,
      shippingCost,
      discountTotal,
      total,
      paidAmount,
      remainingAmount,
      createdByUserId: me?.id ?? null,
      items,
    } as any);

    return this.invRepo.save(inv);
  }

  async update(me: any, id: number, dto: UpdateSalesInvoiceDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const inv = await this.get(me, id);

    if (dto.invoiceNumber && dto.invoiceNumber !== (inv as any).invoiceNumber) {
      const exists = await this.invRepo.findOne({ where: { adminId, invoiceNumber: dto.invoiceNumber } as any });
      if (exists) throw new BadRequestException("invoiceNumber already exists");
    }

    // Replace items if provided
    if (dto.items) {
      await this.itemRepo.delete({ invoiceId: id } as any);

      const items = dto.items.map((it) => {
        const discount = it.discount ?? 0;
        const taxRate = it.taxRate ?? 0;
        const taxInclusive = !!it.taxInclusive;

        const { lineSubtotal, lineTax, lineTotal } = calcLine(
          it.unitPrice,
          it.quantity,
          discount,
          taxRate,
          taxInclusive
        );

        return this.itemRepo.create({
          adminId,
          invoiceId: id,
          variantId: it.variantId,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          discount,
          taxInclusive,
          taxRate,
          lineSubtotal,
          lineTax,
          lineTotal,
        } as any);
      });

      const subtotal = items.reduce((s, x:any) => s + x.lineSubtotal, 0);
      const taxTotal = items.reduce((s, x:any) => s + x.lineTax, 0);
      const discountTotal = items.reduce((s, x:any) => s + (x.discount || 0), 0);

      const shippingCost = dto.shippingCost ?? (inv as any).shippingCost ?? 0;
      const total = subtotal + taxTotal + shippingCost;

      const paidAmount = typeof dto.paidAmount === "number" ? dto.paidAmount : ((inv as any).paidAmount ?? 0);
      const remainingAmount = Math.max(total - paidAmount, 0);

      const paymentStatus =
        dto.paymentStatus ??
        calcPaymentStatus(total, paidAmount);

      Object.assign(inv as any, dto, {
        items,
        subtotal,
        taxTotal,
        discountTotal,
        shippingCost,
        total,
        paidAmount,
        remainingAmount,
        paymentStatus,
      });

      return this.invRepo.save(inv as any);
    }

    // header-only update
    Object.assign(inv as any, dto);

    // recalc payment derived fields if needed
    const total = (inv as any).total ?? 0;
    if (typeof dto.paidAmount === "number") {
      (inv as any).remainingAmount = Math.max(total - dto.paidAmount, 0);
      if (!dto.paymentStatus) (inv as any).paymentStatus = calcPaymentStatus(total, dto.paidAmount);
    }

    return this.invRepo.save(inv as any);
  }

  async updatePaymentStatus(me: any, id: number, paymentStatus: PaymentStatus) {
    const inv = await this.get(me, id);
    (inv as any).paymentStatus = paymentStatus;
    return this.invRepo.save(inv as any);
  }

  async remove(me: any, id: number) {
    await this.get(me, id);
    return CRUD.delete(this.invRepo, "sales_invoices", id);
  }
}
