import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ProductSyncStateEntity, ProductSyncErrorLogEntity, ProductSyncAction, ProductSyncStatusDto } from 'entities/product_sync_error.entity';
import { tenantId } from 'src/category/category.service';
import { DateFilterUtil } from 'common/date-filter.util';
import * as ExcelJS from 'exceljs';
import { NotificationService } from 'src/notifications/notification.service';
import { NotificationType } from 'entities/notifications.entity';

@Injectable()
export class ProductSyncStateService {
    constructor(
        @InjectRepository(ProductSyncStateEntity)
        private readonly syncStateRepo: Repository<ProductSyncStateEntity>,
        @InjectRepository(ProductSyncErrorLogEntity)
        private readonly syncErrorLogRepo: Repository<ProductSyncErrorLogEntity>,
        private readonly notificationService: NotificationService,
    ) { }

    // ─── SYNC STATE ──────────────────────────────────────────────────────────

    async list(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);

        const qb = this.syncStateRepo
            .createQueryBuilder("syncState")
            .where("syncState.adminId = :adminId", { adminId })
            .leftJoinAndSelect("syncState.store", "store")
            .leftJoinAndSelect("syncState.product", "product");

        if (q?.search) {
            const searchTerm = `%${q.search}%`;
            qb.andWhere(
                "(product.name ILIKE :searchTerm OR product.slug ILIKE :searchTerm)",
                { searchTerm }
            );
        }

        if (q?.storeId) qb.andWhere("syncState.storeId = :storeId", { storeId: q.storeId });
        if (q?.status) qb.andWhere("syncState.status = :status", { status: q.status });

        DateFilterUtil.applyToQueryBuilder(qb, "syncState.created_at", q?.startDate, q?.endDate);

        qb.orderBy("syncState.created_at", "DESC");

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

    async getById(me: any, id: string) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const record = await this.syncStateRepo.findOne({
            where: { id, adminId },
            relations: ['store', 'product'],
        });

        if (!record) {
            throw new NotFoundException("Product sync state record not found");
        }

