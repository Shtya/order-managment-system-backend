import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets } from 'typeorm';
import { SystemErrorEntity } from 'entities/system_erorrs.entity';
import { tenantId } from '../category/category.service';
import { isSuperAdmin } from 'common/healpers';
import * as ExcelJS from 'exceljs';
import { DateFilterUtil } from 'common/date-filter.util';

@Injectable()
export class SystemErorrsService {
    constructor(
        @InjectRepository(SystemErrorEntity)
        private readonly systemErrorRepo: Repository<SystemErrorEntity>,
    ) { }

    async list(me: any, q?: any) {
        if (!isSuperAdmin(me)) {
            throw new ForbiddenException(
                "You do not have permission",
            );
        }
        const pageNumber = Number(q?.page) || 1;
        const limitNumber = Number(q?.limit) || 10;
        const skip = (pageNumber - 1) * limitNumber;
        const adminId = tenantId(me);

        const query = this.systemErrorRepo.createQueryBuilder("errors")
            .leftJoinAndSelect("errors.user", "user")
            .leftJoinAndSelect("errors.admin", "admin")


        // Tenant isolation - filter by adminId if not super admin
        if (adminId) {
            query.andWhere("errors.adminId = :adminId", { adminId });
        }

        // Filter by userId
        if (q?.userId) {
            query.andWhere("errors.userId = :userId", { userId: q.userId });
        }

        // Filter by endpoint
        if (q?.endpoint) {
            query.andWhere("errors.endpoint LIKE :endpoint", { endpoint: `%${q.endpoint}%` });
        }

        // Filter by method
        if (q?.method) {
            query.andWhere("errors.method = :method", { method: q.method });
        }

        if (q?.referer) {
            query.andWhere("errors.referer = :referer", { referer: q.referer });
        }

        // Filter by httpStatus
        if (q?.httpStatus) {
            if (q.httpStatus === 'all_400') {
                query.andWhere("errors.httpStatus >= 400 AND errors.httpStatus < 500");
            } else if (q.httpStatus === 'all_500') {
                query.andWhere("errors.httpStatus >= 500");
            } else {
                query.andWhere("errors.httpStatus = :httpStatus", { httpStatus: q.httpStatus });
            }
        }

        if (q?.exceptionName) {
            query.andWhere("errors.exceptionName = :exceptionName", { exceptionName: q.exceptionName });
        }

        if (q?.routePath) {
            query.andWhere("errors.routePath = :routePath", { routePath: q.routePath });
        }

        if (q?.environment) {
            query.andWhere("errors.environment = :environment", { environment: q.environment });
        }

        if (q?.severity) {
            query.andWhere("errors.severity = :severity", { severity: q.severity });
        }
        // Filter by errorCode
        if (q?.errorCode) {
            query.andWhere("errors.errorCode LIKE :errorCode", { errorCode: `%${q.errorCode}%` });
        }

        // Filter by environment
        if (q?.environment) {
            query.andWhere("errors.environment = :environment", { environment: q.environment });
        }

        // Filter by ipAddress
        if (q?.ipAddress) {
            query.andWhere("errors.ipAddress LIKE :ipAddress", { ipAddress: `%${q.ipAddress}%` });
        }

        // General search across multiple fields
        if (q?.search) {
            query.andWhere(
                new Brackets((qb) => {
                    qb.where("errors.errorMessage ILIKE :search", { search: `%${q.search}%` })
                        .orWhere("errors.endpoint ILIKE :search", { search: `%${q.search}%` })
                        .orWhere("errors.routePath ILIKE :search", { search: `%${q.search}%` })
                        .orWhere("errors.originalUrl ILIKE :search", { search: `%${q.search}%` })
                        .orWhere("errors.exceptionName ILIKE :search", { search: `%${q.search}%` })
                        .orWhere("errors.errorCode ILIKE :search", { search: `%${q.search}%` })
                        .orWhere("errors.referer ILIKE :search", { search: `%${q.search}%` })
                })
            );
        }

        // Date range filters
        
        DateFilterUtil.applyToQueryBuilder(query, 'errors.createdAt', q?.startDate, q?.endDate);
        // Sorting & Pagination
        const sortBy = q?.sortBy || "createdAt";
        const sortOrder = q?.sortOrder?.toUpperCase() === "ASC" ? "ASC" : "DESC";

        const finalSortBy = sortBy.includes(".") ? sortBy : `errors.${sortBy}`;

        const [data, total] = await query
            .orderBy(finalSortBy, sortOrder)
            .skip(skip)
            .take(limitNumber)
            .getManyAndCount();

        return {
            total_records: total,
            current_page: pageNumber,
            per_page: limitNumber,
            records: data,
        };
    }

