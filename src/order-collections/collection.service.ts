// collection.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CreateOrderCollectionDto } from 'dto/order-collection.dto';
import { OrderCollectionEntity } from 'entities/order-collection.entity';
import { OrderEntity } from 'entities/order.entity';
import { ShippingIntegrationEntity } from 'entities/shipping.entity';
import { tenantId } from 'src/category/category.service';
import { Brackets, DataSource, Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';

@Injectable()
export class CollectionService {
    constructor(
        private dataSource: DataSource,
        @InjectRepository(OrderCollectionEntity)
        private readonly repo: Repository<OrderCollectionEntity>,

        @InjectRepository(OrderEntity)
        private readonly ordersRepo: Repository<OrderEntity>,

        @InjectRepository(ShippingIntegrationEntity)
        private readonly shippingRepo: Repository<ShippingIntegrationEntity>,
    ) { }

    // collection.service.ts

    async getCollectionStatistics(adminId: string) {
        // shipping breakdown unchanged
        const shippingBreakdown = await this.repo
            .createQueryBuilder('col')
            .leftJoin('col.shippingCompany', 'ship')
            .select('COALESCE(ship.name, \'Direct/Other\')', 'shippingName')
            .addSelect('SUM(col.amount)', 'totalAmount')
            .where('col.adminId = :adminId', { adminId })
            .groupBy('ship.id')
            .addGroupBy('ship.name')
            .getRawMany();

        // counts directly from orders.collectedAmount vs finalTotal
        const result = await this.ordersRepo
            .createQueryBuilder('o')
            .select(`
                SUM(CASE WHEN COALESCE(o.collectedAmount,0) = 0 THEN 1 ELSE 0 END) AS "notCollectedCount",
                SUM(CASE WHEN COALESCE(o.collectedAmount,0) > 0 AND COALESCE(o.collectedAmount,0) < o.finalTotal THEN 1 ELSE 0 END) AS "partialCollectedCount",
                SUM(CASE WHEN COALESCE(o.collectedAmount,0) >= o.finalTotal THEN 1 ELSE 0 END) AS "fullyCollectedCount"
            `)
            .where('o.adminId = :adminId', { adminId })
            .getRawOne();

        const stats = {
            notCollectedCount: Number(result?.notCollectedCount) || 0,
            partialCollectedCount: Number(result?.partialCollectedCount) || 0,
            fullyCollectedCount: Number(result?.fullyCollectedCount) || 0,
            shippingBreakdown: shippingBreakdown.map(s => ({
                name: s.shippingName || 'Direct/Other',
                amount: parseFloat(s.totalAmount)
            }))
        };

        return stats;
    }

    async addCollection(adminId: string, dto: CreateOrderCollectionDto) {
        // validate order exists — but do this inside transaction to lock it
        return await this.dataSource.transaction(async (manager) => {
            // 1. Lock the order row
            const order = await manager.findOne(OrderEntity, {
                where: { id: dto.orderId },
            });

            if (!order) {
                throw new NotFoundException(`Order #${dto.orderId} not found`);
            }

            const shippingIntegration = await manager.findOne(ShippingIntegrationEntity, {
                where: { shippingCompanyId: dto.shippingCompanyId },
            });

            if (!shippingIntegration) {
                throw new NotFoundException(`You must integrate with the shipping company before assigning it to collections`);
            }

            // 2. create collection
            const collection = manager.create(OrderCollectionEntity, {
                adminId,
                orderId: dto.orderId,
                amount: dto.amount,
                currency: (dto.currency?.trim() || "EGP").toUpperCase(),
                source: dto.source,
                notes: dto.notes?.trim(),
                collectedAt: new Date(),
                shippingCompanyId: dto.shippingCompanyId ? dto.shippingCompanyId : null,
            });

            const saved = await manager.save(collection);

            // 3. update order.collectedAmount atomically
            order.collectedAmount = (order.collectedAmount || 0) + Number(dto.amount);
            await manager.save(order);

            // 4. return saved (optionally return order too)
            return saved;
        });
    }

    async listCollections(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();

        // Sort by order creation or custom field
        const sortBy = String(q?.sortBy ?? "created_at");
        const sortDir: "ASC" | "DESC" = String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

        // Primary query is now on OrderEntity
        const qb = this.ordersRepo.createQueryBuilder("order")
            .leftJoinAndSelect("order.collections", "col") // Ensure OrderEntity has @OneToMany to OrderCollectionEntity
            .leftJoinAndSelect("order.shippingCompany", "shipping")
            .where("order.adminId = :adminId", { adminId });

        // --- 1. Filter by Shipping Company (From Order Entity) ---
        if (q?.shippingCompanyId) {
            qb.andWhere("order.shippingCompanyId = :shippingId", { shippingId: Number(q.shippingCompanyId) });
        }

        // --- 2. Collection Status Logic ---
        if (q?.collectionStatus) {
            const amt = "COALESCE(order.collectedAmount, 0)";
            if (q.collectionStatus === 'not_collected') qb.andWhere(`${amt} = 0`);
            else if (q.collectionStatus === 'partial') qb.andWhere(`${amt} > 0 AND ${amt} < order.finalTotal`);
            else if (q.collectionStatus === 'fully_collected') qb.andWhere(`${amt} >= order.finalTotal`);
            else if (q.collectionStatus === 'pending') qb.andWhere(`${amt} < order.finalTotal`);
        }

        // --- 3. Search (Order Number / Customer / Phone) ---
        if (search) {
            qb.andWhere(new Brackets((sq) => {
                sq.where("order.orderNumber ILIKE :s", { s: `%${search}%` })
                    .orWhere("order.customerName ILIKE :s", { s: `%${search}%` })
                    .orWhere("order.phoneNumber ILIKE :s", { s: `%${search}%` });
            }));
        }

        // --- 4. Date Range (Based on Order Creation or Delivery) ---
        if (q?.startDate) qb.andWhere("order.created_at >= :startDate", { startDate: `${q.startDate}T00:00:00.000Z` });
        if (q?.endDate) qb.andWhere("order.created_at <= :endDate", { endDate: `${q.endDate}T23:59:59.999Z` });

        qb.orderBy(`order.${sortBy}`, sortDir);

        const [orders, total] = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getManyAndCount();

        // --- 5. Data Mapping & Delay Calculation ---
        const records = orders.map(order => {
            const isFullyCollected = order.collectedAmount >= order.finalTotal;

            // Calculate Delay Days: Difference between Delivery Date and Last Collection Date
            let delayDays = 0;
            if (isFullyCollected && order.deliveredAt && order.collections?.length > 0) {
                // Get the date of the very last payment
                const lastCollection = order.collections.reduce((prev, current) =>
                    (prev.collectedAt > current.collectedAt) ? prev : current
                );

                const start = new Date(order.deliveredAt);
                const end = new Date(lastCollection.collectedAt);
                const diffTime = end.getTime() - start.getTime();
                delayDays = Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
            }

            return {
                orderNumber: order.orderNumber,
                deliveredAt: order.deliveredAt, // تاریخ التوصيل
                shippingCompany: order.shippingCompany || 'N/A',
                shippingCost: order.shippingCost,
                finalTotal: order.finalTotal,
                collectedAmount: order.collectedAmount || 0,
                remainingBalance: Math.max(0, order.finalTotal - (order.collectedAmount || 0)),
                delayDays: delayDays, // عدد أيام التأخير
                collections: order.collections // Optional: include full history
            };
        });

        return {
            total_records: total,
            current_page: page,
            per_page: limit,
            records
        };
    }

    async exportCollections(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const search = String(q?.search ?? "").trim();

        // Primary query is now on OrderEntity to get the full picture
        const qb = this.ordersRepo.createQueryBuilder("order")
            .leftJoinAndSelect("order.collections", "col")
            .leftJoinAndSelect("order.shippingCompany", "shipping")
            .where("order.adminId = :adminId", { adminId });

        // --- 1. Apply Filters (Same as list method) ---
        if (q?.shippingCompanyId) {
            qb.andWhere("order.shippingCompanyId = :shippingId", { shippingId: Number(q.shippingCompanyId) });
        }

        if (q?.collectionStatus) {
            const amt = "COALESCE(order.collectedAmount, 0)";
            if (q.collectionStatus === 'not_collected') qb.andWhere(`${amt} = 0`);
            else if (q.collectionStatus === 'partial') qb.andWhere(`${amt} > 0 AND ${amt} < order.finalTotal`);
            else if (q.collectionStatus === 'fully_collected') qb.andWhere(`${amt} >= order.finalTotal`);
            else if (q.collectionStatus === 'pending') qb.andWhere(`${amt} < order.finalTotal`);
        }

        if (search) {
            qb.andWhere(new Brackets((sq) => {
                sq.where("order.orderNumber ILIKE :s", { s: `%${search}%` })
                    .orWhere("order.customerName ILIKE :s", { s: `%${search}%` });
            }));
        }

        const orders = await qb.orderBy("order.created_at", "DESC").getMany();

        // --- 2. Transform Data for Excel ---
        const exportData = orders.map((order) => {
            const total = Number(order.finalTotal || 0);
            const collected = Number(order.collectedAmount || 0);
            const remaining = Math.max(0, total - collected);
            const isFullyCollected = collected >= total && total > 0;

            // Collection Status Logic
            let status = 'Not Collected';
            if (isFullyCollected) status = 'Fully Collected';
            else if (collected > 0) status = 'Partial';

            // Calculate Delay Days (Difference between Delivery and Last Payment)
            let delayDays = 0;
            if (isFullyCollected && order.deliveredAt && order.collections?.length > 0) {
                const lastPayment = order.collections.reduce((prev, curr) =>
                    (prev.collectedAt > curr.collectedAt) ? prev : curr
                );
                const start = new Date(order.deliveredAt);
                const end = new Date(lastPayment.collectedAt);
                delayDays = Math.max(0, Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
            }

            // Get unique collection methods used
            const methods = [...new Set(order.collections?.map(c => c.source))].join(", ") || "N/A";

            return {
                orderNumber: order.orderNumber || 'N/A',
                shippingCompany: order.shippingCompany?.name || 'N/A',
                deliveredDate: order.deliveredAt ? new Date(order.deliveredAt).toLocaleDateString() : 'N/A',
                collectedAmount: collected,
                remainingBalance: remaining,
                collectionMethods: methods,
                shippingCost: Number(order.shippingCost || 0),
                delayDays: delayDays,
                collectionStatus: status,
                finalTotal: total,
            };
        });

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Order Collections");

        // --- 3. Define Columns ---
        worksheet.columns = [
            { header: "Order Number", key: "orderNumber", width: 15 },
            { header: "Shipping Company", key: "shippingCompany", width: 20 },
            { header: "Delivered Date", key: "deliveredDate", width: 15 },
            { header: "Collected Amount", key: "collectedAmount", width: 18 },
            { header: "Remaining Balance", key: "remainingBalance", width: 18 },
            { header: "Collection Methods", key: "collectionMethods", width: 20 },
            { header: "Shipping Cost", key: "shippingCost", width: 15 },
            { header: "Delay Days", key: "delayDays", width: 12 },
            { header: "Collection Status", key: "collectionStatus", width: 18 },
            { header: "Order Total", key: "finalTotal", width: 15 },
        ];

        // --- 4. Styling & Formatting ---
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFE0E0E0" },
        };

        exportData.forEach((row) => {
            const newRow = worksheet.addRow(row);
            const statusCell = newRow.getCell(9); // Status Column

            if (row.collectionStatus === 'Fully Collected') {
                statusCell.font = { color: { argb: 'FF006400' }, bold: true }; // Green
            } else if (row.collectionStatus === 'Partial') {
                statusCell.font = { color: { argb: 'FFFF8C00' }, bold: true }; // Orange
            } else {
                statusCell.font = { color: { argb: 'FFFF0000' }, bold: true }; // Red
            }
        });

        return await workbook.xlsx.writeBuffer();
    }

}