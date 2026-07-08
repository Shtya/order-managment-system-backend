
import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { AutomationJobs, QueueNames } from "../common/queue.constants";
import { Job, JobsOptions, MetricsTime, Queue } from "bullmq";
import { QueueDelayConfig, QueueDelayService } from "../common/queue-delay.service";
import { EngineRunnerService } from "src/automation/engine/engineRunner.service";

@Injectable()
export class AutomationQueueService {
    constructor(
        @InjectQueue(QueueNames.AUTOMATIONS)
        private readonly automationsQueue: Queue,
    ) { }

    private async addJob(
        adminId: string,
        type: string,
        data: any,
        options: JobsOptions = {},
    ) {
        if (!adminId) return;

        return await this.automationsQueue.add(
            type,
            {
                ...data,
                type,
                adminId,
            },
            {
                // jobId: options.jobId,
                ...options,
                jobId: undefined,
            }
        );
    }

    async enqueueStartFlow(runId: string, automationFlowId: string, versionId: string, adminId: string) {
        const jobId = `start-flow:${adminId}:${runId}`;
        await this.addJob(adminId, AutomationJobs.START, {
            runId,
            automationFlowId,
            versionId,
        }, { jobId });
    }

    async enqueueResumeFlow(adminId: string, resumeData: { originalMessageId: string; buttonText: string; buttonId: string }) {
        const jobId = `resume-flow:${adminId}:${resumeData.originalMessageId}`;
        await this.addJob(adminId, AutomationJobs.RESUME, {
            resumeData,
        }, { jobId });
    }
}

@Processor(QueueNames.AUTOMATIONS, {
    concurrency: 10,
    maxStartedAttempts: 200,
    metrics: {
        maxDataPoints: MetricsTime.ONE_WEEK * 2,
    },
})
export class AutomationWorkerService extends WorkerHost {
    private readonly logger = new Logger(AutomationWorkerService.name);
    private readonly queueConfig: Partial<QueueDelayConfig> = {
        keyPrefix: 'automations',
        maxPerUser: 5,
    };

    constructor(
        private readonly queueDelayService: QueueDelayService,
        @Inject(forwardRef(() => EngineRunnerService))
        private readonly engineRunner: EngineRunnerService,
    ) {
        super();
    }

    async process(job: Job, token?: string): Promise<any> {
        const { adminId } = job.data;
        return this.queueDelayService.acquireUserSlotAndProcess(
            job,
            token,
            adminId,
            () => this.handleJob(job),
            this.queueConfig,
        );
    }

    private async handleJob(job: Job): Promise<any> {
        const { type, runId, resumeData } = job.data;
        this.logger.debug(`Processing Job ${job.id} | Type: ${type}`);

        try {
            if (type === AutomationJobs.START && runId) {
                this.logger.log(`=== STARTING Job ${job.id} | Type: ${type} | Executing startExecution for run ${runId}`);
                await this.engineRunner.startExecution(runId);
                this.logger.log(`=== SUCCESS: Finished job ${job.id} (run ${runId})`);
            } else if (type === AutomationJobs.RESUME && resumeData) {
                this.logger.log(`=== STARTING Job ${job.id} | Type: ${type} | Executing resumeFromWhatsappInteraction`);
                await this.engineRunner.resumeFromWhatsappInteraction(
                    resumeData.originalMessageId,
                    resumeData.buttonText,
                    resumeData.buttonId
                );
                this.logger.log(`=== SUCCESS: Finished resume job ${job.id}`);
            }
        } catch (error) {
            this.logger.error(`=== ERROR processing job ${job.id}:`, error);
            throw error; // rethrow to let BullMQ handle retries
        }
    }
}