    async findOne(me: any, id: string) {
        if (!isSuperAdmin(me)) {
            throw new ForbiddenException(
                "You do not have permission",
            );
        }

        const adminId = tenantId(me);
        const query = this.systemErrorRepo.createQueryBuilder("errors")
            .leftJoinAndSelect("errors.user", "user")
            .leftJoinAndSelect("errors.admin", "admin")
            .where("errors.id = :id", { id });

        // Tenant isolation
        if (adminId) {
            query.andWhere("errors.adminId = :adminId", { adminId });
        }

        const error = await query.getOne();
        if (!error) {
            throw new Error('System error not found');
        }
        return error;
    }

    async logError(errorData: Partial<SystemErrorEntity>) {
        try {
            const error = this.systemErrorRepo.create(errorData);
            await this.systemErrorRepo.save(error);
        } catch (e) {
            // Silently fail to avoid infinite loops if logging fails
            console.error('Failed to log system error:', e);
        }
    }

    async exportErrors(me: any, q: any) {
        if (!isSuperAdmin(me)) {
            throw new ForbiddenException("You do not have permission");
        }
        const { records } = await this.list(me, { ...q, limit: 5000, page: 1 });
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("System Errors");

        worksheet.columns = [
            { header: "ID", key: "id", width: 36 },
            { header: "User ID", key: "userId", width: 36 },
            { header: "User Name", key: "userName", width: 20 },
            { header: "User Email", key: "userEmail", width: 25 },
            { header: "Admin ID", key: "adminId", width: 36 },
            { header: "Admin Name", key: "adminName", width: 20 },
            { header: "Admin Email", key: "adminEmail", width: 25 },
            { header: "Endpoint", key: "endpoint", width: 30 },
            { header: "Method", key: "method", width: 10 },
            { header: "Status", key: "httpStatus", width: 10 },
            { header: "Severity", key: "severity", width: 10 },
            { header: "Message", key: "errorMessage", width: 50 },
            { header: "Route Path", key: "routePath", width: 30 },
            { header: "Exception", key: "exceptionName", width: 30 },
            { header: "Environment", key: "environment", width: 15 },
            { header: "Error Code", key: "errorCode", width: 15 },
            { header: "Duration (ms)", key: "durationMs", width: 15 },
            { header: "IP Address", key: "ipAddress", width: 15 },
            { header: "User Agent", key: "userAgent", width: 40 },
            { header: "Referer", key: "referer", width: 30 },
            { header: "Frontend Route", key: "frontendRoute", width: 30 },
            { header: "Original URL", key: "originalUrl", width: 40 },
            { header: "Route Pattern", key: "routePattern", width: 30 },
            { header: "Content Type", key: "contentType", width: 20 },
            { header: "Request Size", key: "requestSize", width: 15 },
            { header: "Response Size", key: "responseSize", width: 15 },
            { header: "Request Payload", key: "requestPayload", width: 40 },
            { header: "Headers", key: "headers", width: 40 },
            { header: "Path Params", key: "pathParams", width: 30 },
            { header: "Search Params", key: "searchParams", width: 30 },
            { header: "Response Data", key: "responseData", width: 40 },
            { header: "Validation Errors", key: "validationErrors", width: 40 },
            { header: "DB Context", key: "dbContext", width: 40 },
            { header: "External Context", key: "externalContext", width: 40 },
            { header: "Additional Details", key: "additionalDetails", width: 40 },
            { header: "Stack Trace", key: "stackTrace", width: 50 },
            { header: "Created At", key: "createdAt", width: 25 },
        ];

        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFE0E0E0" },
        };

        const exportData = records.map(r => ({
            id: r.id,
            userId: r.userId,
            userName: r.user?.name || 'Guest',
            userEmail: r.user?.email || 'N/A',
            adminId: r.adminId,
            adminName: r.admin?.name || 'N/A',
            adminEmail: r.admin?.email || 'N/A',
            endpoint: r.endpoint,
            method: r.method,
            httpStatus: r.httpStatus,
            severity: r.severity,
            errorMessage: r.errorMessage,
            routePath: r.routePath,
            exceptionName: r.exceptionName,
            environment: r.environment,
            errorCode: r.errorCode,
            durationMs: r.durationMs,
            ipAddress: r.ipAddress,
            userAgent: r.userAgent,
            referer: r.referer,
            frontendRoute: r.frontendRoute,
            originalUrl: r.originalUrl,
            routePattern: r.routePattern,
            contentType: r.contentType,
            requestSize: r.requestSize,
            responseSize: r.responseSize,
            requestPayload: r.requestPayload ? JSON.stringify(r.requestPayload) : '',
            headers: r.headers ? JSON.stringify(r.headers) : '',
            pathParams: r.pathParams ? JSON.stringify(r.pathParams) : '',
            searchParams: r.searchParams ? JSON.stringify(r.searchParams) : '',
            responseData: r.responseData ? JSON.stringify(r.responseData) : '',
            validationErrors: r.validationErrors ? JSON.stringify(r.validationErrors) : '',
            dbContext: r.dbContext ? JSON.stringify(r.dbContext) : '',
            externalContext: r.externalContext ? JSON.stringify(r.externalContext) : '',
            additionalDetails: r.additionalDetails ? JSON.stringify(r.additionalDetails) : '',
            stackTrace: r.stackTrace,
            createdAt: r.createdAt,
        }));

