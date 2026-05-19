import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AutomationFlowEntity, AutomationRunEntity, AutomationStatus, FlowNodeType, RunStatus, TriggerEntityType, TriggerType } from 'entities/automation.entity';
import { Repository, DataSource } from 'typeorm';
import { Queue } from 'groupmq';
import Redis from 'ioredis';
import { OrderEntity } from 'entities/order.entity';
import { TriggerMatchersRegistry } from './triggerMatchers.registry';


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

        @InjectRepository(AutomationRunEntity)
        private readonly runRepo: Repository<AutomationRunEntity>,

        private readonly flowQueue: FlowExecutionQueueService,
        private readonly triggerMatchers: TriggerMatchersRegistry,
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

