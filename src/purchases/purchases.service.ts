
// purchases/purchases.service.ts
import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, In, Repository } from "typeorm";
import { PurchaseInvoiceEntity, PurchaseInvoiceItemEntity, PurchaseAuditAction, PurchaseAuditLogEntity } from "entities/purchase.entity";
import { ProductVariantEntity } from "entities/sku.entity";
import { CreatePurchaseDto, UpdatePurchaseDto, UpdatePaidAmountDto } from "dto/purchase.dto";
import { ApprovalStatus } from "common/enums";
import { DateFilterUtil } from "common/date-filter.util";
import { SupplierEntity } from "../../entities/supplier.entity";
import * as fs from "fs";
import * as path from "path";
import * as ExcelJS from "exceljs";

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
		invoiceId: string;
		userId?: string | null;
		action: PurchaseAuditAction | string;
		oldData?: any;
		newData?: any;
		changes?: any;
		description?: string;
		ipAddress?: string;
		manager?: EntityManager; // <--- ADD THIS
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

		// --- USE MANAGER IF PROVIDED, OTHERWISE USE REPO ---
		if (params.manager) {
			// Replace 'PurchaseAuditLogEntity' with your actual entity class name
			await params.manager.save(row);
		} else {
			await this.auditRepo.save(row);
		}
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

		const supplierId = q?.supplierId && q.supplierId !== "all" ? q.supplierId : null;
		const status = q?.status && q.status !== "all" ? String(q.status) : null;
		const startDate = q?.startDate ? String(q.startDate) : null; // YYYY-MM-DD
		const endDate = q?.endDate ? String(q.endDate) : null;
		const hasReceipt = q?.hasReceipt && q.hasReceipt !== "all" ? String(q.hasReceipt) : null; // yes/no

		const qb = this.invRepo
			.createQueryBuilder("inv")
			.where("inv.adminId = :adminId", { adminId })
			// ✅ THIS is what brings supplier data
			.leftJoinAndSelect("inv.supplier", "supplier");

		if (supplierId && supplierId != 'none')
			qb.andWhere("inv.supplierId = :supplierId", { supplierId });
		else if (supplierId === 'none') {
			qb.andWhere("inv.supplierId IS NULL");
		}

		if (status) qb.andWhere("inv.status = :status", { status });

		if (hasReceipt === "yes") qb.andWhere("inv.receiptAsset IS NOT NULL");
		if (hasReceipt === "no") qb.andWhere("inv.receiptAsset IS NULL");

		DateFilterUtil.applyToQueryBuilder(qb, "inv.created_at", startDate, endDate);

		if (search) {
			qb.andWhere(
				"(inv.receiptNumber ILIKE :s OR supplier.name ILIKE :s)",
				{ s: `%${search}%` }
			);
		}

		if (q?.closingId) qb.andWhere("inv.closingId = :closingId", { closingId: q?.closingId }); else {
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
			records, // ✅ each invoice now includes `supplier` object
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
			relations: ["items", "items.variant"],
		});
		if (!inv) throw new BadRequestException("purchase invoice not found");

		const oldStatus = inv.status;
		const willApply = oldStatus !== ApprovalStatus.ACCEPTED;

		// aggregate qty + avg incoming cost per variant (in case of duplicates)
		const map = new Map<string, { qty: number; incomingCostTotal: number }>();
		for (const it of inv.items ?? []) {
			const vid = it.variantId;
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

		const byId = new Map<string, ProductVariantEntity>();
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

	async create(me: any, dto: CreatePurchaseDto, ipAddress?: string, manager?: EntityManager) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");
		if (!dto.items?.length) throw new BadRequestException("Items are required");

		const repo = manager ? manager.getRepository(PurchaseInvoiceEntity) : this.invRepo;
		const itemRepo = manager ? manager.getRepository(PurchaseInvoiceItemEntity) : this.itemRepo;

		const exists = await repo.findOne({ where: { adminId, receiptNumber: dto.receiptNumber } as any });
		if (exists) throw new BadRequestException("receiptNumber already exists");

		if (dto.supplierId) {
			const supplier = await this.supplierRepo.findOne({ where: { id: dto.supplierId } as any });
			if (!supplier) throw new BadRequestException("supplier not found");
		}

		const items = (dto.items || []).map((it) => {
			const lineSubtotal = it.purchaseCost * it.quantity;
			const lineTotal = lineSubtotal;

			return itemRepo.create({
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
		const remainingAmount = total - paidAmount;

		const inv = repo.create({
			adminId,
			supplierId: dto.supplierId ?? null,
			receiptNumber: dto.receiptNumber,
			receiptAsset: dto.receiptAsset ?? null,
			safeId: dto.safeId ?? null,
			paidAmount,
			subtotal,
			total,
			remainingAmount,
			status: ApprovalStatus.PENDING,
			notes: dto.notes ?? null,
			items,
		} as any);

		const saved: any = await repo.save(inv);


		await this.log({
			adminId,
			invoiceId: saved.id,
			userId: me?.id ?? null,
			action: PurchaseAuditAction.CREATED,
			newData: { id: saved.id, status: saved.status },
			description: `Purchase invoice created (status: ${saved.status})`,
			ipAddress,
			manager
		});

		return saved;
	}

	async update(me: any, id: string, dto: UpdatePurchaseDto, ipAddress?: string) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const inv = await this.get(me, id);
		if (inv.closingId) {
			throw new BadRequestException("Cannot update a purchase that has been closed.");
		}
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

		// Save old values for financial sync
		const oldTotal = inv.total ?? 0;
		const oldRemaining = inv.remainingAmount ?? 0;
		const oldSupplierId = inv.supplierId;
		const oldStatus = inv.status;

		if (dto.receiptNumber && dto.receiptNumber !== inv.receiptNumber) {
			const exists = await this.invRepo.findOne({ where: { adminId, receiptNumber: dto.receiptNumber } as any });
			if (exists) throw new BadRequestException("receiptNumber already exists");
		}

		if (inv.status === ApprovalStatus.ACCEPTED && dto.items) {
			throw new BadRequestException("Cannot modify items of an ACCEPTED purchase. Change status first.");
		}

		let saved;
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
			const remainingAmount = total - paidAmount;

			Object.assign(inv as any, dto, { subtotal, total, paidAmount, remainingAmount, items });
			saved = await this.invRepo.save(inv as any);
		} else {
			Object.assign(inv as any, dto);
			if (typeof dto.paidAmount === "number") {
				(inv as any).remainingAmount = ((inv as any).total ?? 0) - dto.paidAmount;
			}
			saved = await this.invRepo.save(inv as any);
		}

		// --- Sync supplier financials only if status is ACCEPTED ---
		const newSupplierId = saved.supplierId;
		const newStatus = saved.status;
		await this.syncSupplierFinancials({
			oldStatus: oldStatus,
			newStatus: saved.status,
			oldSupplierId: oldSupplierId,
			newSupplierId: saved.supplierId,
			total: saved.total ?? 0,
			remainingAmount: saved.remainingAmount ?? 0,
		});


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

	async updatePaidAmount(me: any, id: string, dto: UpdatePaidAmountDto, ipAddress?: string) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const inv = await this.get(me, id);
		if (inv.closingId) {
			throw new BadRequestException("Cannot update a purchase that has been closed.");
		}

		const total = (inv as any).total ?? 0;
		const oldRemaining = inv.remainingAmount ?? 0;
		const oldStatus = inv.status;
		(inv as any).paidAmount = dto.paidAmount;
		(inv as any).remainingAmount = total - dto.paidAmount;

		const saved = await this.invRepo.save(inv as any);

		// Only update supplier financials if status is ACCEPTED
		if (oldStatus === ApprovalStatus.ACCEPTED) {
			// Remove old value
			await this.syncSupplierFinancials({
				oldStatus: ApprovalStatus.ACCEPTED,
				newStatus: ApprovalStatus.ACCEPTED,
				oldSupplierId: inv.supplierId,
				newSupplierId: inv.supplierId,
				total: 0, // Keep purchaseValue stable
				remainingAmount: saved.remainingAmount - oldRemaining,
			});
		}

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

	async updateStatus(me: any, id: string, status: ApprovalStatus, ipAddress?: string) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const inv = await this.get(me, id);
		if (inv.closingId) {
			throw new BadRequestException("Cannot update a purchase that has been closed.");
		}

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
				const byVariant = new Map<string, { qty: number; incomingCostTotal: number }>();

				for (const it of inv.items ?? []) {
					const vid = it.variantId;
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

				const byId = new Map<string, ProductVariantEntity>();
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
					manager
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
						manager
					});
				}
			}

			// =========================================================
			// 2) IF leaving ACCEPTED:
			//    - remove stock (for both pending/rejected)
			//    - rollback price for BOTH pending/rejected
			// =========================================================
			if (oldStatus === ApprovalStatus.ACCEPTED && status !== ApprovalStatus.ACCEPTED) {
				const byVariant = new Map<string, number>();

				for (const it of inv.items ?? []) {
					const vid = it.variantId;
					const qty = Number(it.quantity) || 0;
					byVariant.set(vid, (byVariant.get(vid) ?? 0) + qty);
				}

				const variantIds = [...byVariant.keys()];
				if (variantIds.length) {
					const variants = await manager.find(ProductVariantEntity, {
						where: { adminId, id: In(variantIds) } as any,
					});

					const byId = new Map<string, ProductVariantEntity>();
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
								...new Set(priceChanges.map((x: any) => x.variantId).filter(Boolean)),
							];

							const priceVariants = await manager.find(ProductVariantEntity, {
								where: { adminId, id: In(priceVariantIds) } as any,
							});

							const pvById = new Map<string, ProductVariantEntity>();
							for (const v of priceVariants) pvById.set(v.id, v);

							const touched: ProductVariantEntity[] = [];

							for (const ch of priceChanges) {
								const vid = ch.variantId;
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
				manager
			});


			await this.syncSupplierFinancials({
				oldStatus: oldStatus,
				newStatus: status,
				oldSupplierId: inv.supplierId,
				newSupplierId: inv.supplierId, // Supplier doesn't change on status update
				total: inv.total ?? 0,
				remainingAmount: inv.remainingAmount ?? 0,
				manager
			});
			return saved;
		});
	}


	async remove(me: any, id: string, ipAddress?: string) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const inv = await this.get(me, id);

		if (inv.closingId) {
			throw new BadRequestException("Cannot delete a purchase that has been closed.");
		}

		// Rollback supplier financials if invoice was ACCEPTED before deletion
		if (inv.status === ApprovalStatus.ACCEPTED) {
			await this.syncSupplierFinancials({
				oldStatus: inv.status,
				newStatus: undefined, // It's being deleted
				oldSupplierId: inv.supplierId,
				newSupplierId: null,
				total: inv.total ?? 0,
				remainingAmount: inv.remainingAmount ?? 0,
			});
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

	/**
	 * Sync supplier financials based on invoice status transition.
	 * Handles:
	 * - entering ACCEPTED  → add values
	 * - leaving ACCEPTED   → subtract values
	 * - supplier change    → subtract from old + add to new
	 * - delete             → subtract if was ACCEPTED
	 */
	private async syncSupplierFinancials(params: {
		oldStatus?: ApprovalStatus;
		newStatus?: ApprovalStatus;
		oldSupplierId?: string | null;
		newSupplierId?: string | null;
		total: number;
		remainingAmount: number;
		manager?: EntityManager;
	}) {
		const {
			oldStatus,
			newStatus,
			oldSupplierId,
			newSupplierId,
			total,
			remainingAmount,
		} = params;

		const wasAccepted = oldStatus === ApprovalStatus.ACCEPTED;
		const isAccepted = newStatus === ApprovalStatus.ACCEPTED;
		const repo = params?.manager ? params?.manager.getRepository(SupplierEntity) : this.supplierRepo;
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

			if (op === "add") {
				supplier.purchaseValue = Number(currentPurchase) + Number(total);
				supplier.dueBalance = Number(currentDue) + Number(remainingAmount);
			} else {
				supplier.purchaseValue = Number(currentPurchase) - Number(total);
				supplier.dueBalance = Number(currentDue) - Number(remainingAmount);
			}

			await repo.save(supplier);
		};

		// CASE 1: entering ACCEPTED
		if (!wasAccepted && isAccepted) {
			await updateSupplier(newSupplierId, "add");
		}

		// CASE 2: leaving ACCEPTED
		if (wasAccepted && !isAccepted) {
			await updateSupplier(oldSupplierId, "subtract");
		}

		// CASE 3: supplier changed while ACCEPTED
		if (
			wasAccepted &&
			isAccepted &&
			oldSupplierId &&
			newSupplierId &&
			oldSupplierId !== newSupplierId
		) {
			await updateSupplier(oldSupplierId, "subtract");
			await updateSupplier(newSupplierId, "add");
		}
	}

	async exportPurchases(me: any, q?: any) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException("Missing adminId");

		const search = String(q?.search ?? "").trim();
		const supplierId = q?.supplierId && q.supplierId !== "all" ? q.supplierId : null;
		const status = q?.status && q.status !== "all" ? String(q.status) : null;
		const startDate = q?.startDate ? String(q.startDate) : null;
		const endDate = q?.endDate ? String(q.endDate) : null;
		const hasReceipt = q?.hasReceipt && q.hasReceipt !== "all" ? String(q.hasReceipt) : null;

		const qb = this.invRepo
			.createQueryBuilder("inv")
			.where("inv.adminId = :adminId", { adminId })
			.leftJoinAndSelect("inv.supplier", "supplier");

		if (supplierId && supplierId != 'none')
			qb.andWhere("inv.supplierId = :supplierId", { supplierId });
		else if (supplierId === 'none') {
			qb.andWhere("inv.supplierId IS NULL");
		}

		if (status) qb.andWhere("inv.status = :status", { status });

		if (hasReceipt === "yes") qb.andWhere("inv.receiptAsset IS NOT NULL");
		if (hasReceipt === "no") qb.andWhere("inv.receiptAsset IS NULL");

		DateFilterUtil.applyToQueryBuilder(qb, "inv.created_at", startDate, endDate);

		if (search) {
			qb.andWhere(
				"(inv.receiptNumber ILIKE :s OR supplier.name ILIKE :s)",
				{ s: `%${search}%` }
			);
		}

		qb.orderBy("inv.created_at", (q?.sortOrder ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC");

		const records = await qb.getMany();

		const workbook = new ExcelJS.Workbook();
		const worksheet = workbook.addWorksheet("Purchases");

		worksheet.columns = [
			{ header: "ID", key: "id", width: 10 },
			{ header: "Supplier", key: "supplier", width: 25 },
			{ header: "Receipt #", key: "receiptNumber", width: 20 },
			{ header: "Status", key: "status", width: 15 },
			{ header: "Subtotal", key: "subtotal", width: 15 },
			{ header: "Total", key: "total", width: 15 },
			{ header: "Paid Amount", key: "paidAmount", width: 15 },
			{ header: "Remaining Amount", key: "remainingAmount", width: 15 },
			{ header: "Created At", key: "created_at", width: 18 },
		];

		worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
		worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6C5CE7" } };

		records.forEach((inv) => {
			worksheet.addRow({
				id: inv.id,
				supplier: inv.supplier?.name ?? "N/A",
				receiptNumber: inv.receiptNumber,
				status: inv.status,
				subtotal: inv.subtotal,
				total: inv.total,
				paidAmount: inv.paidAmount,
				remainingAmount: inv.remainingAmount,
				created_at: inv.created_at ? new Date(inv.created_at).toLocaleDateString("en-US") : "",
			});
		});

		return await workbook.xlsx.writeBuffer();
	}
}




