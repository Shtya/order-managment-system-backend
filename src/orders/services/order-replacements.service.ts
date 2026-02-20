import { OrderEntity, OrderReplacementEntity, OrderReplacementItemEntity } from "entities/order.entity";
import { OrdersService, tenantId } from "./orders.service";
import { Brackets, DataSource, Repository } from "typeorm";
import { BadRequestException, forwardRef, Inject, Injectable } from "@nestjs/common";
import { CreateOrderDto, CreateReplacementDto } from "dto/order.dto";
import * as ExcelJS from "exceljs";
import { InjectRepository } from "@nestjs/typeorm";

@Injectable()
export class OrderReplacementService {
    constructor(
        private dataSource: DataSource,
        @InjectRepository(OrderReplacementEntity)
        private readonly replacementRepo: Repository<OrderReplacementEntity>,
        private readonly ordersService: OrdersService, // Inject the main service
    ) { }

    // ========================================
    // ✅ LIST REPLACEMENTS
    // ========================================
    async listReplacements(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();

        const sortBy = String(q?.sortBy ?? "createdAt");
        const sortDir: "ASC" | "DESC" =
            String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

        const qb = this.replacementRepo
            .createQueryBuilder("replacement")

            // Original Order
            // 1. Original Order (Just ID and OrderNumber)
            .leftJoin("replacement.originalOrder", "originalOrder")
            .addSelect(["originalOrder.id", "originalOrder.orderNumber", "originalOrder.shippingCost", "originalOrder.finalTotal"])

            // 2. Replacement Items
            .leftJoinAndSelect("replacement.items", "replacementItems")

            // 3. New Variant + Product Data (Replacement Side)
            .leftJoin("replacementItems.newVariant", "newVar")
            .leftJoin("newVar.product", "newProd")
            .addSelect([
                "newVar.id",
                "newVar.sku",
                "newProd.id",
                "newProd.name",
                "newProd.mainImage"
            ])

            // 4. Original Order Item + Variant + Product Data (Original Side)
            .leftJoin("replacementItems.originalOrderItem", "origItem")
            .leftJoin("origItem.variant", "origVar")
            .leftJoin("origVar.product", "origProd")
            .addSelect([
                "origItem.id",
                "origItem.quantity",
                "origVar.id",
                "origVar.sku",
                "origProd.id",
                "origProd.name",
                "origProd.mainImage"
            ])

            // Replacement Order
            .leftJoinAndSelect("replacement.replacementOrder", "replacementOrder")
            .leftJoinAndSelect("replacementOrder.status", "replacementStatus")
            // Shipping
            .leftJoinAndSelect("replacement.shippingCompany", "shippingCompany")

            .where("originalOrder.adminId = :adminId", { adminId });

        // =============================
        // 🔎 SEARCH
        // =============================
        if (search) {
            qb.andWhere(
                new Brackets((sq) => {
                    sq.where("originalOrder.orderNumber ILIKE :s", { s: `%${search}%` })
                        .orWhere("replacementOrder.orderNumber ILIKE :s", { s: `%${search}%` })
                        .orWhere("originalOrder.customerName ILIKE :s", { s: `%${search}%` })
                        .orWhere("originalOrder.phoneNumber ILIKE :s", { s: `%${search}%` });
                }),
            );
        }

        // =============================
        // 🔄 SORTING
        // =============================
        const sortColumns: Record<string, string> = {
            createdAt: "replacement.createdAt",
            originalOrderNumber: "originalOrder.orderNumber",
            replacementOrderNumber: "replacementOrder.orderNumber",
        };

        if (sortColumns[sortBy]) {
            qb.orderBy(sortColumns[sortBy], sortDir);
        } else {
            qb.orderBy("replacement.createdAt", "DESC");
        }

        // =============================
        // 📅 Date filters (replacement createdAt)
        // =============================
        if (q?.startDate)
            qb.andWhere("replacement.createdAt >= :startDate", { startDate: `${q.startDate}T00:00:00.000Z` });

        if (q?.endDate)
            qb.andWhere("replacement.createdAt <= :endDate", { endDate: `${q.endDate}T23:59:59.999Z` });

        // =============================
        // ✅ Status filter (replacement order status)
        // =============================
        if (q?.status) {
            const statusParam = q.status;
            if (!isNaN(Number(statusParam))) {
                qb.andWhere("replacementOrder.statusId = :statusId", { statusId: Number(statusParam) });
            } else {
                qb.andWhere("replacementStatus.code = :statusCode", { statusCode: String(statusParam).trim() });
            }
        }

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

    async exportReplacements(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const search = String(q?.search ?? "").trim();

        const qb = this.replacementRepo
            .createQueryBuilder("replacement")
            // Join the direct replacement items (the link between old and new)
            .leftJoinAndSelect("replacement.items", "repItems")
            .leftJoinAndSelect("repItems.originalOrderItem", "origOrderItem")
            .leftJoinAndSelect("origOrderItem.variant", "origVar")
            .leftJoinAndSelect("origVar.product", "origProd")
            .leftJoinAndSelect("repItems.newVariant", "newVar")
            .leftJoinAndSelect("newVar.product", "newProd")

            // Core Order Relationships
            .leftJoinAndSelect("replacement.originalOrder", "originalOrder")
            .leftJoinAndSelect("replacement.replacementOrder", "replacementOrder")
            .leftJoinAndSelect("replacementOrder.status", "replacementStatus")
            .leftJoinAndSelect("replacement.shippingCompany", "shippingCompany")
            .where("originalOrder.adminId = :adminId", { adminId });

        // ... [Keep your existing Search and Date filters here] ...

        qb.orderBy("replacement.createdAt", "DESC");
        const replacements = await qb.getMany();

        // =============================
        // 📦 Prepare Excel Data
        // =============================
        const exportData = replacements.map((rep) => {
            // Extract Original Data from the replacement items link
            const originalProductNames = rep.items
                ?.map(i => `${i.originalOrderItem?.variant?.product?.name || "N/A"} (${i.originalOrderItem?.variant?.sku || ""})`)
                .join(" | ");

            const originalSKUs = rep.items
                ?.map(i => i.originalOrderItem?.variant?.sku || "N/A")
                .join(" | ");

            // Extract New Data from the replacement items link
            const newProductNames = rep.items
                ?.map(i => `${i.newVariant?.product?.name || "N/A"} (${i.newVariant?.sku || ""})`)
                .join(" | ");

            const newSKUs = rep.items
                ?.map(i => i.newVariant?.sku || "N/A")
                .join(" | ");

            const diff = (rep.originalOrder.finalTotal - rep.originalOrder.shippingCost) - rep.replacementOrder.finalTotal;

            return {
                replacementOrderNumber: rep.replacementOrder?.orderNumber || "—",
                originalOrderNumber: rep.originalOrder?.orderNumber || "—",
                customerName: rep.replacementOrder?.customerName || rep.originalOrder?.customerName || "—",
                phoneNumber: rep.replacementOrder?.phoneNumber || rep.originalOrder?.phoneNumber || "—",
                // Products Broken Down
                originalProducts: originalProductNames,
                originalSKUs: originalSKUs,
                newProducts: newProductNames,
                newSKUs: newSKUs,
                // Financials
                costDiff: diff === 0 ? "0" : diff > 0 ? `+${diff}` : `${diff}`,
                status: rep.replacementOrder?.status?.name || rep.replacementOrder?.status?.code || "—",
                createdAt: rep.createdAt ? new Date(rep.createdAt).toLocaleString() : "—",
            };
        });

        // =============================
        // 📊 Excel Generation
        // =============================
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Replacements");

        worksheet.columns = [
            { header: "Replacement #", key: "replacementOrderNumber", width: 15 },
            { header: "Original #", key: "originalOrderNumber", width: 15 },
            { header: "Customer", key: "customerName", width: 20 },
            { header: "Phone", key: "phoneNumber", width: 15 },
            { header: "Original Items", key: "originalProducts", width: 35 },
            { header: "Replacement Items", key: "newProducts", width: 35 },
            { header: "Cost Diff", key: "costDiff", width: 12 },
            { header: "Status", key: "status", width: 15 },
            { header: "Date", key: "createdAt", width: 20 },
        ];

        // Header Styling
        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF6C5CE7" }, // Using your primary purple color
        };

        exportData.forEach((row) => worksheet.addRow(row));

        return await workbook.xlsx.writeBuffer();
    }


