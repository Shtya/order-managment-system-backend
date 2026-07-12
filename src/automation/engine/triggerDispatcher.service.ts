import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AutomationFlowEntity, AutomationFlowVersionEntity, AutomationRunEntity, AutomationStatus, FlowNodeType, RunStatus, TriggerEntityType, TriggerType } from 'entities/automation.entity';
import { Repository, DataSource, In } from 'typeorm';
import { OrderEntity } from 'entities/order.entity';
import { TriggerMatchersRegistry } from './triggerMatchers.registry';
import { OrdersService } from 'src/orders/services/orders.service';
import { AutomationQueueService } from 'src/queue/queues/automations.queue';
import { AutomationMigrationStrategy } from 'entities/clientSettings.entity';
import { ClientSettingsService } from 'src/client-settings/client-settings.service';

@Injectable()
export class TriggerDispatcherService {
    constructor(
        private readonly dataSource: DataSource,

        @InjectRepository(AutomationFlowEntity)
        private readonly automationRepo: Repository<AutomationFlowEntity>,

        @InjectRepository(AutomationFlowVersionEntity)
        private readonly versionRepo: Repository<AutomationFlowVersionEntity>,

        @InjectRepository(AutomationRunEntity)
        private readonly runRepo: Repository<AutomationRunEntity>,

        @InjectRepository(OrderEntity)
        private readonly orderRepo: Repository<OrderEntity>,
        @Inject(forwardRef(() => AutomationQueueService))
        private readonly automationQueueService: AutomationQueueService,
        private readonly triggerMatchers: TriggerMatchersRegistry,

        @Inject(forwardRef(() => OrdersService))
        private readonly ordersService: OrdersService,
        private readonly clientSettingsService: ClientSettingsService,
    ) { }

    /**
     * Entry point from application events
     */
    async dispatch(trigger: {
        type: TriggerType;
        entityType: TriggerEntityType;
        entityId: string;
        payload: any | null;
        adminId: string;
        orderId?: string;
    }) {
        if (trigger.entityType === TriggerEntityType.ORDER && trigger.orderId && !trigger.payload) {
            const order = await this.orderRepo.findOne({
                where: { id: trigger.orderId },
                select: ['id', 'adminId', 'oldStatusId', 'statusId', 'externalId'],
            });
            if (!order) {
                console.log(`[TriggerDispatcher] Order ${trigger.orderId} not found, skipping`);
                return;
            }
            trigger.payload = order;
        }
        console.log(`[TriggerDispatcher] Received dispatch request for ${trigger.type} on ${trigger.entityType} ${trigger.entityId} (admin: ${trigger.adminId})`);
        if (!trigger.adminId) {
            console.log(`[TriggerDispatcher] No adminId provided, skipping`);
            return;
        }

        const automations = await this.automationRepo.find({
            where: {
                adminId: trigger.adminId,
                triggerType: trigger.type,
                status: AutomationStatus.PUBLISHED,
            },
            relations: ['latestVersion'],
        });

        console.log(`[TriggerDispatcher] Found ${automations.length} published automations for ${trigger.type}`);

        if (!automations.length) {
            console.log(`[TriggerDispatcher] No automations found, skipping`);
            return;
        }

        for (const automation of automations) {
            console.log(`[TriggerDispatcher] Checking automation ${automation.id} (${automation.name})`);
            const shouldRun = this.shouldStartAutomation(
                automation,
                trigger,
            );
            console.log(`[TriggerDispatcher] Automation ${automation.id} should run: ${shouldRun}`);

            if (!shouldRun) {
                console.log(`[TriggerDispatcher] Automation ${automation.id} skipped (shouldRun is false)`);
                continue;
            }

            console.log(`[TriggerDispatcher] Starting createRunAndQueue for automation ${automation.id}`);
            await this.createRunAndQueue(automation, trigger);
            console.log(`[TriggerDispatcher] Finished createRunAndQueue for automation ${automation.id}`);
        }
    }

