import { BadRequestException, forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AutomationFlowEntity, AutomationFlowVersionEntity, AutomationRunEntity, AutomationStatus, RunStatus, TriggerType, VersionIncrementType } from 'entities/automation.entity';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';
import { CreateAutomationDto, UpdateAutomationDto } from 'dto/automation.dto';
import { tenantId } from 'src/category/category.service';
import { DateFilterUtil } from 'common/date-filter.util';
import * as ExcelJS from 'exceljs';
import { TriggerDispatcherService } from './engine/triggerDispatcher.service';
import { AutomationQueueService } from 'src/queue/queues/automations.queue';
import { isSuperAdmin, deletePhysicalFiles } from 'common/healpers';
import { OrphanFilesService } from 'src/orphan-files/orphan-files.service';

@Injectable()
export class AutomationService {
    constructor(
        private dataSource: DataSource,
        @InjectRepository(AutomationFlowEntity)
        private readonly automationRepo: Repository<AutomationFlowEntity>,
        @InjectRepository(AutomationFlowVersionEntity)
        private readonly versionRepo: Repository<AutomationFlowVersionEntity>,
        @InjectRepository(AutomationRunEntity)
        private readonly runRepo: Repository<AutomationRunEntity>,
        private readonly dispatcher: TriggerDispatcherService,
        @Inject(forwardRef(() => AutomationQueueService))
        private readonly automationQueueService: AutomationQueueService,
        private readonly orphanFilesService: OrphanFilesService,
    ) { }

    async getFlowsStats(me: any) {
        const adminId = tenantId(me);
        const stats = await this.automationRepo
            .createQueryBuilder('flow')
            .select('flow.status', 'status')
            .addSelect('COUNT(*)', 'count')
            .where('flow.adminId = :adminId', { adminId })
            .groupBy('flow.status')
            .getRawMany();

        const result = {
            total: 0,
            published: 0,
            draft: 0,
            paused: 0,
            archived: 0,
        };

        stats.forEach(s => {
            const count = parseInt(s.count, 10);
            result.total += count;
            if (s.status === AutomationStatus.PUBLISHED) result.published = count;
            else if (s.status === AutomationStatus.DRAFT) result.draft = count;
            else if (s.status === AutomationStatus.PAUSED) result.paused = count;
            else if (s.status === AutomationStatus.ARCHIVED) result.archived = count;
        });

        return result;
    }

    async getRunsStats(me: any) {
        const adminId = tenantId(me);
        const stats = await this.runRepo
            .createQueryBuilder('run')
            .select('run.status', 'status')
            .addSelect('COUNT(*)', 'count')
            .where('run."adminId" = :adminId', { adminId })
            .andWhere('run.status != :cancelled', { cancelled: RunStatus.CANCELLED })
            .groupBy('run.status')
            .getRawMany();

        const result = {
            total: 0,
            pending: 0,
            running: 0,
            completed: 0,
            failed: 0,
            paused: 0,
        };

        stats.forEach(s => {
            const count = parseInt(s.count, 10);
            result.total += count;
            if (s.status === RunStatus.PENDING) result.pending = count;
            else if (s.status === RunStatus.RUNNING) result.running = count;
            else if (s.status === RunStatus.COMPLETED) result.completed = count;
            else if (s.status === RunStatus.FAILED) result.failed = count;
            else if (s.status === RunStatus.PAUSED) result.paused = count;
        });

        return result;
    }

    private extractBasePaths(urls: string[]): string[] {
        return urls.map((url) => {
            try {
                const urlObj = new URL(url);
                return urlObj.pathname.startsWith("/")
                    ? urlObj.pathname.slice(1)
                    : urlObj.pathname;
            } catch {
                return url.startsWith("/")
                    ? url.slice(1)
                    : url;
            }
        });
    }

