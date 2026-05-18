//  The brain. It manages the loop, reads the edges, updates the database state,
//  handles the try/catch blocks, and controls the Pausing/Resuming logic.

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AutomationFlowVersionEntity, AutomationRunEntity, AutomationRunStepEntity, FlowDefinition, FlowEdge, FlowNode, NodeConfig, RunStatus, SendWhatsappTemplateConfig, StepStatus } from 'entities/automation.entity';
import { Repository, DataSource } from 'typeorm';
import { VariableHydratorService } from './variableHydrator.service';
import { NodeHandlerResponse, NodeHandlersRegistry } from './nodeHandlers.registry';

@Injectable()
export class EngineRunnerService {
    private readonly logger = new Logger(EngineRunnerService.name);

    constructor(
        private readonly dataSource: DataSource,
        @InjectRepository(AutomationRunEntity)
        private readonly runRepo: Repository<AutomationRunEntity>,
        @InjectRepository(AutomationFlowVersionEntity)
        private readonly versionRepo: Repository<AutomationFlowVersionEntity>,
        @InjectRepository(AutomationRunStepEntity)
        private readonly stepRepo: Repository<AutomationRunStepEntity>,
        private readonly hydrator: VariableHydratorService,
        private readonly registry: NodeHandlersRegistry,
    ) { }

    /**
     * نقطة البداية لتشغيل الأتمتة (تستدعى من الـ Worker الخاص بـ BullMQ)
     */
    async startExecution(runId: string): Promise<void> {
        const run = await this.runRepo.findOne({ where: { id: runId } });
        if (!run || run.status !== RunStatus.PENDING) return;

        run.status = RunStatus.RUNNING;
        await this.runRepo.save(run);

        const version = await this.versionRepo.findOne({ where: { id: run.versionId } });
        if (!version) {
            await this.failRun(run, 'This automation version is no longer available. The execution was stopped before starting.');
            return;
        }

        // البحث عن أول عقدة تلي الـ Trigger مباشرة
        const firstNodeId = this.findNextNodeId(version.flow.edges, run.executionState.trigger.nodeId);
        if (!firstNodeId) {
            run.status = RunStatus.COMPLETED;
            await this.runRepo.save(run);
            //send notification to user
            return;
        }

        await this.runLoop(run, version.flow, firstNodeId);
    }

    async resumeFromWhatsappInteraction(originalMessageId: string, buttonText: string, buttonId?: string): Promise<void> {
        // 1. البحث السريع عن الخطوة التي أنتجت هذه الرسالة باستخدام JSONB Query (سريع جداً في Postgres)
        const step = await this.stepRepo.createQueryBuilder('step')
            .where(`step."outputData"->>'messageId' = :messageId`, { messageId: originalMessageId })
            .getOne();

        if (!step) {
            this.logger.warn(`Interactive reply received for message ${originalMessageId}, but no matching automation step was found.`);
            return;
        }

        const run = await this.runRepo.findOne({ where: { id: step.runId } });
        if (!run || run.status !== RunStatus.PAUSED) {
            this.logger.warn(`Automation run ${step.runId} is not in PAUSED state. Cannot resume.`);
            return;
        }

        const version = await this.versionRepo.findOne({ where: { id: run.versionId } });
        if (!version) return;

        // 2. جلب العقدة (Node) الخاصة بالواتساب من المخطط لمعرفة مساراتها
        const node = version.flow.nodes.find(n => n.id === step.nodeId);
        const branches = (node?.data?.config as SendWhatsappTemplateConfig)?.branches || [];

        // 3. مطابقة الزر الذي ضغطه العميل مع الفروع المتاحة في إعدادات العقدة
        const chosenBranch = branches.find((b: any) =>
            b.sourceButton?.id === buttonId ||
            b.sourceButton?.text === buttonText ||
            b.label === buttonText
        );

        if (!chosenBranch) {
            this.logger.error(`No matching branch found for button "${buttonText}" in node ${node.id}`);
            await this.failRun(run, `User clicked an invalid button that has no configured branch: ${buttonText}`);
            return;
        }

        // 4. تحديث الـ executionState التراكمي لتسجيل اختيار العميل قبل الاستكمال
        run.executionState.steps[step.nodeId].output = {
            ...run.executionState.steps[step.nodeId].output,
            buttonClicked: buttonText,
            chosenBranchId: chosenBranch.id
        };
        await this.runRepo.save(run);

        // 5. إيقاظ الأتمتة وتوجيهها للمسار الصحيح
        await this.resumeExecution(run.id, step.nodeId, chosenBranch.id);
    }

