import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ProductSyncStateEntity, ProductSyncErrorLogEntity, ProductSyncAction, ProductSyncStatusDto, SyncEntityType } from 'entities/product_sync_error.entity';
import { tenantId } from 'src/category/category.service';
import { DateFilterUtil } from 'common/date-filter.util';
import * as ExcelJS from 'exceljs';
import { NotificationService } from 'src/notifications/notification.service';
import { NotificationType } from 'entities/notifications.entity';
import { RequestTranslationService, TranslationService } from 'common/translation.service';

@Injectable()
export class ProductSyncStateService {
    constructor(
        @InjectRepository(ProductSyncStateEntity)
        private readonly syncStateRepo: Repository<ProductSyncStateEntity>,
        @InjectRepository(ProductSyncErrorLogEntity)
        private readonly syncErrorLogRepo: Repository<ProductSyncErrorLogEntity>,
        private readonly notificationService: NotificationService,
        private readonly translations: TranslationService,
        private requestTranslations: RequestTranslationService,
        
    ) { }

    // ─── SYNC STATE ──────────────────────────────────────────────────────────

    async list(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);

        const qb = this.syncStateRepo
            .createQueryBuilder("syncState")
            .where("syncState.adminId = :adminId", { adminId })
            .leftJoinAndSelect("syncState.store", "store")
            .leftJoinAndSelect("syncState.product", "product")
            .andWhere("product.isActive = true");

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
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        const record = await this.syncStateRepo.findOne({
            where: { id, adminId },
            relations: ['store', 'product'],
        });

        if (!record) {
            throw new NotFoundException(this.translations.t('domains.product_sync.state_not_found'));
        }