    private async schedulePhysicalFileDeletion(
        manager: EntityManager,
        urls: string[],
    ): Promise<void> {
        const basePaths = this.extractBasePaths(urls);

        if (manager.queryRunner?.data) {
            manager.queryRunner.data.postCommitTasks ??= [];

            manager.queryRunner.data.postCommitTasks.push(async () => {
                await deletePhysicalFiles(basePaths);
            });
        } else {
            await deletePhysicalFiles(basePaths);
        }
    }

    async create(me: any, dto: CreateAutomationDto) {
        const adminId = tenantId(me);
        const isSuperAdminFlag = isSuperAdmin(me);

        if (!isSuperAdminFlag && !adminId) {
            throw new BadRequestException('AdminId not found');
        }

        return await this.dataSource.transaction(async (manager) => {
            const automationRepo = manager.getRepository(AutomationFlowEntity);
            const versionRepo = manager.getRepository(AutomationFlowVersionEntity);

            const existing = await automationRepo.findOne({
                where: { name: dto.name, adminId },
            });

            if (existing) {
                throw new BadRequestException('Automation name already exists');
            }

            const automation = automationRepo.create({
                adminId,
                name: dto.name,
                triggerType: dto.triggerType,
                status: dto.publish
                    ? AutomationStatus.PUBLISHED
                    : AutomationStatus.DRAFT,
            });

            const savedAutomation = await automationRepo.save(automation);

            // 1 - do not take version for create and make it create the first version (1.0)
            const version = versionRepo.create({
                automationFlowId: savedAutomation.id,
                versionString: '1.0',
                flow: {
                    nodes: dto.flow.nodes,
                    edges: dto.flow.edges,
                },
            });

            const savedVersion = await versionRepo.save(version);

            savedAutomation.latestVersionId = savedVersion.id;
            await automationRepo.save(savedAutomation);

            // Handle newIds: resolve and delete entities (keep files)
            if (dto.orphanFiles?.newIds) {
                await this.orphanFilesService.deleteOrphansByIds(manager, adminId, dto.orphanFiles.newIds);
            }

            if (dto.orphanFiles?.deletedOldUrls?.length) {
                await this.schedulePhysicalFileDeletion(
                    manager,
                    dto.orphanFiles.deletedOldUrls,
                );
            }

            return {
                ...savedAutomation,
                latestVersion: savedVersion,
            };
        });
    }

