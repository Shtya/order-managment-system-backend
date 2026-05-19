import { Inject, Injectable, OnModuleDestroy, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AutomationFlowEntity, AutomationFlowVersionEntity, AutomationRunEntity, AutomationStatus, FlowNodeType, RunStatus, TriggerEntityType, TriggerType } from 'entities/automation.entity';
import { Repository, DataSource, In } from 'typeorm';
import { Queue } from 'groupmq';
import Redis from 'ioredis';
import { OrderEntity, AutomationMigrationStrategy } from 'entities/order.entity';
import { TriggerMatchersRegistry } from './triggerMatchers.registry';
import { OrdersService } from 'src/orders/services/orders.service';


export interface FlowExecutionJob {
    type: 'start' | 'resume';
    adminId: string;

    // For 'start'
    runId?: string;
    automationFlowId?: string;
    versionId?: string;

    // For 'resume'
    resumeData?: {
        originalMessageId: string;
        buttonText: string;
        buttonId?: string;
    };
}

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const redis = new Redis(redisUrl);

export const flowExecutionQueue = new Queue({
    redis,
    namespace: "flow-execution",
    jobTimeoutMs: 300000,   // 5m
    maxAttempts: 3,
});

@Injectable()
export class FlowExecutionQueueService implements OnModuleDestroy {
    /**
     * Add new flow execution job
     */
    async add(data: FlowExecutionJob, options: any = {}) {
        if (!data.adminId) return;

        const groupId = options.groupId ?? `admin:${data.adminId}:flow`;

        return await flowExecutionQueue.add({
            groupId,
            data,
            orderMs: Date.now(),
            maxAttempts: options.maxAttempts ?? 3,
            jobId: options.jobId,
        });
    }

    /**
     * Graceful shutdown
     */
    async onModuleDestroy() {
        await flowExecutionQueue.close();
        await redis.quit();
    }
}

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

        private readonly flowQueue: FlowExecutionQueueService,
        private readonly triggerMatchers: TriggerMatchersRegistry,

        @Inject(forwardRef(() => OrdersService))
        private readonly ordersService: OrdersService,
    ) { }

    /**
     * Entry point from application events
     */
    async dispatch(trigger: {
        type: TriggerType;
        entityType: TriggerEntityType;
        entityId: string;
        payload: any;
        adminId: string;
    }) {
        if (!trigger.adminId) return;

        const automations = await this.automationRepo.find({
            where: {
                adminId: trigger.adminId,
                triggerType: trigger.type,
                status: AutomationStatus.PUBLISHED,
            },
            relations: ['latestVersion'],
        });

        if (!automations.length) return;

        for (const automation of automations) {
            const shouldRun = this.shouldStartAutomation(
                automation,
                trigger,
            );

            if (!shouldRun) {
                continue;
            }

            await this.createRunAndQueue(automation, trigger);
        }
    }

    /**
     * Automatic migration logic for failed runs when a flow is updated
     */
    async autoRetryFailedRuns(adminId: string, automationFlowId: string) {
        const settings = await this.ordersService.getSettings({ id: adminId });
        const strategy = settings?.automationMigrationStrategy || AutomationMigrationStrategy.LATEST_PATCH;

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

        for (const run of failedRuns) {
            let shouldMigrate = false;
            const [currentMajorStr, currentMinorStr] = run.version?.versionString.split('.') || [];
            const currentMajor = parseInt(currentMajorStr, 10);

            if (strategy === AutomationMigrationStrategy.LATEST_MAJOR) {
                // Migrate everything to the newest version
                shouldMigrate = run.versionId !== newVersion.id;
            } else if (strategy === AutomationMigrationStrategy.LATEST_PATCH) {
                newVersion = await this.versionRepo.createQueryBuilder('version')
                    .where('version.automationFlowId = :automationFlowId', { automationFlowId: run.automationFlowId })
                    .andWhere("CAST(split_part(version.versionString, '.', 1) AS INTEGER) = :major", { major: currentMajor })
                    .orderBy("CAST(split_part(version.versionString, '.', 2) AS INTEGER)", 'DESC')
                    .getOne();
                if (!newVersion) continue;

                shouldMigrate = run.versionId !== newVersion.id;
            }

            if (shouldMigrate) {
                // Re-verify if the run still matches the trigger (e.g. if filters changed)
                const triggerData = {
                    type: automation.triggerType,
                    payload: run.initialPayload,
                };

                const stillMatches = this.shouldStartAutomation(automation, triggerData);

                if (stillMatches) {
                    run.versionId = newVersion.id;
                    run.version = newVersion;
                    run.status = RunStatus.PENDING;
                    run.errorMessage = null; // Clear previous error
                    await this.runRepo.save(run);

                    await this.flowQueue.add({
                        type: 'start',
                        runId: run.id,
                        automationFlowId: automation.id,
                        versionId: newVersion.id,
                        adminId,
                    });
                }
            }
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
        return await this.dataSource.transaction(async (manager) => {
            const runRepo = manager.getRepository(AutomationRunEntity);

            const version = automation.latestVersion;

            if (!version) {
                return;
            }

            const triggerNode = version.flow.nodes.find((node) => node.type === FlowNodeType.TRIGGER);
            if (!triggerNode) {
                return;
            }
            // 1. Create run
            const run = runRepo.create({
                automationFlowId: automation.id,
                versionId: version.id,

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

            // 2. Push to queue
            await this.flowQueue.add({
                type: 'start',
                runId: savedRun.id,
                automationFlowId: automation.id,
                versionId: version.id,
                adminId: automation.adminId,
            });

            return savedRun;
        });
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

