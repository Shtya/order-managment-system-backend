//  The brain. It manages the loop, reads the edges, updates the database state,
//  handles the try/catch blocks, and controls the Pausing/Resuming logic.

import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ActionType, AutomationFlowEntity, AutomationFlowVersionEntity, AutomationRunEntity, AutomationRunStepEntity, FlowDefinition, FlowEdge, FlowNode, NodeConfig, RunStatus, SendWhatsappTemplateConfig, StepStatus } from 'entities/automation.entity';
import { Repository, DataSource } from 'typeorm';
import { VariableHydratorService } from './variableHydrator.service';
import { NodeHandlerResponse, NodeHandlersRegistry } from './nodeHandlers.registry';
import { NotificationService } from 'src/notifications/notification.service';
import { NotificationType } from 'entities/notifications.entity';
import { AppGateway } from 'common/app.gateway';
import { findNextNodeId } from './automation-helpers';
import { UpsellsService } from 'src/upsells/upsells.service';
import { WhatsappService } from 'src/whatsapp/whatsapp.service';
import { OrderEntity } from 'entities/order.entity';

@Injectable()
export class EngineRunnerService {
    private readonly logger = new Logger(EngineRunnerService.name);
    private readonly currentlyRunning = new Set<string>(); // In-memory set to track running runIds

    constructor(
        private readonly dataSource: DataSource,
        @InjectRepository(AutomationRunEntity)
        private readonly runRepo: Repository<AutomationRunEntity>,
        @InjectRepository(AutomationFlowVersionEntity)
        private readonly versionRepo: Repository<AutomationFlowVersionEntity>,
        @InjectRepository(AutomationFlowEntity)
        private readonly automationRepo: Repository<AutomationFlowEntity>,
        @InjectRepository(AutomationRunStepEntity)
        private readonly stepRepo: Repository<AutomationRunStepEntity>,
        private readonly hydrator: VariableHydratorService,
        private readonly registry: NodeHandlersRegistry,
        private readonly notificationService: NotificationService,
        private readonly appGateway: AppGateway,
        @Inject(forwardRef(() => UpsellsService))
        private readonly upsellsService: UpsellsService,
        @Inject(forwardRef(() => WhatsappService))
        private readonly whatsappService: WhatsappService,
    ) { }

