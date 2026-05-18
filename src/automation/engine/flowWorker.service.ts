import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { Worker, ReservedJob } from "groupmq";
import { flowExecutionQueue } from "./triggerDispatcher.service";
import { EngineRunnerService } from "./engineRunner.service";
import { RedisService } from "common/redis/RedisService";
import Redis from "ioredis";

@Injectable()
export class FlowWorkerService implements OnModuleInit, OnModuleDestroy {
    protected readonly logger = new Logger(this.constructor.name);
    private worker: Worker;

    constructor(
        private readonly engineRunner: EngineRunnerService,
        private readonly redisService: RedisService,
    ) { }

    async onModuleInit() {
        this.logger.log(`Starting Worker for Queue: [${flowExecutionQueue.name || 'unknown'}]`);

        const namespace = flowExecutionQueue.namespace || 'groupmq';
        const redis = (flowExecutionQueue as any).redis as Redis;

        if (redis) {
            const deleted = await this.redisService.clearQueueRecoveryKeys(namespace, redis);
            if (deleted > 0) {
                this.logger.warn(`[Recovery] Cleared ${deleted} orphaned locks for ${namespace}`);
            }
        }

        this.worker = new Worker({
            queue: flowExecutionQueue,
            concurrency: 10,
            maxAttempts: 3,
            blockingTimeoutSec: 10,
            stalledInterval: 30000,
            maxStalledCount: 1,
            stalledGracePeriod: 0,
            handler: async (job: ReservedJob) => {
                this.logger.debug(`Processing Flow Job ${job.id} | Type: ${job.data.type} | Group: ${job.groupId}`);
                const { type, runId, resumeData } = job.data;

                if (type === 'start' && runId) {
                    await this.engineRunner.startExecution(runId);
                } else if (type === 'resume' && resumeData) {
                    await this.engineRunner.resumeFromWhatsappInteraction(
                        resumeData.originalMessageId,
                        resumeData.buttonText,
                        resumeData.buttonId
                    );
                }
            },
            onError: (err, job) => {
                this.logger.error(
                    `[Flow Worker Error] Queue: ${flowExecutionQueue.name} | Job: ${job?.id} | Group: ${job?.groupId}`,
                    err instanceof Error ? err.stack : err
                );
            },
        });

        this.worker.on('stalled', (jobId, groupId) => {
            this.logger.warn(`Job ${jobId} from group ${groupId} was stalled`);
        });

        this.worker.run();
    }

    onModuleDestroy() {
        this.logger.log("Stopping Flow Worker...");
        this.worker?.close();
    }
}