    /**
     * Automatic migration logic for failed runs when a flow is updated
     */
    async autoRetryFailedRuns(adminId: string, automationFlowId: string) {
        const settings = await this.clientSettingsService.getCachedSettings(adminId);
        const strategy = settings?.automationMigrationStrategy || AutomationMigrationStrategy.LATEST_MAJOR;

        if (strategy === AutomationMigrationStrategy.MANUAL) {
            return;
        }
        
        const automation = await this.automationRepo.findOne({
            where: { id: automationFlowId, adminId },
            relations: ['latestVersion'],
        });

        if (!automation || !automation.latestVersion) return;

        const failedRuns = await this.runRepo.find({
            where: {
                automationFlowId,
                status: In([RunStatus.FAILED]), // Also retry paused ones if they need migration
            },
            relations: ['version'],
        });

        if (!failedRuns.length) return;

        let newVersion = automation.latestVersion;

        // Define your batch size here (e.g., 10 runs at a time)
        const BATCH_SIZE = 5;

        // Loop through the array in chunks of BATCH_SIZE
        for (let i = 0; i < failedRuns.length; i += BATCH_SIZE) {
            const batch = failedRuns.slice(i, i + BATCH_SIZE);

            // Process the current batch in parallel
            await Promise.all(
                batch.map(async (run) => {
                    run.versionId = newVersion.id;
                    run.version = newVersion;
                    run.currentNodeId = null;
                    run.completedNodeIds = [];
                    run.executionState = {
                        trigger: run.executionState.trigger,
                        steps: {},
                    };
                    run.status = RunStatus.PENDING;
                    run.errorMessage = null;

                    await this.runRepo.save(run);

                    await this.automationQueueService.enqueueStartFlow(
                        run.id,
                        automation.id,
                        newVersion.id,
                        adminId,
                    );


                })
            );
        }
    }

    /**
     * Create run + push to queue
     */
    private async createRunAndQueue(
        automation: AutomationFlowEntity,
        trigger: {
            type: TriggerType;
            entityType: TriggerEntityType;
            entityId: string;
            payload: any;
        },
    ) {
        console.log(`[TriggerDispatcher] createRunAndQueue called for automation ${automation.id}`);
        try {
            const result = await this.dataSource.transaction(async (manager) => {
                console.log(`[TriggerDispatcher] Starting transaction for createRunAndQueue`);
                const runRepo = manager.getRepository(AutomationRunEntity);

                const version = automation.latestVersion;
                console.log(`[TriggerDispatcher] Using automation version ${version?.id}`);

                if (!version) {
                    console.log(`[TriggerDispatcher] No version found, skipping`);
                    return;
                }

                const triggerNode = version.flow.nodes.find((node) => node.type === FlowNodeType.TRIGGER);
                if (!triggerNode) {
                    console.log(`[TriggerDispatcher] No trigger node found in flow, skipping`);
                    return;
                }

                // 1. Create run
                console.log(`[TriggerDispatcher] Creating new automation run`);
                const run = runRepo.create({
                    automationFlowId: automation.id,
                    versionId: version.id,
                    adminId: automation.adminId,
                    status: RunStatus.PENDING,

                    triggerEntityType: trigger.entityType,
                    triggerEntityId: trigger.entityId,

                    initialPayload: trigger.payload,

                    executionState: {
                        trigger: {
                            nodeId: triggerNode.id,
                            type: trigger.type,
                            output: trigger.payload,
                        },
                        steps: {},
                    },
                });

                const savedRun = await runRepo.save(run);
                console.log(`[TriggerDispatcher] Automation run ${savedRun.id} saved successfully`);

                // 2. Push to queue
                console.log(`[TriggerDispatcher] Adding job to flow queue for run ${savedRun.id}`);
                await this.automationQueueService.enqueueStartFlow(
                    savedRun.id,
                    automation.id,
                    version.id,
                    automation.adminId,
                );
                console.log(`[TriggerDispatcher] Job added to queue successfully for run ${savedRun.id}`);

                return savedRun;
            });

            console.log(`[TriggerDispatcher] createRunAndQueue completed successfully`);
            return result;
        } catch (error) {
            console.error(`[TriggerDispatcher] Error in createRunAndQueue:`, error);
            throw error;
        }
    }

    private shouldStartAutomation(
        automation: AutomationFlowEntity,
        trigger: {
            type: TriggerType;
            payload: any;
        },
    ): boolean {

        const flow = automation.latestVersion?.flow;

        if (!flow?.nodes?.length) {
            return false;
        }

        // Find trigger node
        const triggerNode = flow.nodes.find(
            n => n.type === FlowNodeType.TRIGGER,
        );

        if (!triggerNode) {
            return false;
        }

        try {
            const matcher = this.triggerMatchers.getMatcher(trigger.type);
            return matcher.shouldRun(triggerNode.data.config, trigger.payload);
        } catch (error) {
            return false;
        }
    }
}

