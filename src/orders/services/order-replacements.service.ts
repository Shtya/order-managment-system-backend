import { OrderEntity, OrderReplacementEntity, OrderReplacementItemEntity, OrderStatus } from "entities/order.entity";
import { OrdersService, tenantId } from "./orders.service";
import { Brackets, DataSource, Repository } from "typeorm";
import { BadRequestException, forwardRef, Inject, Injectable } from "@nestjs/common";
import { CreateOrderDto, CreateReplacementDto } from "dto/order.dto";
import * as ExcelJS from "exceljs";
import { DateFilterUtil } from "common/date-filter.util";
import { InjectRepository } from "@nestjs/typeorm";
import { NotificationService } from "src/notifications/notification.service";
import { NotificationType } from "entities/notifications.entity";
import { RequestTranslationService, TranslationService } from "common/translation.service";

@Injectable()
export class OrderReplacementService {
    constructor(
        private dataSource: DataSource,
        @InjectRepository(OrderReplacementEntity)
        private readonly replacementRepo: Repository<OrderReplacementEntity>,
        @InjectRepository(OrderEntity)
        private readonly orderRepo: Repository<OrderEntity>,
        private readonly ordersService: OrdersService, // Inject the main service
        private readonly notificationService: NotificationService,
        private readonly translations: TranslationService,
        private readonly requestTranslations: RequestTranslationService,
    ) { }

    // ========================================
    // ✅ LIST REPLACEMENTS
    // ========================================
    async listReplacements(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

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
        DateFilterUtil.applyToQueryBuilder(qb, "replacement.createdAt", q?.startDate, q?.endDate);

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
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

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
                ?.map(i => {
                    const qty = i.originalOrderItem?.quantity ?? 0;
                    return `${i.originalOrderItem?.variant?.product?.name || "N/A"} (${i.originalOrderItem?.variant?.sku || ""}) x ${qty}`;
                })
                .join(" | ");

            const originalSKUs = rep.items
                ?.map(i => i.originalOrderItem?.variant?.sku || "N/A")
                .join(" | ");

            // Extract New Data from the replacement items link
            const newProductNames = rep.items
                ?.map(i => {
                    const qty = i.quantityToReplace ?? 0;
                    return `${i.newVariant?.product?.name || "N/A"} (${i.newVariant?.sku || ""}) x ${qty}`;
                })
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
        const worksheet = workbook.addWorksheet(this.translations.t("domains.orders.replacement.export.worksheet_name"));

        worksheet.columns = [
            { header: this.translations.t("domains.orders.replacement.export.replacement_order"), key: "replacementOrderNumber", width: 15 },
            { header: this.translations.t("domains.orders.replacement.export.original_order"), key: "originalOrderNumber", width: 15 },
            { header: this.translations.t("domains.orders.replacement.export.customer"), key: "customerName", width: 20 },
            { header: this.translations.t("domains.orders.replacement.export.phone"), key: "phoneNumber", width: 15 },
            { header: this.translations.t("domains.orders.replacement.export.original_items"), key: "originalProducts", width: 35 },
            { header: this.translations.t("domains.orders.replacement.export.replacement_items"), key: "newProducts", width: 35 },
            { header: this.translations.t("domains.orders.replacement.export.cost_diff"), key: "costDiff", width: 12 },
            { header: this.translations.t("domains.orders.replacement.export.status"), key: "status", width: 15 },
            { header: this.translations.t("domains.orders.replacement.export.date"), key: "createdAt", width: 20 },
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
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        return this.dataSource.transaction(async (manager) => {
            // 1️⃣ Get original order
            const originalOrder = await manager.findOne(OrderEntity, {
                where: { id: dto.originalOrderId, adminId },
                relations: ['items', 'items.variant', "replacementRequest"],
            });

            if (originalOrder.replacementRequest) {
                throw new BadRequestException(this.translations.t('domains.orders.replacement.already_has_replacement'));
            }

            if (!originalOrder) throw new BadRequestException(this.translations.t('domains.orders.replacement.original_order_not_found'));

            // 2️⃣ Validation: ensure all originalOrderItemIds exist and are unique
            const originalItemIds = originalOrder.items.map(i => i.id);
            const requestedItemIds = dto.items.map(i => i.originalOrderItemId);

            // Check duplicates in request
            const duplicates = requestedItemIds.filter((id, idx) => requestedItemIds.indexOf(id) !== idx);
            if (duplicates.length > 0) {
                throw new BadRequestException(this.translations.t('domains.orders.replacement.duplicate_products'));
            }

            // Check all exist in original order
            const invalidIds = requestedItemIds.filter(id => !originalItemIds.includes(id));
            if (invalidIds.length > 0) {
                throw new BadRequestException(this.translations.t('domains.orders.replacement.invalid_products'));
            }

            // Use deposit from frontend (refund amount when old items cost more than new items)
            const deposit = dto.deposit ?? 0;

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
                    returnQuantity: it.returnQuantity,
                })),
            });

            newOrder.isReplacement = true;
            await manager.save(OrderEntity, newOrder);
            await manager.save(OrderReplacementEntity, replacement);

            await this.notificationService.create({
                userId: adminId,
                type: NotificationType.REPLACEMENT_CREATED,
                title: await this.requestTranslations.tAsync('domains.orders.replacement.notification_title', adminId),
                message: await this.requestTranslations.tAsync('domains.orders.replacement.notification_message', adminId, { args: { replacementOrderNumber: newOrder.orderNumber, originalOrderNumber: originalOrder.orderNumber } }),
                relatedEntityType: "order",
                relatedEntityId: String(newOrder.id),
            });

            return {
                replacement,
                newOrder,
            };
        });
    }

    // ========================================
    // ✅ STATS
    // ========================================
    async getStats(me: any) {
        const adminId = tenantId(me);
        if (!adminId) {
            throw new BadRequestException(
                this.translations.t('common.missing_admin_id'),
            );
        }

        const result = await this.orderRepo
            .createQueryBuilder('order')
            .leftJoin('order.status', 'status')
            .leftJoin('order.replacementRequest', 'replacement')
            .select('COUNT(order.id)', 'totalDelivered')
            .addSelect(
                'COUNT(replacement.id)',
                'replaced',
            )
            .where('order.adminId = :adminId', { adminId })
            .andWhere('status.code = :status', {
                status: OrderStatus.DELIVERED,
            })
            .getRawOne();

        const totalDelivered = Number(result?.totalDelivered ?? 0);
        const replaced = Number(result?.replaced ?? 0);

        return {
            totalDelivered,
            replaced,
            notReplaced: totalDelivered - replaced,
        };
    }
}