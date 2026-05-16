import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AutomationFlowEntity, AutomationStatus } from 'entities/automation.entity';
import { Brackets, Repository } from 'typeorm';
import { CreateAutomationDto, UpdateAutomationDto } from 'dto/automation.dto';
import { tenantId } from 'src/category/category.service';
import { DateFilterUtil } from 'common/date-filter.util';

@Injectable()
export class AutomationService {
    constructor(
        @InjectRepository(AutomationFlowEntity)
        private readonly automationRepo: Repository<AutomationFlowEntity>,
    ) { }

    async create(me: any, dto: CreateAutomationDto) {
        const adminId = tenantId(me);

        if (!adminId) {
            throw new BadRequestException('AdminId not found');
        }

        const existing = await this.automationRepo.findOne({
            where: { name: dto.name, adminId },
        });

        if (existing) {
            throw new BadRequestException('Automation name already exists');
        }

        const entity = this.automationRepo.create({
            adminId,
            name: dto.name,
            triggerType: dto.triggerType,
            status: dto.publish ? AutomationStatus.PUBLISHED : AutomationStatus.DRAFT,
            flow: {
                nodes: dto.flow.nodes,
                edges: dto.flow.edges,
            },
        });

        return await this.automationRepo.save(entity);
    }

    async update(me: any, id: string, dto: UpdateAutomationDto) {
        const adminId = tenantId(me);
        if (!adminId) {
            throw new BadRequestException('AdminId not found');
        }

        const automation = await this.findOne(me, id);

        if (!automation) {
            throw new Error('Automation not found');
        }

        if (dto.name && dto.name !== automation.name) {
            const existing = await this.automationRepo.findOne({
                where: { name: dto.name, adminId },
            });

            if (existing) {
                throw new BadRequestException('Automation name already exists');
            }

            automation.name = dto.name;
        }

        if (dto.triggerType) {
            automation.triggerType = dto.triggerType;
        }

        if (dto.flow) {
            automation.flow = {
                nodes: dto.flow.nodes,
                edges: dto.flow.edges,
            };
        }

        return await this.automationRepo.save(automation);
    }

    async findAll(me: any, q?: any) {
        const adminId = tenantId(me);
        if (!adminId) throw new BadRequestException("Missing adminId");

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();
        const sortBy = String(q?.sortBy ?? "createdAt");
        const sortDir: "ASC" | "DESC" =
            String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

        const qb = this.automationRepo
            .createQueryBuilder("automation")
            .where("automation.adminId = :adminId", { adminId });

        // Filters
        if (q?.status) {
            qb.andWhere("automation.status = :status", { status: q.status });
        }

        if (q?.triggerType) {
            qb.andWhere("automation.triggerType = :triggerType", { triggerType: q.triggerType });
        }

        // Date range
        DateFilterUtil.applyToQueryBuilder(qb, "automation.createdAt", q?.startDate, q?.endDate);

        // Search
        if (search) {
            qb.andWhere(
                new Brackets((sq) => {
                    sq.where("automation.name ILIKE :s", { s: `%${search}%` });
                }),
            );
        }

        // Sorting
        const sortColumns: Record<string, string> = {
            createdAt: "automation.createdAt",
            name: "automation.name",
            status: "automation.status",
        };

        if (sortColumns[sortBy]) {
            qb.orderBy(sortColumns[sortBy], sortDir);
        } else {
            qb.orderBy("automation.createdAt", "DESC");
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

    async findOne(me: any, id: string) {
        const adminId = tenantId(me);
        return await this.automationRepo.findOne({
            where: { id, adminId },
        });
    }

    async delete(me: any, id: string) {
        const adminId = tenantId(me);
        return await this.automationRepo.delete({ id, adminId });
    }

    async changeStatus(me: any, id: string, status: AutomationStatus) {
        const automation = await this.findOne(me, id);

        if (!automation) {
            throw new Error('Automation not found');
        }

        automation.status = status;
        return await this.automationRepo.save(automation);
    }

}