    /**
     * نقطة البداية لتشغيل الأتمتة (تستدعى من الـ Worker الخاص بـ BullMQ)
     */
    async startExecution(runId: string): Promise<void> {
        this.logger.log(`=== EngineRunner.startExecution(${runId}) ===`);
        // Check if run is already in progress
        if (this.currentlyRunning.has(runId)) {
            this.logger.log(`Run ${runId} is already being executed, skipping duplicate request.`);
            return;
        }

        const run = await this.runRepo.findOne({ where: { id: runId } });
        if (!run) {
            this.logger.error(`Run ${runId} not found in database!`);
            return;
        }
        this.logger.log(`Found run ${runId} with status ${run.status}`);

        // Allow restarting PENDING, RUNNING, or FAILED runs!
        const allowedStatuses = [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.FAILED];
        if (!allowedStatuses.includes(run.status)) {
            this.logger.log(`Run ${runId} has status ${run.status}, skipping execution.`);
            return;
        }

        // Add to currently running set
        this.currentlyRunning.add(runId);
        this.logger.log(`Added ${runId} to currently running set (now has ${this.currentlyRunning.size} items)`);

        try {
            // If it's a new run or being restarted, set to RUNNING
            if (run.status !== RunStatus.RUNNING) {
                this.logger.log(`Setting run ${runId} to RUNNING`);
                await this.sendAutomationNotification(
                    run,
                    run.status === RunStatus.PENDING
                        ? NotificationType.AUTOMATION_RUN_STARTED
                        : NotificationType.AUTOMATION_RUN_RESUMED,
                    run.status === RunStatus.PENDING
                        ? 'Automation Run Started'
                        : 'Automation Run Restarted',
                    run.status === RunStatus.PENDING
                        ? 'A new automation execution has started.'
                        : 'An automation execution is being restarted.',
                );
            }

            run.status = RunStatus.RUNNING;
            run.errorMessage = null; // Clear any previous error when restarting
            await this.runRepo.save(run);


            const version = await this.versionRepo.findOne({ where: { id: run.versionId } });
            if (!version) {
                this.logger.error(`Version ${run.versionId} not found for run ${runId}`);
                await this.failRun(run, 'This automation version is no longer available. The execution was stopped before starting.');
                return;
            }
            this.logger.log(`Found version ${version.id} for run ${runId}`);

            // Determine where to start!
            let startNodeId: string | null = null;

            // If we have a currentNodeId, try starting from there or next node
            if (run.currentNodeId) {
                this.logger.log(`Run ${runId} has currentNodeId ${run.currentNodeId}`);
                // Check if current node was already completed
                const isCurrentNodeCompleted = run.completedNodeIds?.includes(run.currentNodeId);
                if (isCurrentNodeCompleted) {
                    this.logger.log(`Node ${run.currentNodeId} is already completed, finding next node`);
                    // Find the next node after current node
                    const currentNode = version.flow.nodes.find(n => n.id === run.currentNodeId);
                    const lastStep = run.executionState.steps[run.currentNodeId];
                    if (
                        (currentNode?.data?.config as any)?.branches?.length > 0 &&
                        !lastStep?.chosenBranch
                    ) {
                        // Need to choose a branch first! Pause the run again.
                        this.logger.log(`Run ${runId} needs to choose a branch first at node ${run.currentNodeId}`);
                        run.status = RunStatus.PAUSED;
                        await this.runRepo.save(run);
                        await this.emitRunUpdate(run);
                        return;
                    }
                    startNodeId = findNextNodeId(
                        version.flow.edges,
                        run.currentNodeId,
                        lastStep?.chosenBranch
                    );
                } else {
                    // Try starting from current node
                    this.logger.log(`Starting from current node ${run.currentNodeId}`);
                    startNodeId = run.currentNodeId;
                }
            }

            // If no start node found, start from beginning (first node after trigger)
            if (!startNodeId) {
                this.logger.log(`No start node found, starting from trigger`);
                startNodeId = findNextNodeId(version.flow.edges, run.executionState.trigger.nodeId);
            }
            this.logger.log(`Start node ID: ${startNodeId}`);

            if (!startNodeId) {
                this.logger.log(`No start node, marking run as completed`);
                run.status = RunStatus.COMPLETED;
                await this.runRepo.save(run);
                return;
            }

            this.logger.log(`Starting runLoop for ${runId} at node ${startNodeId}`);
            await this.runLoop(run, version.flow, startNodeId);
        } catch (error) {
            this.logger.error(`=== ERROR in startExecution(${runId}):`, error);
            await this.failRun(run, `Error in startExecution: ${error.message}`);
        } finally {
            // Always remove from currently running set when done
            this.currentlyRunning.delete(runId);
            this.logger.log(`=== EngineRunner.startExecution(${runId}) finished ===`);
        }
    }

