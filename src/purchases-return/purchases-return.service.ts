// purchases-return/purchases-return.service.ts
import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { CRUD } from "common/crud.service";
import { PurchaseReturnInvoiceEntity, PurchaseReturnInvoiceItemEntity } from "entities/purchase_return.entity";
import { CreatePurchaseReturnDto, UpdatePurchaseReturnDto } from "dto/purchase_return.dto";
import { PurchaseReturnType, ReturnStatus } from "common/enums";
import { tenantId } from "../category/category.service"; // or duplicate helper locally

function calcLine(cost: number, qty: number, taxRate: number, taxInclusive: boolean) {
  const lineSubtotal = cost * qty;
  const lineTax = taxInclusive ? Math.round((lineSubtotal * taxRate) / 100) : 0;
  const lineTotal = lineSubtotal + lineTax;
  return { lineSubtotal, lineTax, lineTotal };
}

@Injectable()
export class PurchaseReturnsService {
  constructor(
    @InjectRepository(PurchaseReturnInvoiceEntity) private invRepo: Repository<PurchaseReturnInvoiceEntity>,
    @InjectRepository(PurchaseReturnInvoiceItemEntity) private itemRepo: Repository<PurchaseReturnInvoiceItemEntity>,
  ) {}

  async stats(me: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const totalInvoices = await this.invRepo.count({ where: { adminId } as any });
    const totalReturnValueRaw = await this.invRepo
      .createQueryBuilder("r")
      .select("COALESCE(SUM(r.totalReturn),0)", "sum")
      .where("r.adminId = :adminId", { adminId })
      .getRawOne();

    return {
      returnInvoicesCount: totalInvoices,
      totalReturnValue: Number(totalReturnValueRaw?.sum || 0),
    };
  }

  async list(me: any, q?: any) {
    const filters: Record<string, any> = {};

    if (q?.status && q?.status !== "all") filters.status = q.status;
    if (q?.returnType && q?.returnType !== "all") filters.returnType = q.returnType;
    if (q?.supplierId && q?.supplierId !== "none") filters.supplierId = Number(q.supplierId);

    return CRUD.findAll(
      this.invRepo,
      "purchase_return_invoices",
      q?.search,
      q?.page ?? 1,
      q?.limit ?? 10,
      q?.sortBy ?? "created_at",
      (q?.sortOrder ?? "DESC") as any,
      [],
      ["returnNumber", "invoiceNumber", "supplierNameSnapshot", "supplierCodeSnapshot", "notes"],
      {
        __tenant: { role: me?.role?.name, userId: me?.id, adminId: me?.adminId },
        filters,
      } as any
    );
  }

  async get(me: any, id: number) {
    return CRUD.findOne(this.invRepo, "purchase_return_invoices", id);
  }

  async create(me: any, dto: CreatePurchaseReturnDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");
    if (!dto.items?.length) throw new BadRequestException("Items are required");

    const exists = await this.invRepo.findOne({ where: { adminId, returnNumber: dto.returnNumber } as any });
    if (exists) throw new BadRequestException("returnNumber already exists");

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

    const subtotal = items.reduce((s, x:any) => s + x.lineSubtotal, 0);
    const taxTotal = items.reduce((s, x:any) => s + x.lineTax, 0);
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
      returnType: dto.returnType ?? PurchaseReturnType.CASH_REFUND,
      status: ReturnStatus.PENDING,
      notes: dto.notes ?? null,
      subtotal,
      taxTotal,
      totalReturn,
      createdByUserId: me?.id ?? null,
      items,
    } as any);

    return this.invRepo.save(inv);
  }

  async update(me: any, id: number, dto: UpdatePurchaseReturnDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException("Missing adminId");

    const inv = await this.get(me, id);

    // if items provided -> replace
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

      const subtotal = items.reduce((s, x:any) => s + x.lineSubtotal, 0);
      const taxTotal = items.reduce((s, x:any) => s + x.lineTax, 0);
      const totalReturn = subtotal + taxTotal;

      Object.assign(inv as any, dto, { subtotal, taxTotal, totalReturn, items });
      return this.invRepo.save(inv as any);
    }

    Object.assign(inv as any, dto);
    return this.invRepo.save(inv as any);
  }

  async updateStatus(me: any, id: number, status: ReturnStatus) {
    const inv = await this.get(me, id);
    (inv as any).status = status;
    return this.invRepo.save(inv as any);
  }

  async remove(me: any, id: number) {
    await this.get(me, id);
    return CRUD.delete(this.invRepo, "purchase_return_invoices", id);
  }
}
