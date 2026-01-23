// purchases/purchases.service.ts
import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Repository } from "typeorm";
import { PurchaseInvoiceEntity, PurchaseInvoiceItemEntity, PurchaseAuditAction, PurchaseAuditLogEntity } from "entities/purchase.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import { CreatePurchaseDto, UpdatePurchaseDto, UpdatePaidAmountDto } from "dto/purchase.dto";
import { ApprovalStatus } from "common/enums";
import { SupplierEntity } from "../../entities/supplier.entity";

export function tenantId(me: any): any | null {
	if (!me) return null;
	const roleName = me.role?.name;
	if (roleName === "super_admin") return null;
	if (roleName === "admin") return me.id;
	return me.adminId;
}

@Injectable()
export class PurchasesService {
	constructor(
		private dataSource: DataSource,

		@InjectRepository(PurchaseInvoiceEntity)
		private invRepo: Repository<PurchaseInvoiceEntity>,

		@InjectRepository(SupplierEntity)
		private supplierRepo: Repository<SupplierEntity>,

		@InjectRepository(PurchaseInvoiceItemEntity)
		private itemRepo: Repository<PurchaseInvoiceItemEntity>,

		@InjectRepository(PurchaseAuditLogEntity)
		private auditRepo: Repository<PurchaseAuditLogEntity>,

		@InjectRepository(ProductVariantEntity)
		private pvRepo: Repository<ProductVariantEntity>,
	) { }

	private async log(params: {
		adminId: string;
		invoiceId: number;
		userId?: number | null;
		action: PurchaseAuditAction;
		oldData?: any;
		newData?: any;
		changes?: any;
		description?: string;
		ipAddress?: string;
	}) {
		const row = this.auditRepo.create({
			adminId: params.adminId,
			invoiceId: params.invoiceId,
			userId: params.userId ?? null,
			action: params.action,
			oldData: params.oldData ?? null,
			newData: params.newData ?? null,
			changes: params.changes ?? null,
			description: params.description ?? null,
			ipAddress: params.ipAddress ?? null,
		} as any);

		await this.auditRepo.save(row);
	}

	async stats(me: any) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const accepted = await this.invRepo.count({ where: { adminId, status: ApprovalStatus.ACCEPTED } as any });
		const pending = await this.invRepo.count({ where: { adminId, status: ApprovalStatus.PENDING } as any });
		const rejected = await this.invRepo.count({ where: { adminId, status: ApprovalStatus.REJECTED } as any });