    async resumeFromWhatsappInteraction(originalMessageId: string, buttonText: string, buttonId?: string): Promise<void> {
        // 1. البحث السريع عن الخطوة التي أنتجت هذه الرسالة باستخدام JSONB Query (سريع جداً في Postgres)
        // نبحث في الحقل الأساسي messageId أو داخل مصفوفة sentUpsells في حال وجود عروض متعددة
        const step = await this.stepRepo.createQueryBuilder('step')
            .where(`step."outputData"->>'messageId' = :messageId`, { messageId: originalMessageId })
            .orWhere(`EXISTS (
                SELECT 1 FROM jsonb_array_elements(step."outputData"->'sentUpsells') AS upsell 
                WHERE upsell->>'messageId' = :messageId
            )`, { messageId: originalMessageId })
            .getOne();

        if (!step) {
            this.logger.warn(`Interactive reply received for message ${originalMessageId}, but no matching automation step was found.`);
            return;
        }

        const run = await this.runRepo.findOne({ where: { id: step.runId } });
        let upsellApplyResultCode: string | undefined;

        // Special logic for Upsell: Apply before choosing branch
        if (step.dataType === ActionType.SEND_UPSELL && buttonId?.endsWith('_btn_0')) {
            const adminId = run.executionState.trigger.output.adminId;
            const me = { adminId };
            const result = await this.upsellsService.applyUpsellByMessageId(me, originalMessageId);
            upsellApplyResultCode = result.code;

            // Send feedback message to customer
            const orderData = run.executionState.trigger.output as OrderEntity;
            let feedbackText = '';
            if (result.success) {
                feedbackText = '✅ تمت إضافة العرض لطلبك بنجاح!';
            } else {
                if (result.code === 'UPSELL_EXPIRED') {
                    feedbackText = '❌ عذراً، هذا العرض قد انتهت صلاحيته.';
                } else if (result.code === 'ORDER_DELIVERED') {
                    feedbackText = '❌ عذراً، لا يمكن إضافة العرض حالياً لأن الطلب تم توصيله.';
                }
                else if (result.code === 'INVALID_ORDER_STATUS') {
                    feedbackText = '❌ عذراً، لا يمكن إضافة العرض حالياً لأن الطلب قيد التجهيز أو الشحن.';
                } else if (result.code === 'ALREADY_ACCEPTED') {
                    feedbackText = '❌ عذراً، هذا العرض تم إضافةه بالفعل.';
                }

                else {
                    feedbackText = '❌ عذراً، فشل إضافة العرض للطلب حالياً.';
                }
            }

            await this.whatsappService.sendMessage(
                me,
                {
                    to: orderData.normalizedPhoneNumber,
                    messaging_product: 'whatsapp',
                    type: 'text',
                    text: { body: feedbackText }
                }
            );
        }

        if (!run || run.status !== RunStatus.PAUSED) {
            this.logger.warn(`Automation run ${step.runId} is not in PAUSED state. Cannot resume.`);
            return;
        }

        if (run.currentNodeId !== step.nodeId) {
            await this.failRun(run, `Current node ID ${run.currentNodeId} does not match step node ID ${step.nodeId}. Cannot resume.`);
            return;
        }

        const version = await this.versionRepo.findOne({ where: { id: run.versionId } });
        if (!version) return;

        // 2. جلب العقدة (Node) الخاصة بالواتساب من المخطط لمعرفة مساراتها
        const node = version.flow.nodes.find(n => n.id === step.nodeId);
        const config = node?.data?.config as any;
        const branches = config?.branches || [];



        // 3. مطابقة الزر الذي ضغطه العميل مع الفروع المتاحة في إعدادات العقدة
        let chosenBranch = branches.find((b: any) =>
            b.sourceButton?.id === buttonId ||
            b.sourceButton?.text === buttonText ||
            b.label === buttonText
        );

        // Special handling for Send Upsell branching
        if (node?.data?.type === ActionType.SEND_UPSELL) {
            if (buttonId?.endsWith('_btn_0')) {
                // If clicked Accept
                if (upsellApplyResultCode === 'SUCCESS') {
                    chosenBranch = branches.find(b => b.id === 'accept' || b.label === 'accept');
                } else {
                    chosenBranch = branches.find(b => b.id === 'reject' || b.label === 'reject');
                }
            } else if (buttonId?.endsWith('_btn_1')) {
                // If clicked Reject
                chosenBranch = branches.find(b => b.id === 'client_reject' || b.label === 'client_reject');
            }
        }

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
        await this.sendAutomationNotification(
            run,
            NotificationType.AUTOMATION_RUN_RESUMED,
            'Automation Run Resumed',
            'A paused automation execution has been resumed.',
        );
        // 5. إيقاظ الأتمتة وتوجيهها للمسار الصحيح
        await this.resumeExecution(run.id, step.nodeId, chosenBranch.id);
    }

