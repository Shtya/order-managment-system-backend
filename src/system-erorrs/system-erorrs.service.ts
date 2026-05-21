import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets } from 'typeorm';
import { SystemErrorEntity } from 'entities/system_erorrs.entity';
import { tenantId } from '../category/category.service';
import { isSuperAdmin } from 'common/healpers';

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

        const query = this.systemErrorRepo.createQueryBuilder("errors");

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

        // Filter by httpStatus
        if (q?.httpStatus) {
            query.andWhere("errors.httpStatus = :httpStatus", { httpStatus: q.httpStatus });
        }

        // Filter by severity
        if (q?.severity) {
            query.andWhere("errors.severity = :severity", { severity: q.severity });
        }

        // Filter by serviceName
        if (q?.serviceName) {
            query.andWhere("errors.serviceName LIKE :serviceName", { serviceName: `%${q.serviceName}%` });
        }

        // Filter by exceptionName
        if (q?.exceptionName) {
            query.andWhere("errors.exceptionName LIKE :exceptionName", { exceptionName: `%${q.exceptionName}%` });
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
                        .orWhere("errors.exceptionName ILIKE :search", { search: `%${q.search}%` })
                        .orWhere("errors.errorCode ILIKE :search", { search: `%${q.search}%` })
                        .orWhere("errors.serviceName ILIKE :search", { search: `%${q.search}%` });
                })
            );
        }

        // Date range filters
        if (q?.startDate) {
            query.andWhere("errors.createdAt >= :startDate", { startDate: new Date(q.startDate) });
        }

        if (q?.endDate) {
            query.andWhere("errors.createdAt <= :endDate", { endDate: new Date(q.endDate) });
        }

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
        const query = this.systemErrorRepo.createQueryBuilder("errors").where("errors.id = :id", { id });

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
}