		return { accepted, pending, rejected };
	}


	async list(me: any, q?: any) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const page = Number(q?.page ?? 1);
		const limit = Number(q?.limit ?? 10);
		const search = String(q?.search ?? "").trim();

		const supplierId = q?.supplierId && q.supplierId !== "none" ? Number(q.supplierId) : null;
		const status = q?.status && q.status !== "all" ? String(q.status) : null;
		const startDate = q?.startDate ? String(q.startDate) : null; // YYYY-MM-DD
		const endDate = q?.endDate ? String(q.endDate) : null;
		const hasReceipt = q?.hasReceipt && q.hasReceipt !== "all" ? String(q.hasReceipt) : null; // yes/no

		const qb = this.invRepo
			.createQueryBuilder("inv")
			.where("inv.adminId = :adminId", { adminId })
			// ✅ THIS is what brings supplier data
			.leftJoinAndSelect("inv.supplier", "supplier");

		if (supplierId) qb.andWhere("inv.supplierId = :supplierId", { supplierId });
		if (status) qb.andWhere("inv.status = :status", { status });

		if (hasReceipt === "yes") qb.andWhere("inv.receiptAsset IS NOT NULL");
		if (hasReceipt === "no") qb.andWhere("inv.receiptAsset IS NULL");

		if (startDate) qb.andWhere("inv.created_at >= :startDate", { startDate: `${startDate}T00:00:00.000Z` });
		if (endDate) qb.andWhere("inv.created_at <= :endDate", { endDate: `${endDate}T23:59:59.999Z` });

		if (search) {
			qb.andWhere("(inv.receiptNumber ILIKE :s OR inv.notes ILIKE :s)", { s: `%${search}%` });
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
			records, // ✅ each invoice now includes `supplier` object
		};
	}

	async get(me: any, id: number) {
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

	async getAuditLogs(me: any, id: number) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		// ensure invoice exists and belongs to tenant
		await this.get(me, id);

		return this.auditRepo.find({
			where: { adminId, invoiceId: id } as any,
			order: { created_at: "DESC" },
		});
	}

	async acceptPreview(me: any, id: number) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const inv = await this.invRepo.findOne({
			where: { id, adminId } as any,
			relations: ["items", "items.variant"],
		});
		if (!inv) throw new BadRequestException("purchase invoice not found");

		const oldStatus = inv.status;
		const willApply = oldStatus !== ApprovalStatus.ACCEPTED;

		// aggregate qty + avg incoming cost per variant (in case of duplicates)
		const map = new Map<number, { qty: number; incomingCostTotal: number }>();
		for (const it of inv.items ?? []) {
			const vid = Number(it.variantId);
			const qty = Number(it.quantity) || 0;
			const cost = Number(it.purchaseCost) || 0;

			const cur = map.get(vid) ?? { qty: 0, incomingCostTotal: 0 };
			cur.qty += qty;
			cur.incomingCostTotal += cost * qty;
			map.set(vid, cur);
		}

		const variantIds = [...map.keys()];
		const variants = await this.pvRepo.find({
			where: { adminId } as any,
		});

		const byId = new Map<number, ProductVariantEntity>();
		for (const v of variants) byId.set(v.id, v);

		const rows = variantIds.map((variantId) => {
			const v = byId.get(variantId);
			if (!v) {
				return {
					variantId,
					error: "Variant not found",
				};
			}

			const agg = map.get(variantId)!;
			const addQty = agg.qty;
			const oldStock = Number(v.stockOnHand) || 0;
			const newStock = willApply ? oldStock + addQty : oldStock;

			const incomingAvgCost = addQty > 0 ? agg.incomingCostTotal / addQty : 0;

			// ✅ Weighted average using existing stock + incoming
			const oldPrice = v.price ?? null;
			let newPrice: number | null = oldPrice;

			if (willApply) {
				if (oldPrice == null) {
					newPrice = Number.isFinite(incomingAvgCost) ? Math.round(incomingAvgCost) : null;
				} else {
					const denom = oldStock + addQty;
					if (denom > 0) {
						const weighted =
							(oldPrice * oldStock + incomingAvgCost * addQty) / denom;
						newPrice = Number.isFinite(weighted) ? Math.round(weighted) : oldPrice;
					}
				}
			}

			const priceWillChange =
				willApply && oldPrice !== null && newPrice !== null && oldPrice !== newPrice;

			return {
				variantId,
				sku: v.sku ?? null,
				oldStock,
				addQty,
				newStock,
				oldPrice,
				incomingAvgCost: Math.round(incomingAvgCost),
				newPrice,
				priceWillChange,
			};
		});

		return {
			invoiceId: inv.id,
			receiptNumber: inv.receiptNumber,
			currentStatus: inv.status,
			canApply: inv.status !== ApprovalStatus.ACCEPTED,
			rows,
		};
	}

	async create(me: any, dto: CreatePurchaseDto, ipAddress?: string) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");
		if (!dto.items?.length) throw new BadRequestException("Items are required");

		const exists = await this.invRepo.findOne({ where: { adminId, receiptNumber: dto.receiptNumber } as any });
		if (exists) throw new BadRequestException("receiptNumber already exists");

		const items = (dto.items || []).map((it) => {
			const lineSubtotal = it.purchaseCost * it.quantity;
			const lineTotal = lineSubtotal;

			return this.itemRepo.create({
				adminId,
				variantId: it.variantId,
				quantity: it.quantity,
				purchaseCost: it.purchaseCost,
				lineSubtotal,
				lineTotal,
			} as any);
		});

		const subtotal = items.reduce((s, x: any) => s + x.lineSubtotal, 0);
		const total = subtotal;

		const paidAmount = dto.paidAmount ?? 0;
		const remainingAmount = Math.max(total - paidAmount, 0);

		console.log(dto);

		const inv = this.invRepo.create({
			adminId,
			supplierId: dto.supplierId,
			receiptNumber: dto.receiptNumber,
			receiptAsset: dto.receiptAsset ?? null,
			safeId: dto.safeId,
			paidAmount,
			subtotal,
			total,
			remainingAmount,
			status: ApprovalStatus.PENDING,
			notes: dto.notes ?? null,
			items,
		} as any);

		const saved: any = await this.invRepo.save(inv);

		await this.log({
			adminId,
			invoiceId: saved.id,
			userId: me?.id ?? null,
			action: PurchaseAuditAction.CREATED,
			newData: { id: saved.id, status: saved.status },
			description: `Purchase invoice created (status: ${saved.status})`,
			ipAddress,
		});

		return saved;
	}

	async update(me: any, id: number, dto: UpdatePurchaseDto, ipAddress?: string) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const inv = await this.get(me, id);

		if (dto.receiptNumber && dto.receiptNumber !== inv.receiptNumber) {
			const exists = await this.invRepo.findOne({ where: { adminId, receiptNumber: dto.receiptNumber } as any });
			if (exists) throw new BadRequestException("receiptNumber already exists");
		}

		if (inv.status === ApprovalStatus.ACCEPTED && dto.items) {
			throw new BadRequestException("Cannot modify items of an ACCEPTED purchase. Change status first.");
		}

		if (dto.items) {
			await this.itemRepo.delete({ invoiceId: id } as any);

			const items = dto.items.map((it) => {
				const lineSubtotal = it.purchaseCost * it.quantity;
				const lineTotal = lineSubtotal;

				return this.itemRepo.create({
					adminId,
					invoiceId: id,
					variantId: it.variantId,
					quantity: it.quantity,
					purchaseCost: it.purchaseCost,
					lineSubtotal,
					lineTotal,
				} as any);
			});

			const subtotal = items.reduce((s, x: any) => s + x.lineSubtotal, 0);
			const total = subtotal;

			const paidAmount = dto.paidAmount ?? inv.paidAmount ?? 0;
			const remainingAmount = Math.max(total - paidAmount, 0);

			Object.assign(inv as any, dto, { subtotal, total, paidAmount, remainingAmount, items });
			const saved = await this.invRepo.save(inv as any);

			await this.log({
				adminId,
				invoiceId: saved.id,
				userId: me?.id ?? null,
				action: PurchaseAuditAction.UPDATED,
				description: `Purchase invoice updated`,
				ipAddress,
			});

			return saved;
		}

		Object.assign(inv as any, dto);

		if (typeof dto.paidAmount === "number") {
			(inv as any).remainingAmount = Math.max(((inv as any).total ?? 0) - dto.paidAmount, 0);
		}

		const saved = await this.invRepo.save(inv as any);

		await this.log({
			adminId,
			invoiceId: saved.id,
			userId: me?.id ?? null,
			action: PurchaseAuditAction.UPDATED,
			description: `Purchase invoice updated`,
			ipAddress,
		});

		return saved;
	}

	async updatePaidAmount(me: any, id: number, dto: UpdatePaidAmountDto, ipAddress?: string) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const inv = await this.get(me, id);
		const total = (inv as any).total ?? 0;
		(inv as any).paidAmount = dto.paidAmount;
		(inv as any).remainingAmount = Math.max(total - dto.paidAmount, 0);

		const saved = await this.invRepo.save(inv as any);

		await this.log({
			adminId,
			invoiceId: saved.id,
			userId: me?.id ?? null,
			action: PurchaseAuditAction.PAID_AMOUNT_UPDATED,
			description: `Paid amount updated`,
			ipAddress,
		});

		return saved;
	}

	async updateStatus(me: any, id: number, status: ApprovalStatus, ipAddress?: string) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		return this.dataSource.transaction(async (manager) => {
			const inv = await manager.findOne(PurchaseInvoiceEntity, {
				where: { id, adminId } as any,
				relations: ["items", "items.variant"],
			});
			if (!inv) throw new BadRequestException("purchase invoice not found");

			const oldStatus = inv.status;
			if (oldStatus === status) return inv;

			// =========================================================
			// 1) IF going ACCEPTED from non-accepted:
			//    - apply stock
			//    - update price by weighted average
			//    - write audit logs (STOCK_APPLIED + price_updated)
			// =========================================================
			if (status === ApprovalStatus.ACCEPTED && oldStatus !== ApprovalStatus.ACCEPTED) {
				const byVariant = new Map<number, { qty: number; incomingCostTotal: number }>();

				for (const it of inv.items ?? []) {
					const vid = Number(it.variantId);
					const qty = Number(it.quantity) || 0;
					const cost = Number(it.purchaseCost) || 0;

					const cur = byVariant.get(vid) ?? { qty: 0, incomingCostTotal: 0 };
					cur.qty += qty;
					cur.incomingCostTotal += cost * qty;
					byVariant.set(vid, cur);
				}

				const variantIds = [...byVariant.keys()];
				if (!variantIds.length) throw new BadRequestException("No items to apply");

				const variants = await manager.find(ProductVariantEntity, {
					where: { adminId, id: In(variantIds) } as any,
				});

				const byId = new Map<number, ProductVariantEntity>();
				for (const v of variants) byId.set(v.id, v);

				for (const variantId of variantIds) {
					if (!byId.get(variantId)) throw new BadRequestException(`Variant not found: ${variantId}`);
				}

				const changedVariants: ProductVariantEntity[] = [];
				const stockChanges: any[] = [];
				const priceChanges: any[] = [];

				for (const variantId of variantIds) {
					const v = byId.get(variantId)!;
					const agg = byVariant.get(variantId)!;

					const addQty = agg.qty;
					const oldStock = Number(v.stockOnHand) || 0;

					const nextStock = oldStock + addQty;
					v.stockOnHand = nextStock;

					stockChanges.push({ variantId, oldStock, addQty, newStock: nextStock });

					const incomingAvg = addQty > 0 ? agg.incomingCostTotal / addQty : 0;

					const oldPrice = v.price ?? null;
					let newPrice: number | null = oldPrice;

					if (oldPrice == null) {
						newPrice = Number.isFinite(incomingAvg) ? Math.round(incomingAvg) : null;
					} else {
						const denom = oldStock + addQty;
						if (denom > 0) {
							const weighted = (oldPrice * oldStock + incomingAvg * addQty) / denom;
							newPrice = Number.isFinite(weighted) ? Math.round(weighted) : oldPrice;
						}
					}

					if (oldPrice !== newPrice) {
						v.price = newPrice ?? undefined;
						priceChanges.push({
							variantId,
							sku: v.sku ?? null,
							oldPrice,
							incomingAvgCost: Math.round(incomingAvg),
							newPrice,
						});
					}

					changedVariants.push(v);
				}

				await manager.save(ProductVariantEntity, changedVariants);

				await this.log({
					adminId,
					invoiceId: inv.id,
					userId: me?.id ?? null,
					action: PurchaseAuditAction.STOCK_APPLIED,
					changes: stockChanges,
					description: `Stock applied (status -> ACCEPTED)`,
					ipAddress,
				});

				if (priceChanges.length) {
					await this.log({
						adminId,
						invoiceId: inv.id,
						userId: me?.id ?? null,
						action: "price_updated" as any,
						changes: priceChanges,
						description: `Variant price updated by weighted average`,
						ipAddress,
					});
				}
			}

			// =========================================================
			// 2) IF leaving ACCEPTED:
			//    - remove stock (for both pending/rejected)
			//    - rollback price for BOTH pending/rejected
			// =========================================================
			if (oldStatus === ApprovalStatus.ACCEPTED && status !== ApprovalStatus.ACCEPTED) {
				const byVariant = new Map<number, number>();

				for (const it of inv.items ?? []) {
					const vid = Number(it.variantId);
					const qty = Number(it.quantity) || 0;
					byVariant.set(vid, (byVariant.get(vid) ?? 0) + qty);
				}

				const variantIds = [...byVariant.keys()];
				if (variantIds.length) {
					const variants = await manager.find(ProductVariantEntity, {
						where: { adminId, id: In(variantIds) } as any,
					});

					const byId = new Map<number, ProductVariantEntity>();
					for (const v of variants) byId.set(v.id, v);

					for (const variantId of variantIds) {
						if (!byId.get(variantId)) throw new BadRequestException(`Variant not found: ${variantId}`);
					}

					const changedVariants: ProductVariantEntity[] = [];
					const stockChanges: any[] = [];

					for (const variantId of variantIds) {
						const v = byId.get(variantId)!;

						const removeQty = byVariant.get(variantId) ?? 0;
						const oldStock = Number(v.stockOnHand) || 0;
						const next = oldStock - removeQty;

						if (next < 0) {
							throw new BadRequestException(
								`Cannot remove stock below zero for variantId=${variantId} (oldStock=${oldStock}, remove=${removeQty})`
							);
						}

						v.stockOnHand = next;
						stockChanges.push({ variantId, oldStock, removeQty, newStock: next });
						changedVariants.push(v);
					}

					await manager.save(ProductVariantEntity, changedVariants);

					await this.log({
						adminId,
						invoiceId: inv.id,
						userId: me?.id ?? null,
						action: PurchaseAuditAction.STOCK_REMOVED,
						changes: stockChanges,
						description: `Stock removed (status left ACCEPTED)`,
						ipAddress,
					});

					// ✅ Price rollback when leaving ACCEPTED to (REJECTED or PENDING)
					if (status === ApprovalStatus.REJECTED || status === ApprovalStatus.PENDING) {
						const lastPriceLog = await manager.findOne(PurchaseAuditLogEntity, {
							where: { adminId, invoiceId: inv.id, action: "price_updated" as any } as any,
							order: { created_at: "DESC" },
						});

						const priceChanges = (lastPriceLog as any)?.changes ?? [];
						if (Array.isArray(priceChanges) && priceChanges.length) {
							const priceVariantIds = [
								...new Set(priceChanges.map((x: any) => Number(x.variantId)).filter(Boolean)),
							];

							const priceVariants = await manager.find(ProductVariantEntity, {
								where: { adminId, id: In(priceVariantIds) } as any,
							});

							const pvById = new Map<number, ProductVariantEntity>();
							for (const v of priceVariants) pvById.set(v.id, v);

							const touched: ProductVariantEntity[] = [];

							for (const ch of priceChanges) {
								const vid = Number(ch.variantId);
								const v = pvById.get(vid);
								if (!v) continue;

								const oldPrice = ch.oldPrice;
								v.price = oldPrice === null || oldPrice === undefined ? undefined : Number(oldPrice);
								touched.push(v);
							}

							if (touched.length) {
								await manager.save(ProductVariantEntity, touched);

								await this.log({
									adminId,
									invoiceId: inv.id,
									userId: me?.id ?? null,
									action: "price_rolled_back" as any,
									changes: priceChanges,
									description: `Price rollback applied (status -> ${status})`,
									ipAddress,
								});
							}
						}
					}
				}
			}

			// =========================================================
			// 3) Update invoice status + audit log
			// =========================================================
			inv.status = status;
			const saved = await manager.save(PurchaseInvoiceEntity, inv);

			await this.log({
				adminId,
				invoiceId: saved.id,
				userId: me?.id ?? null,
				action: PurchaseAuditAction.STATUS_CHANGED,
				oldData: { status: oldStatus },
				newData: { status },
				description: `Status changed from ${oldStatus} to ${status}`,
				ipAddress,
			});

			return saved;
		});
	}



	async remove(me: any, id: number, ipAddress?: string) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const inv = await this.get(me, id);

		if (inv.status === ApprovalStatus.ACCEPTED) {
			throw new BadRequestException("Cannot delete ACCEPTED invoice. Change status first.");
		}

		await this.invRepo.delete({ id, adminId } as any);

		await this.log({
			adminId,
			invoiceId: id,
			userId: me?.id ?? null,
			action: PurchaseAuditAction.DELETED,
			description: `Purchase invoice deleted`,
			ipAddress,
		});

		return { ok: true };
	}
}