    /**
     * نقطة استكمال الأتمتة بعد الاستيقاظ من الـ Webhook (الـ Resume)
     */
    async resumeExecution(runId: string, resumedNodeId: string, chosenBranchId?: string): Promise<void> {
        // Check if run is already in progress
        if (this.currentlyRunning.has(runId)) {
            this.logger.log(`Run ${runId} is already being executed, skipping duplicate request.`);
            return;
        }

        const run = await this.runRepo.findOne({ where: { id: runId } });
        if (!run) return;

        // Add to currently running set
        this.currentlyRunning.add(runId);

        try {
            run.status = RunStatus.RUNNING;
            await this.runRepo.save(run);

            const version = await this.versionRepo.findOne({ where: { id: run.versionId } });

            // عند الاستيقاظ، نتحرك فوراً إلى العقدة التالية للعقدة التي سبقت الإيقاف
            const nextNodeId = findNextNodeId(version.flow.edges, resumedNodeId, chosenBranchId);

            if (!nextNodeId) {
                run.status = RunStatus.COMPLETED;
                await this.runRepo.save(run);
                return;
            }

            await this.runLoop(run, version.flow, nextNodeId);
        } finally {
            // Always remove from currently running set when done
            this.currentlyRunning.delete(runId);
        }
    }

    /**
     * حلقة التحكم بالتنفيذ (The Traversal Loop)
     */
    private async runLoop(run: AutomationRunEntity, flow: FlowDefinition, startNodeId: string): Promise<void> {
        this.logger.log(`=== Starting runLoop(${run.id}) at ${startNodeId} ===`);
        let currentNodeId = startNodeId;
        const completedNodeIds = [];
        if (run.status === RunStatus.COMPLETED) return;

        while (currentNodeId) {
            this.logger.log(`Processing node ${currentNodeId} in run ${run.id}`);
            const node = flow.nodes.find(n => n.id === currentNodeId);
            if (!node) {
                this.logger.error(`Node ${currentNodeId} not found in flow!`);
                await this.failRun(
                    run,
                    `The automation could not continue because the one of the steps is missing or was removed from the workflow configuration.`,
                );
                return;
            }
            this.logger.log(`Found node: ${node.data.type} (${node.data.label})`);
            
            // infinite loop detection
            if (completedNodeIds.includes(currentNodeId)) {
                this.logger.error(`Infinite loop detected at ${currentNodeId}`);
                await this.failRun(
                    run,
                    `The automation detected an infinite loop at node ${node.data.label}.`,
                );
                return;
            }

            // 1. معالجة وحقن البيانات الخاصة بالإعدادات عبر الـ Hydrator
            // const hydratedConfig = this.hydrator.hydrate(node.data.config, run.executionState);

            try {
                // 3. Skip if already finished successfully
                const savedStep = run.executionState.steps[currentNodeId];
                if (savedStep && savedStep.success) {
                    this.logger.log(`Node ${currentNodeId} already completed successfully. Skipping to next.`);
                    currentNodeId = findNextNodeId(flow.edges, currentNodeId, savedStep.chosenBranch);
                    continue;
                }
                //add delay 500ms to simulate real-time execution

                // 2. Track current node
                this.logger.log(`Setting current node to ${currentNodeId}`);
                run.currentNodeId = currentNodeId;
                await this.runRepo.save(run);

                // 4. جلب الـ Handler المسؤول وتنفيذه
                const handler = this.registry.getHandler(node.data.type);
                this.logger.log(`Got handler for node type ${node.data.type}`);
                const nodeConfig = node.data.config;
                // const result = await handler.execute(hydratedConfig, run);
                this.logger.log(`Executing handler for node ${currentNodeId}`);
                const result = await handler.execute(nodeConfig, run);
                this.logger.log(`Handler result:`, result);

                // 5. توثيق السجل والـ Step في قاعدة البيانات بـ Transaction واحد لضمان التزامن
                this.logger.log(`Saving step result for ${currentNodeId}`);
                await this.saveStepResult(run, node, result, nodeConfig);
                completedNodeIds.push(currentNodeId);
                await this.emitRunUpdate(run);

                // 6. فحص ما إذا كانت الخطوة تطلب إيقاف مؤقت (مثل الانتظار لرد الواتساب)
                if (result.shouldPause) {
                    this.logger.log(`Node ${currentNodeId} requested pause`);
                    run.status = RunStatus.PAUSED;
                    await this.runRepo.save(run);
                    await this.emitRunUpdate(run);
                    this.logger.log(`Run ${run.id} is now PAUSED at node ${currentNodeId}`);
                    return; // كسر الحلقة تماماً وفك الـ Thread
                }

                if (!result.success) {
                    this.logger.error(`Handler failed for node ${currentNodeId}: ${result.error}`);
                    await this.failRun(
                        run,
                        result.error ||
                        `The automation stopped because the step "${node.data.label}" could not be completed successfully.`,
                    );
                    return;
                }

                // 7. الانتقال للعقدة التالية بناءً على الـ edges والـ chosenBranch (إن وجد في حالات الشروط)
                this.logger.log(`Finding next node after ${currentNodeId} with branch ${result.chosenBranch}`);
                currentNodeId = findNextNodeId(flow.edges, currentNodeId, result.chosenBranch);
                this.logger.log(`Next node: ${currentNodeId}`);

            } catch (error) {
                this.logger.error(`=== ERROR in runLoop for node ${currentNodeId}:`, error);
                await this.failRun(
                    run,
                    `An unexpected error occurred while executing the step "${node.data.label}". Please try again or review the automation configuration.`,
                );
                return;
            }
        }

        // إذا انتهت الحلقة ولم يعد هناك عقد تالية، تكتمل الأتمتة بنجاح
        this.logger.log(`No more nodes, marking run ${run.id} as completed`);
        run.status = RunStatus.COMPLETED;
        run.completedAt = new Date();
        await this.runRepo.save(run);
        await this.emitRunUpdate(run);
        this.logger.log(`Run ${run.id} completed successfully`);

        await this.sendAutomationNotification(
            run,
            NotificationType.AUTOMATION_RUN_COMPLETED,
            'Automation Run Completed',
            'Automation execution finished successfully.',
        );
    }