    /**
     * نقطة استكمال الأتمتة بعد الاستيقاظ من الـ Webhook (الـ Resume)
     */
    async resumeExecution(runId: string, resumedNodeId: string, chosenBranchId?: string): Promise<void> {
        const run = await this.runRepo.findOne({ where: { id: runId } });
        if (!run) return;

        run.status = RunStatus.RUNNING;
        await this.runRepo.save(run);

        const version = await this.versionRepo.findOne({ where: { id: run.versionId } });

        // عند الاستيقاظ، نتحرك فوراً إلى العقدة التالية للعقدة التي سببت الإيقاف
        const nextNodeId = this.findNextNodeId(version.flow.edges, resumedNodeId, chosenBranchId);

        if (!nextNodeId) {
            run.status = RunStatus.COMPLETED;
            await this.runRepo.save(run);
            return;
        }

        await this.runLoop(run, version.flow, nextNodeId);
    }

    /**
     * حلقة التحكم بالتنفيذ (The Traversal Loop)
     */
    private async runLoop(run: AutomationRunEntity, flow: FlowDefinition, startNodeId: string): Promise<void> {
        let currentNodeId = startNodeId;

        while (currentNodeId) {
            const node = flow.nodes.find(n => n.id === currentNodeId);
            if (!node) {
                await this.failRun(
                    run,
                    `The automation could not continue because the one of the steps is missing or was removed from the workflow configuration.`,
                );
                return;
            }

            // 1. معالجة وحقن البيانات الخاصة بالإعدادات عبر الـ Hydrator
            // const hydratedConfig = this.hydrator.hydrate(node.data.config, run.executionState);

            try {
                // 2. جلب الـ Handler المسؤول وتنفيذه
                const handler = this.registry.getHandler(node.data.type);
                // const result = await handler.execute(hydratedConfig, run);
                const result = await handler.execute(node.data.config, run);

                // 3. توثيق السجل والـ Step في قاعدة البيانات بـ Transaction واحد لضمان التزامن
                await this.saveStepResult(run, node, result);

                // 4. فحص ما إذا كانت الخطوة تطلب إيقاف مؤقت (مثل الانتظار لرد الواتساب)
                if (result.shouldPause) {
                    run.status = RunStatus.PAUSED;
                    await this.runRepo.save(run);
                    this.logger.log(`Run ${run.id} is now PAUSED at node ${currentNodeId}`);
                    return; // كسر الحلقة تماماً وفك الـ Thread
                }

                if (!result.success) {
                    await this.failRun(
                        run,
                        result.error ||
                        `The automation stopped because the step "${node.data.label}" could not be completed successfully.`,
                    );
                    return;
                }

                // 5. الانتقال للعقدة التالية بناءً على الـ edges والـ chosenBranch (إن وجد في حالات الشروط)
                currentNodeId = this.findNextNodeId(flow.edges, currentNodeId, result.chosenBranch);

            } catch (error) {
                await this.failRun(
                    run,
                    `An unexpected error occurred while executing the step "${node.data.label}". Please try again or review the automation configuration.`,
                );
                return;
            }
        }

        // إذا انتهت الحلقة ولم يعد هناك عقد تالية، تكتمل الأتمتة بنجاح
        run.status = RunStatus.COMPLETED;
        await this.runRepo.save(run);
        this.logger.log(`Run ${run.id} completed successfully`);
    }

    /**
     * محرك البحث عن العقدة التالية داخل مصفوفة الـ Edges
     */
    private findNextNodeId(edges: FlowEdge[], currentNodeId: string, sourceHandle?: string): string | null {
        const edge = edges.find(e => {
            if (sourceHandle) {
                return e.source === currentNodeId && e.sourceHandle === sourceHandle;
            }
            return e.source === currentNodeId;
        });
        return edge ? edge.target : null;
    }

    private async saveStepResult(run: AutomationRunEntity, node: FlowNode, result: NodeHandlerResponse) {
        await this.dataSource.transaction(async (manager) => {
            // تحديث كائن الـ executionState التراكمي
            run.executionState.steps[node.id] = {
                type: node.data.type,
                executedAt: new Date().toISOString(),
                output: result.output || {},
                error: result.error,
            };
            await manager.getRepository(AutomationRunEntity).save(run);

            // إنشاء سجل منفصل للـ Audit Log والـ UI
            const stepLog = manager.getRepository(AutomationRunStepEntity).create({
                runId: run.id,
                nodeId: node.id,
                nodeType: node.type,
                dataType: node.data.type,
                status: result.success ? StepStatus.SUCCESS : StepStatus.FAILED,
                outputData: result.output,
                errorMessage: result.error,
                executedAt: new Date()
            });
            await manager.getRepository(AutomationRunStepEntity).save(stepLog);
        });
    }

    private async failRun(run: AutomationRunEntity, errorMessage: string) {
        run.status = RunStatus.FAILED;
        run.errorMessage = errorMessage;
        await this.runRepo.save(run);
        this.logger.error(`Run ${run.id} failed: ${errorMessage}`);
    }
}