    async replaceOrder(me: any, dto: CreateReplacementDto, ipAddress?: string) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        return this.dataSource.transaction(async (manager) => {
            // 1️⃣ Get original order
            const originalOrder = await manager.findOne(OrderEntity, {
                where: { id: dto.originalOrderId, adminId },
                relations: ['items', 'items.variant', "replacementRequest"],
            });

            if (originalOrder.replacementRequest) {
                throw new BadRequestException(`This order already has a replacement and cannot be replaced again`);
            }

            if (!originalOrder) throw new BadRequestException('Original order not found');

            // 2️⃣ Validation: ensure all originalOrderItemIds exist and are unique
            const originalItemIds = originalOrder.items.map(i => i.id);
            const requestedItemIds = dto.items.map(i => i.originalOrderItemId);

            // Check duplicates in request
            const duplicates = requestedItemIds.filter((id, idx) => requestedItemIds.indexOf(id) !== idx);
            if (duplicates.length > 0) {
                throw new BadRequestException(`Duplicate products in replace request`);
            }

            // Check all exist in original order
            const invalidIds = requestedItemIds.filter(id => !originalItemIds.includes(id));
            if (invalidIds.length > 0) {
                throw new BadRequestException(`Some products doesn't included at original order`);
            }

            // Calculate deposit from ORIGINAL items being replaced
            let deposit = 0;

            for (const item of dto.items) {
                const originalItem = originalOrder.items.find(
                    (oi) => oi.id === item.originalOrderItemId,
                )!;

                // if want to prevent repalce to has aditional items
                // if (item.quantityToReplace > originalItem.quantity) {
                //   throw new BadRequestException(
                //     `Quantity to replace exceeds original quantity for item ${originalItem.id}`,
                //   );
                // }

                deposit += originalItem.unitPrice * item.quantityToReplace;
            }

            // 2️⃣ Create new order based on items in dto
            const createOrderDto: CreateOrderDto = {
                customerName: originalOrder.customerName,
                phoneNumber: originalOrder.phoneNumber,
                email: originalOrder.email,
                address: originalOrder.address,
                city: originalOrder.city,
                area: originalOrder.area,
                landmark: originalOrder.landmark,
                deposit: deposit,
                paymentMethod: dto.paymentMethod,
                shippingCompanyId: dto.shippingCompanyId?.toString(),
                storeId: originalOrder.storeId?.toString(),
                shippingCost: dto.shippingCost,
                discount: dto.discount,
                notes: dto.internalNotes,
                customerNotes: dto.customerNotes,
                items: dto.items.map((it) => ({
                    variantId: it.newVariantId,
                    quantity: it.quantityToReplace,
                    unitPrice: it.newUnitPrice,
                    unitCost: 0,
                })),
            };

            const newOrder = await this.ordersService.createWithManager(manager, adminId, me, createOrderDto, ipAddress);


            // 3️⃣ Create OrderReplacementEntity
            const replacement = manager.create(OrderReplacementEntity, {
                originalOrderId: dto.originalOrderId,
                replacementOrderId: newOrder.id,
                reason: dto.reason,
                anotherReason: dto.anotherReason,
                internalNotes: dto.internalNotes,
                returnImages: dto.returnImages || [],
                shippingCompanyId: dto.shippingCompanyId,
                items: dto.items.map((it) => manager.create(OrderReplacementItemEntity, {
                    originalOrderItemId: it.originalOrderItemId,
                    newVariantId: it.newVariantId,
                    quantityToReplace: it.quantityToReplace,
                })),
            });

            await manager.save(OrderReplacementEntity, replacement);

            return {
                replacement,
                newOrder,
            };
        });
    }
}