    async update(me: any, id: string, dto: UpdateAutomationDto) {
        const adminId = tenantId(me);
        const isSuperAdminFlag = isSuperAdmin(me);

        if (!isSuperAdminFlag && !adminId) {
            throw new BadRequestException('AdminId not found');
        }

        const result = await this.dataSource.transaction(async (manager) => {
            const automationRepo = manager.getRepository(AutomationFlowEntity);
            const versionRepo = manager.getRepository(AutomationFlowVersionEntity);

            const automation = await automationRepo.findOne({
                where: { id, adminId },
                relations: ['latestVersion'],
            });

            if (!automation) {
                throw new BadRequestException('Automation not found');
            }

            if (dto.flow) {
                const triggerNode = dto.flow.nodes.find(
                    (n) => n.type === 'trigger',
                );

                if (
                    triggerNode &&
                    triggerNode.data?.type !== automation.triggerType
                ) {
                    throw new BadRequestException(
                        'Trigger type in flow nodes must match automation trigger type',
                    );
                }
            }


            // If automation is in DRAFT status, update the latest version instead of creating a new one
            if (automation.status === AutomationStatus.DRAFT && automation.latestVersion) {
                automation.latestVersion.flow = {
                    nodes: dto.flow.nodes as any,
                    edges: dto.flow.edges as any,
                };
                automation.status = AutomationStatus.PUBLISHED;
                await automationRepo.save(automation);
                const savedVersion = await versionRepo.save(automation.latestVersion);

                // Handle newIds: resolve and delete entities (keep files)
                if (dto.orphanFiles?.newIds) {
                    await this.orphanFilesService.deleteOrphansByIds(manager, adminId, dto.orphanFiles.newIds);
                }

                // if (dto.orphanFiles?.deletedOldUrls?.length) {
                //     await this.schedulePhysicalFileDeletion(
                //         manager,
                //         dto.orphanFiles.deletedOldUrls,
                //     );
                // }

                return {
                    ...automation,
                    newVersion: savedVersion
                };
            }

            if (dto.flow) {
                let parentVersion = automation.latestVersion;
                let isPatch = false;

                if (dto.version) {
                    parentVersion = await versionRepo.findOne({
                        where: { versionString: dto.version, automationFlowId: id },
                    });
                    if (!parentVersion) {
                        throw new BadRequestException('Parent version not found');
                    }
                    isPatch = true;
                }

                // 2- if passed flow exactly as previous so nothing to update so just skip update
                if (parentVersion && this.isFlowEqual(dto.flow, parentVersion.flow)) {
                    return {
                        ...automation,
                        skipped: true,
                        message: 'Flow is identical to the base version, update skipped'
                    };
                }



                let nextVersion = '';
                // 1- if user pass version ... so get it and create sub version from it but it not pass any thing create major version
                if (isPatch) {
                    nextVersion = await this.generateNextPatchVersion(
                        automation.id,
                        parentVersion.versionString,
                    );
                } else {
                    nextVersion = await this.generateNextVersion(automation.id);
                }

                const newVersion = versionRepo.create({
                    automationFlowId: id,
                    versionString: nextVersion,
                    flow: {
                        nodes: dto.flow.nodes as any,
                        edges: dto.flow.edges as any,
                    },
                    parentVersionId: parentVersion?.id || null,
                });

                const savedVersion = await versionRepo.save(newVersion);

                // Update latestVersion if it's a major update or if we're fixing the current latest version
                if (!dto.version || (parentVersion && parentVersion.id === automation.latestVersionId)) {
                    automation.latestVersionId = savedVersion.id;
                    automation.latestVersion = savedVersion;
                }

                await automationRepo.save(automation);

                // Handle newIds: resolve and delete entities (keep files)
                if (dto.orphanFiles?.newIds) {
                    await this.orphanFilesService.deleteOrphansByIds(manager, adminId, dto.orphanFiles.newIds);
                }

                // if (dto.orphanFiles?.deletedOldUrls?.length) {
                //     await this.schedulePhysicalFileDeletion(
                //         manager,
                //         dto.orphanFiles.deletedOldUrls,
                //     );
                // }

                return {
                    ...automation,
                    newVersion: savedVersion // for compatibility if needed
                };
            }

            await automationRepo.save(automation);

            // Handle newIds: resolve and delete entities (keep files)
            if (dto.orphanFiles?.newIds) {
                await this.orphanFilesService.deleteOrphansByIds(manager, adminId, dto.orphanFiles.newIds);
            }

            if (dto.orphanFiles?.deletedOldUrls?.length) {
                await this.schedulePhysicalFileDeletion(
                    manager,
                    dto.orphanFiles.deletedOldUrls,
                );
            }

            return await automationRepo.findOne({
                where: { id, adminId },
                relations: ['latestVersion'],
            });
        });

        return result;
    }

    async retryRun(me: any, runId: string) {
        const adminId = tenantId(me);

        const run = await this.runRepo.findOne({
            where: { id: runId, automationFlow: { adminId } },
            relations: ['automationFlow', 'version'],
        });

        if (!run) {
            throw new NotFoundException('Automation run not found');
        }

        if (run.status !== RunStatus.FAILED) {
            throw new BadRequestException('Only failed runs can be retried');
        }

        // Reset status and clear error
        run.status = RunStatus.PENDING;
        run.errorMessage = null;
        await this.runRepo.save(run);

        // Add to queue
        await this.automationQueueService.enqueueStartFlow(
            run.id,
            run.automationFlowId,
            run.versionId,
            adminId,
        );

        return {
            message: 'Run has been queued for retry',
            run,
        };
    }