        exportData.forEach(t => worksheet.addRow(t));
        return await workbook.xlsx.writeBuffer();
    }

    async getMeta(me: any) {
        if (!isSuperAdmin(me)) {
            throw new ForbiddenException("You do not have permission");
        }
        const adminId = tenantId(me);

        const buildBaseQuery = (field: string) => {
            const q = this.systemErrorRepo.createQueryBuilder("errors")
                .select(`DISTINCT errors.${field}`, field)
                .where(`errors.${field} IS NOT NULL`);
            if (adminId) q.andWhere("errors.adminId = :adminId", { adminId });
            return q.getRawMany();
        };

        const [routePaths, exceptionNames, environments] = await Promise.all([
            buildBaseQuery('routePath'),
            buildBaseQuery('exceptionName'),
            buildBaseQuery('environment'),
        ]);

        return {
            routePaths: routePaths.map(r => r.routePath),
            exceptionNames: exceptionNames.map(r => r.exceptionName),
            environments: environments.map(r => r.environment),
        };
    }

    async getStats(me: any) {
        if (!isSuperAdmin(me)) {
            throw new ForbiddenException("You do not have permission");
        }
        const adminId = tenantId(me);

        const now = new Date();
        const last48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);
        const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        // 1. Most routePath has errors
        const mostFrequentRouteQuery = this.systemErrorRepo.createQueryBuilder("errors")
            .select("errors.routePath", "routePath")
            .addSelect("COUNT(*)", "count")
            .where("errors.routePath IS NOT NULL")
            .groupBy("errors.routePath")
            .orderBy("count", "DESC")
            .limit(1);

        // 2. Count of errors last 48 hours
        const count48hQuery = this.systemErrorRepo.createQueryBuilder("errors")
            .where("errors.createdAt >= :last48h", { last48h });

        // 3. Total Errors for last 30 days
        const total30dQuery = this.systemErrorRepo.createQueryBuilder("errors")
            .where("errors.createdAt >= :last30d", { last30d });

        // 4. Fatal Errors last 48 hours
        const fatal48hQuery = this.systemErrorRepo.createQueryBuilder("errors")
            .where("errors.createdAt >= :last48h", { last48h })
            .andWhere("errors.severity = :severity", { severity: 'fatal' });

        if (adminId) {
            mostFrequentRouteQuery.andWhere("errors.adminId = :adminId", { adminId });
            count48hQuery.andWhere("errors.adminId = :adminId", { adminId });
            total30dQuery.andWhere("errors.adminId = :adminId", { adminId });
            fatal48hQuery.andWhere("errors.adminId = :adminId", { adminId });
        }

        const [mostFrequentRoute, count48h, total30d, fatal48h] = await Promise.all([
            mostFrequentRouteQuery.getRawOne(),
            count48hQuery.getCount(),
            total30dQuery.getCount(),
            fatal48hQuery.getCount()
        ]);

        return {
            mostFrequentRoute: mostFrequentRoute || { routePath: 'N/A', count: 0 },
            count48h,
            total30d,
            fatal48h
        };
    }

    async delete(me: any, id: string) {
        if (!isSuperAdmin(me)) {
            throw new ForbiddenException("You do not have permission");
        }
        const adminId = tenantId(me);

        const deleteQuery = this.systemErrorRepo.createQueryBuilder()
            .delete()
            .where("id = :id", { id });

        if (adminId) {
            deleteQuery.andWhere("adminId = :adminId", { adminId });
        }

        const result = await deleteQuery.execute();

        if (result.affected === 0) {
            throw new Error('System error not found or you do not have permission to delete it');
        }

        return { message: 'Error deleted successfully' };
    }

    async bulkDelete(me: any, ids: string[]) {
        if (!isSuperAdmin(me)) {
            throw new ForbiddenException("You do not have permission");
        }

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return { message: 'No errors selected for deletion', affected: 0 };
        }

        const adminId = tenantId(me);

        const deleteQuery = this.systemErrorRepo.createQueryBuilder()
            .delete()
            .where("id IN (:...ids)", { ids });

        if (adminId) {
            deleteQuery.andWhere("adminId = :adminId", { adminId });
        }

        const result = await deleteQuery.execute();
        return {
            message: `${result.affected} errors deleted successfully`,
            affected: result.affected
        };
    }
}