    private async sendAutomationNotification(run: AutomationRunEntity, type: NotificationType, title: string, message: string) {
        try {
            const automation = await this.automationRepo.findOne({ where: { id: run.automationFlowId } });
            if (!automation) return;

            await this.notificationService.create({
                userId: automation.adminId,
                type,
                title,
                message: `${message} (Automation: ${automation.name}, Version: v${run.version?.versionString || ''})`,
                relatedEntityType: 'automation_run',
                relatedEntityId: run.id,
            });
        } catch (error) {
            this.logger.error(`Failed to send automation notification: ${error.message}`);
        }
    }

    private async emitRunUpdate(run: AutomationRunEntity) {
        try {
            const automation = await this.automationRepo.findOne({ where: { id: run.automationFlowId } });
            if (!automation) return;

            this.appGateway.emitAutomationRunStatus(automation.adminId, {
                runId: run.id,
                automationFlowId: run.automationFlowId,
                status: run.status,
                currentNodeId: run.currentNodeId,
                completedNodeIds: run.completedNodeIds,
                errorMessage: run.errorMessage,
                executionState: run.executionState,
            });
        } catch (error) {
            this.logger.error(`Failed to emit run update: ${error.message}`);
        }
    }

    private async saveStepResult(run: AutomationRunEntity, node: FlowNode, result: NodeHandlerResponse, input?: any) {
        await this.dataSource.transaction(async (manager) => {
            // تحديث كائن الـ executionState التراكمي
            run.executionState.steps[node.id] = {
                type: node.data.type,
                executedAt: new Date().toISOString(),
                success: result.success,
                chosenBranch: result.chosenBranch,
                input: input || {},
                output: result.output || {},
                error: result.error,
            };

            // 🌟 Update completed node tracking
            if (result.success) {
                if (!run.completedNodeIds) run.completedNodeIds = [];
                // save all ids even redendant to save number of steps
                run.completedNodeIds.push(node.id);

            }

            await manager.getRepository(AutomationRunEntity).save(run);

            // إنشاء سجل منفصل للـ Audit Log والـ UI
            const stepLog = manager.getRepository(AutomationRunStepEntity).create({
                runId: run.id,
                nodeId: node.id,
                nodeType: node.type,
                dataType: node.data.type,
                status: result.success ? StepStatus.SUCCESS : StepStatus.FAILED,
                inputData: input,
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
        await this.emitRunUpdate(run);
        this.logger.error(`Run ${run.id} failed: ${errorMessage}`);

        await this.sendAutomationNotification(
            run,
            NotificationType.AUTOMATION_RUN_FAILED,
            'Automation Run Failed',
            `Automation execution failed: ${errorMessage}`,
        );
    }
}