        return record;
    }

    async getStatistics(me: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const raw = await this.syncStateRepo
            .createQueryBuilder("syncState")
            .select("syncState.status", "status")
            .addSelect("COUNT(*)", "count")
            .where("syncState.adminId = :adminId", { adminId })
            .groupBy("syncState.status")
            .getRawMany();

        const stats = {
            pending: 0,
            synced: 0,
            failed: 0,
            total: 0,
        };

        raw.forEach((row) => {
            stats[row.status] = Number(row.count);
            stats.total += Number(row.count);
        });

        return stats;
    }

    async export(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const qb = this.syncStateRepo
            .createQueryBuilder("syncState")
            .where("syncState.adminId = :adminId", { adminId })
            .leftJoinAndSelect("syncState.store", "store")
            .leftJoinAndSelect("syncState.product", "product");

        if (q?.search) {
            const searchTerm = `%${q.search}%`;
            qb.andWhere(
                "(product.name ILIKE :searchTerm OR product.slug ILIKE :searchTerm)",
                { searchTerm }
            );
        }

        if (q?.storeId) qb.andWhere("syncState.storeId = :storeId", { storeId: q.storeId });
        if (q?.status) qb.andWhere("syncState.status = :status", { status: q.status });

        DateFilterUtil.applyToQueryBuilder(qb, "syncState.created_at", q?.startDate, q?.endDate);

        qb.orderBy("syncState.created_at", "DESC");

        const records = await qb.getMany();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Product Sync State");

        worksheet.columns = [
            { header: "ID", key: "id", width: 36 },
            { header: "Product Name", key: "productName", width: 30 },
            { header: "Product Slug", key: "productSlug", width: 20 },
            { header: "Store", key: "store", width: 20 },
            { header: "Remote Product ID", key: "remoteId", width: 20 },
            { header: "Status", key: "status", width: 15 },
            { header: "Last Error", key: "lastError", width: 40 },
            { header: "Last Synced At", key: "lastSyncedAt", width: 20 },
            { header: "Created At", key: "createdAt", width: 20 },
        ];

        records.forEach((r) => {
            worksheet.addRow({
                id: r.id,
                productName: r.product?.name || "N/A",
                productSlug: r.product?.slug || "N/A",
                store: r.store?.name || "N/A",
                remoteId: r.remoteProductId || "N/A",
                status: r.status,
                lastError: r.lastError || "None",
                lastSyncedAt: r.lastSynced_at ? r.lastSynced_at.toLocaleString() : "N/A",
                createdAt: r.created_at ? r.created_at.toLocaleString() : "N/A",
            });
        });

        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFE0E0E0" },
        };

        return await workbook.xlsx.writeBuffer();
    }

    // ─── ERROR LOGS ──────────────────────────────────────────────────────────

    async listLogs(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);

        const qb = this.syncErrorLogRepo
            .createQueryBuilder("log")
            .leftJoinAndSelect("log.store", "store")
            .leftJoinAndSelect("log.product", "product")
            .where("log.adminId = :adminId", { adminId });

        if (q?.productId) qb.andWhere("log.productId = :productId", { productId: q.productId });
        if (q?.storeId) qb.andWhere("log.storeId = :storeId", { storeId: q.storeId });
        if (q?.action) qb.andWhere("log.action = :action", { action: q.action });
        if (q?.search) {
            const searchTerm = `%${q.search}%`;
            qb.andWhere(
                "(product.name ILIKE :searchTerm OR product.slug ILIKE :searchTerm)",
                { searchTerm }
            );
        }
        DateFilterUtil.applyToQueryBuilder(qb, "log.created_at", q?.startDate, q?.endDate);

        qb.orderBy("log.created_at", "DESC");

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

    async getLogById(me: any, id: string) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const record = await this.syncErrorLogRepo.findOne({
            where: { id, adminId },
        });

        if (!record) {
            throw new NotFoundException("Product sync error log not found");
        }

        return record;
    }

    async getLogsStatistics(me: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const raw = await this.syncErrorLogRepo
            .createQueryBuilder("log")
            .select("log.action", "action")
            .addSelect("COUNT(*)", "count")
            .where("log.adminId = :adminId", { adminId })
            .groupBy("log.action")
            .getRawMany();

        const stats = {
            create: 0,
            update: 0,
            total: 0,
        };

        raw.forEach((row) => {
            const action = String(row.action).toLowerCase();
            if (action === 'create') stats.create = Number(row.count);
            if (action === 'update') stats.update = Number(row.count);
            stats.total += Number(row.count);
        });

        return stats;
    }

    async exportLogs(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const qb = this.syncErrorLogRepo
            .createQueryBuilder("log")
            .where("log.adminId = :adminId", { adminId });

        if (q?.productId) qb.andWhere("log.productId = :productId", { productId: q.productId });
        if (q?.storeId) qb.andWhere("log.storeId = :storeId", { storeId: q.storeId });
        if (q?.action) qb.andWhere("log.action = :action", { action: q.action });

        if (q?.search) {
            const searchTerm = `%${q.search}%`;
            qb.andWhere(
                "(product.name ILIKE :searchTerm OR product.slug ILIKE :searchTerm)",
                { searchTerm }
            );
        }

        DateFilterUtil.applyToQueryBuilder(qb, "log.created_at", q?.startDate, q?.endDate);

        qb.orderBy("log.created_at", "DESC");

        const records = await qb.getMany();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Sync Error Logs");

        worksheet.columns = [
            { header: "ID", key: "id", width: 36 },
            { header: "Product ID", key: "productId", width: 36 },
            { header: "Store ID", key: "storeId", width: 36 },
            { header: "Remote ID", key: "remoteId", width: 20 },
            { header: "Action", key: "action", width: 15 },
            { header: "Error Message", key: "error", width: 50 },
            { header: "Status", key: "status", width: 10 },
            { header: "Created At", key: "createdAt", width: 20 },
        ];

        records.forEach((r) => {
            worksheet.addRow({
                id: r.id,
                productId: r.productId,
                storeId: r.storeId,
                remoteId: r.remoteProductId || "N/A",
                action: r.action,
                error: r.errorMessage,
                status: r.responseStatus,
                createdAt: r.created_at ? r.created_at.toLocaleString() : "N/A",
            });
        });

        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFE0E0E0" },
        };

        return await workbook.xlsx.writeBuffer();
    }

    async upsertSyncErrorLog(
        { adminId, productId, storeId }: { adminId: string, productId: string, storeId: string },
        data: {
            remoteProductId?: string | null;
            action: ProductSyncAction;
            errorMessage: string;
            userMessage: string;
            responseStatus?: number;
            requestPayload?: Record<string, any> | null;
        }
    ) {
        if (!adminId || !productId || !storeId) {
            throw new Error('adminId, productId, storeId are required');
        }
        const { userMessage, ...payload } = data;
        const log = this.syncErrorLogRepo.create({
            ...payload,
            adminId,
            productId,
            storeId
        });
        await this.notificationService.create({
            userId: adminId,
            type: NotificationType.PRODUCT_SYNC_FAILED,
            title: "Product Sync Failed",
            message: userMessage || `Failed to sync product`,
            relatedEntityType: "product",
            relatedEntityId: String(productId),
        });

        return this.syncErrorLogRepo.save(log);
    }
    async upsertSyncState(
        { adminId, productId, storeId, externalStoreId }: { adminId: string, productId: string, storeId: string, externalStoreId: string },
        data: Partial<ProductSyncStatusDto>,
        manager?: EntityManager
    ): Promise<ProductSyncStateEntity> {

        if (!adminId || !productId || !storeId || !externalStoreId) {
            throw new Error('adminId, productId, storeId, externalStoreId are required');
        }


        const repo = manager
            ? manager.getRepository(ProductSyncStateEntity)
            : this.syncStateRepo;

        let state = await repo.findOne({
            where: {
                adminId,
                productId,
                storeId,
                externalStoreId,
            },
        });

        if (!state) {
            state = repo.create({
                ...data,
                adminId,
                productId,
                storeId,
                externalStoreId,
            });
        } else {
            Object.assign(state, data);
        }

        return await repo.save(state);
    }
}