    async findAll(me: any, q?: any) {
        const adminId = tenantId(me);
        const isSuperAdminFlag = isSuperAdmin(me);

        if (!isSuperAdminFlag && !adminId) throw new BadRequestException("Missing adminId");

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();
        const sortBy = String(q?.sortBy ?? "createdAt");
        const sortDir: "ASC" | "DESC" =
            String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

        const qb = this.automationRepo
            .createQueryBuilder("automation")
            .leftJoinAndSelect('automation.latestVersion', 'latestVersion');

        if (isSuperAdminFlag)
            qb.where("automation.adminId Is NULL")
        else
            qb.where("automation.adminId = :adminId", { adminId })

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

    async findOne(me: any, id: string, version?: string) {
        const adminId = tenantId(me);
        const isSuperAdminFlag = isSuperAdmin(me);
        if (!isSuperAdminFlag && !adminId) throw new BadRequestException("Missing adminId");

        const query = this.automationRepo.createQueryBuilder('automation')
            .withDeleted()
            .where('automation.id = :id', { id })
            .andWhere(isSuperAdminFlag ? 'automation.adminId Is NULL' : 'automation.adminId = :adminId', { adminId });

        if (version) {
            query.leftJoinAndSelect(
                'automation.versions',
                'version',
                'version.versionString = :version',
                { version }
            );
        } else {
            query.leftJoinAndSelect('automation.latestVersion', 'version');
        }

        const automation = await query.getOne();

        if (!automation) {
            throw new BadRequestException("Automation not found");
        }

        // 2. التحقق من وجود الإصدار (سواء كان المحدد أو الأحدث) وإطلاق الخطأ بدقة
        if (version) {
            if (!automation.versions || automation.versions.length === 0) {
                throw new BadRequestException(`Automation found, but the specified version (${version}) does not exist`);
            }
        } else {
            // في حالة عدم تمرير إصدار، نتحقق من حقل الـ latestVersion المباشر
            if (!automation.latestVersion) {
                throw new BadRequestException("Automation found, but it does not have an active published version");
            }
            automation.versions = [automation.latestVersion];
        }


        return automation;
    }

    private isFlowEqual(flow1: any, flow2: any): boolean {
        if (!flow1 || !flow2) return false;
        const nodes1 = flow1.nodes || [];
        const nodes2 = flow2.nodes || [];
        const edges1 = flow1.edges || [];
        const edges2 = flow2.edges || [];

        if (nodes1.length !== nodes2.length || edges1.length !== edges2.length) {
            return false;
        }

        const normalizeNodes = (nodes) =>
            nodes.map(n => ({
                id: n.id,
                type: n.type,
                data: n.data,
            }));

        const normalizeEdges = (edges) =>
            edges.map(e => ({
                source: e.source,
                target: e.target,
                sourceHandle: e.sourceHandle,
                targetHandle: e.targetHandle,
            }));


        return (
            JSON.stringify(normalizeNodes(nodes1)) ===
            JSON.stringify(normalizeNodes(nodes2)) &&
            JSON.stringify(normalizeEdges(edges1)) ===
            JSON.stringify(normalizeEdges(edges2))
        );
    }

    private async generateNextVersion(
        automationFlowId: string,
    ): Promise<string> {

        const latestVersion = await this.versionRepo.createQueryBuilder('version')
            .where('version.automationFlowId = :automationFlowId', { automationFlowId })
            .orderBy('CAST(SPLIT_PART(version.versionString, \'.\', 1) AS INTEGER)', 'DESC')
            .getOne();

        const currentMajor = latestVersion ? parseInt(latestVersion.versionString.split('.')[0], 10) : 0;
        return `${currentMajor + 1}.0`;

    }

    async generateNextPatchVersion(automationFlowId: string, targetVersionString: string) {
        // 1. استخراج الرقم الرئيسي (Major) من النسخة المستهدفة (مثلاً "1.0" تعطينا "1")
        const majorVersion = targetVersionString.split('.')[0];

        // 2. البحث عن أعلى نسخة فرعية موجودة في قاعدة البيانات تبدأ بنفس الرقم الرئيسي
        const latestPatch = await this.versionRepo.createQueryBuilder('version')
            .where('version.automationFlowId = :automationFlowId', { automationFlowId })
            .andWhere('version.versionString LIKE :pattern', { pattern: `${majorVersion}.%` })
            .orderBy('CAST(SPLIT_PART(version.versionString, \'.\', 2) AS INTEGER)', 'DESC') // ترتيب بناءً على رقم الـ Minor كـ Integer
            .getOne();

        if (!latestPatch) {
            throw new NotFoundException("Base version line not found");
        }

        // 3. استخراج الـ Minor الحالي وزيادته بمقدار 1
        const currentMinor = parseInt(latestPatch.versionString.split('.')[1], 10);
        const nextMinor = currentMinor + 1;

        const nextVersionString = `${majorVersion}.${nextMinor}`; // ستصبح "1.2"

        return nextVersionString;
    }

    async delete(me: any, id: string) {
        const adminId = tenantId(me);

        return await this.automationRepo.manager.transaction(async (transactionalManager) => {

            const automation = await transactionalManager.findOne(AutomationFlowEntity, {
                where: { id, adminId }
            });

            if (!automation) {
                throw new NotFoundException('Automation not found');
            }

            automation.status = AutomationStatus.ARCHIVED;
            await transactionalManager.save(AutomationFlowEntity, automation);

            await transactionalManager.softDelete(AutomationFlowEntity, id);

            return {
                message: 'Automation deleted successfully',
            };
        });
    }

    async changeStatus(me: any, id: string, status: AutomationStatus) {
        const automation = await this.findOne(me, id);

        if (!automation) {
            throw new Error('Automation not found');
        }

        let nextStatus: AutomationStatus = status;

        if (status === undefined || status === null) {
            if (automation.status === AutomationStatus.PUBLISHED) {
                nextStatus = AutomationStatus.PAUSED;
            } else {
                nextStatus = AutomationStatus.PUBLISHED;
            }
        }

        // التعديل هنا: تحديث حقل الـ status فقط بناءً على الـ id مباشرة دون عمل save للكائن بالكامل
        await this.automationRepo.update(id, { status: nextStatus });

        // تحديث الحالة محلياً في الكائن قبل إرجاعه لتكون الاستجابة (Response) دقيقة ومطابقة لقاعدة البيانات
        automation.status = nextStatus;
        return automation;
    }


    async findAllRuns(me: any, q?: any) {
        const adminId = tenantId(me);
        const isSuperAdminFlag = isSuperAdmin(me);
        if (!isSuperAdminFlag && !adminId) throw new BadRequestException("Missing adminId");

        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 10);
        const search = String(q?.search ?? "").trim();
        const sortBy = String(q?.sortBy ?? "startedAt");
        const sortDir: "ASC" | "DESC" =
            String(q?.sortDir ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

        const qb = this.runRepo
            .createQueryBuilder("run")
            .leftJoinAndSelect('run.automationFlow', 'automationFlow')
            .leftJoinAndSelect('run.version', 'version')
            .where("run.automationFlowId IN (SELECT id FROM automation_flows WHERE \"adminId\" = :adminId)", { adminId });

        // Filters
        // if (q?.status) {
        //     qb.andWhere("run.status = :status", { status: q.status });
        // }

        if (q?.status) {
            const statusParam = q.status;
            if (typeof statusParam === "string" && statusParam.includes(",")) {
                const statusCodes = statusParam.split(",").map((s) => s.trim());
                qb.andWhere("run.status IN (:...statusCodes)", { statusCodes });
            } else {
                qb.andWhere("run.status = :status", { status: statusParam });
            }
        }

        if (q?.automationFlowId) {
            qb.andWhere("run.automationFlowId = :automationFlowId", { automationFlowId: q.automationFlowId });
        }

        if (q?.triggerType) {
            qb.andWhere("automationFlow.triggerType = :triggerType", { triggerType: q.triggerType });
        }

        // Date range
        DateFilterUtil.applyToQueryBuilder(qb, "run.startedAt", q?.startDate, q?.endDate);

        // Search (by triggerEntityId)
        if (search) {
            qb.andWhere("run.triggerEntityId ILIKE :s", { s: `%${search}%` });
        }

        // Sorting
        const sortColumns: Record<string, string> = {
            startedAt: "run.startedAt",
            status: "run.status",
            completedAt: "run.completedAt",
        };

        if (sortColumns[sortBy]) {
            qb.orderBy(sortColumns[sortBy], sortDir);
        } else {
            qb.orderBy("run.startedAt", "DESC");
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

    async findOneRun(me: any, id: string) {
        const adminId = tenantId(me);

        const run = await this.runRepo.findOne({
            where: { id },
            relations: ['automationFlow', 'version', 'steps']
        });

        if (!run) {
            throw new NotFoundException("Automation run not found");
        }

        // Security check: ensure the run belongs to an automation flow owned by the admin
        const flow = await this.automationRepo.findOne({
            where: { id: run.automationFlowId, adminId }
        });

        if (!flow) {
            throw new BadRequestException("Access denied or automation flow not found");
        }

        return run;
    }

    async export(me: any, q: any) {
        const { records } = await this.findAll(me, { ...q, limit: 1000, page: 1 });
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Automations");

        worksheet.columns = [
            { header: "Name", key: "name", width: 25 },
            { header: "Trigger Type", key: "triggerType", width: 25 },
            { header: "Status", key: "status", width: 15 },
            { header: "Created At", key: "createdAt", width: 25 },
        ];
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFE0E0E0" },
        };

        const exportData = records.map(t => ({
            "name": t.name,
            "triggerType": t.triggerType,
            "status": t.status,
            "createdAt": t.createdAt,
        }));
        exportData.forEach(t => worksheet.addRow(t));
        return await workbook.xlsx.writeBuffer();
    }

    async exportRuns(me: any, q: any) {
        const { records } = await this.findAllRuns(me, { ...q, limit: 1000, page: 1 });
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Automation Runs");

        worksheet.columns = [
            { header: "Automation", key: "automationName", width: 25 },
            { header: "Trigger Type", key: "triggerType", width: 25 },
            // { header: "Entity Type", key: "entityType", width: 25 },
            { header: "Version", key: "version", width: 10 },
            { header: "Status", key: "status", width: 15 },
            { header: "Steps Completed", key: "steps", width: 15 },
            { header: "Started At", key: "startedAt", width: 25 },
            { header: "Completed At", key: "completedAt", width: 25 },
            { header: "Error", key: "error", width: 40 },
        ];
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFE0E0E0" },
        };

        const exportData = records.map(r => ({
            "automationName": r.automationFlow?.name || 'N/A',
            "triggerType": r.automationFlow?.triggerType || 'N/A',
            // "entityType": r.triggerEntityType || 'N/A',
            "version": r.version?.versionString || 'N/A',
            "status": r.status,
            "steps": r.completedNodeIds?.length || 0,
            "startedAt": r.startedAt,
            "completedAt": r.completedAt,
            "error": r.errorMessage || '',
        }));
        exportData.forEach(t => worksheet.addRow(t));
        return await workbook.xlsx.writeBuffer();
    }

}

// قيد التغيل

// و الاعدادات التغيل التلقاءي