        return record;
    }

    async getStatistics(me: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        const raw = await this.syncStateRepo
            .createQueryBuilder("syncState")
            .select("syncState.status", "status")
            .leftJoinAndSelect("syncState.product", "product")
            .addSelect("COUNT(*)", "count")
            .where("syncState.adminId = :adminId", { adminId })
            .andWhere("product.isActive = true")
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
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        const qb = this.syncStateRepo
            .createQueryBuilder("syncState")
            .where("syncState.adminId = :adminId", { adminId })
            .leftJoinAndSelect("syncState.store", "store")
            .leftJoinAndSelect("syncState.product", "product")
            .andWhere("product.isActive = true");

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
        const worksheet = workbook.addWorksheet(this.translations.t('domains.product_sync.state_sheet'));
        const naText = this.translations.t('domains.product_sync.n_a');
        const noneText = this.translations.t('domains.product_sync.none');

        worksheet.columns = [
            { header: this.translations.t('domains.product_sync.id'), key: "id", width: 36 },
            { header: this.translations.t('domains.product_sync.product_name'), key: "productName", width: 30 },
            { header: this.translations.t('domains.product_sync.product_slug'), key: "productSlug", width: 20 },
            { header: this.translations.t('domains.product_sync.store'), key: "store", width: 20 },
            { header: this.translations.t('domains.product_sync.remote_id'), key: "remoteId", width: 20 },
            { header: this.translations.t('domains.product_sync.status'), key: "status", width: 15 },
            { header: this.translations.t('domains.product_sync.last_error'), key: "lastError", width: 40 },
            { header: this.translations.t('domains.product_sync.last_synced_at'), key: "lastSyncedAt", width: 20 },
            { header: this.translations.t('domains.product_sync.created_at'), key: "createdAt", width: 20 },
        ];

        records.forEach((r) => {
            worksheet.addRow({
                id: r.id,
                productName: r.product?.name || naText,
                productSlug: r.product?.slug || naText,
                store: r.store?.name || naText,
                remoteId: r.remoteProductId || naText,
                status: r.status,
                lastError: r.lastError || noneText,
                lastSyncedAt: r.lastSynced_at ? r.lastSynced_at.toLocaleString() : naText,
                createdAt: r.created_at ? r.created_at.toLocaleString() : naText,
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
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);

        const qb = this.syncErrorLogRepo
            .createQueryBuilder("log")
            .leftJoinAndSelect("log.store", "store")
            .leftJoinAndSelect("log.product", "product")
            .leftJoinAndSelect("log.bundle", "bundle")
            .where("log.adminId = :adminId", { adminId });

        if (q?.productId) qb.andWhere("log.productId = :productId", { productId: q.productId });
        if (q?.storeId) qb.andWhere("log.storeId = :storeId", { storeId: q.storeId });
        if (q?.action) qb.andWhere("log.action = :action", { action: q.action });
        if (q?.search) {
            const searchTerm = `%${q.search}%`;
            qb.andWhere(
                `(
            product.name ILIKE :searchTerm 
            OR product.slug ILIKE :searchTerm
            OR bundle.name ILIKE :searchTerm
        )`,
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
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        const record = await this.syncErrorLogRepo.findOne({
            where: { id, adminId },
        });

        if (!record) {
            throw new NotFoundException(this.translations.t('domains.product_sync.error_log_not_found'));
        }

        return record;
    }

    async getLogsStatistics(me: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

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
            pull: 0,
            bundle_sync: 0,
            total: 0,
        };

        raw.forEach((row) => {
            const action = String(row.action).toLowerCase();
            if (action === 'create') stats.create = Number(row.count);
            else if (action === 'update') stats.update = Number(row.count);
            else if (action === 'pull') stats.pull = Number(row.count);
            else if (action === 'bundle_sync') stats.bundle_sync = Number(row.count);

            stats.total += Number(row.count);
        });

        return stats;
    }

    async exportLogs(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

        const qb = this.syncErrorLogRepo
            .createQueryBuilder("log")
            .leftJoinAndSelect("log.store", "store")
            .leftJoinAndSelect("log.product", "product")
            .leftJoinAndSelect("log.bundle", "bundle")
            .where("log.adminId = :adminId", { adminId });

        if (q?.productId) qb.andWhere("log.productId = :productId", { productId: q.productId });
        if (q?.storeId) qb.andWhere("log.storeId = :storeId", { storeId: q.storeId });
        if (q?.action) qb.andWhere("log.action = :action", { action: q.action });

        if (q?.search) {
            const searchTerm = `%${q.search}%`;
            qb.andWhere(
                `(
            product.name ILIKE :searchTerm 
            OR product.slug ILIKE :searchTerm
            OR bundle.name ILIKE :searchTerm
        )`,
                { searchTerm }
            );
        }

        DateFilterUtil.applyToQueryBuilder(qb, "log.created_at", q?.startDate, q?.endDate);

        qb.orderBy("log.created_at", "DESC");

        const records = await qb.getMany();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(this.translations.t('domains.product_sync.error_logs_sheet'));
        const naText = this.translations.t('domains.product_sync.n_a');

        worksheet.columns = [
            { header: this.translations.t('domains.product_sync.id'), key: "id", width: 36 },
            { header: this.translations.t('domains.product_sync.product_name'), key: "productName", width: 30 },
            { header: this.translations.t('domains.product_sync.bundle_name'), key: "bundleName", width: 30 },
            { header: this.translations.t('domains.product_sync.store_name'), key: "storeName", width: 30 },
            { header: this.translations.t('domains.product_sync.remote_id'), key: "remoteId", width: 20 },
            { header: this.translations.t('domains.product_sync.action'), key: "action", width: 15 },
            { header: this.translations.t('domains.product_sync.error_message'), key: "error", width: 50 },
            { header: this.translations.t('domains.product_sync.status'), key: "status", width: 10 },
            { header: this.translations.t('domains.product_sync.created_at'), key: "createdAt", width: 20 },
        ];

        records.forEach((r) => {
            worksheet.addRow({
                id: r.id,
                productName: r.product?.name || "",
                bundleName: r.bundle?.name || "",
                storeName: r.store?.name || "",
                action: r.action,
                error: r.errorMessage,
                status: r.responseStatus,
                createdAt: r.created_at ? r.created_at.toLocaleString() : naText,
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
        {
            adminId,
            storeId,
            productId,
            bundleId,
            entityType = SyncEntityType.PRODUCT,
        }: {
            adminId: string;
            storeId: string;
            productId?: string;
            bundleId?: string;
            entityType?: SyncEntityType;
        },
        data: {
            remoteProductId?: string | null;
            action: ProductSyncAction;
            errorMessage: string;
            userMessage?: string;
            responseStatus?: number;
            requestPayload?: Record<string, any> | null;
        }
    ) {
        if (!adminId || !storeId) {
            throw new Error(this.translations.t('domains.product_sync.admin_id_and_store_id_required'));
        }

        // ✅ Validate entity
        if (entityType === SyncEntityType.PRODUCT && !productId) {
            throw new Error(this.translations.t('domains.product_sync.product_id_required_for_product_entity'));
        }

        if (entityType === SyncEntityType.BUNDLE && !bundleId) {
            throw new Error(this.translations.t('domains.product_sync.bundle_id_required_for_bundle_entity'));
        }

        const { userMessage, ...payload } = data;

        const log = this.syncErrorLogRepo.create({
            ...payload,
            adminId,
            storeId,
            entityType,
            productId: productId || null,
            bundleId: bundleId || null,
        });

        // ✅ Notification handling
        const isProduct = entityType === SyncEntityType.PRODUCT;

        await this.notificationService.create({
            userId: adminId,
            type: NotificationType.PRODUCT_SYNC_FAILED, // you can later split this if needed
            title: await this.requestTranslations.tAsync(
                entityType === SyncEntityType.PULL 
                    ? 'domains.product_sync.pull_sync_failed_title' 
                    : isProduct 
                        ? 'domains.product_sync.product_sync_failed_title' 
                        : 'domains.product_sync.bundle_sync_failed_title',
                adminId
            ),
            message:
                !!userMessage ? userMessage : await this.requestTranslations.tAsync(
                    entityType === SyncEntityType.PULL 
                        ? 'domains.product_sync.failed_to_pull_product' 
                        : isProduct 
                            ? 'domains.product_sync.failed_to_sync_product' 
                            : 'domains.product_sync.failed_to_sync_bundle',
                    adminId
                ),
            relatedEntityType: entityType === SyncEntityType.PULL ? null : isProduct ? "product" : "bundle",
            relatedEntityId: entityType === SyncEntityType.PULL ? null : isProduct ? productId : bundleId,
        });

        return this.syncErrorLogRepo.save(log);
    }

    async upsertSyncState(
        { adminId, productId, storeId, externalStoreId }: { adminId: string, productId: string, storeId: string, externalStoreId?: string },
        data: Partial<ProductSyncStatusDto>,
        manager?: EntityManager
    ): Promise<ProductSyncStateEntity> {

        if (!adminId || !productId || !storeId) {
            throw new Error(this.translations.t('domains.product_sync.admin_id_product_id_store_id_required'));
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

