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
        private readonly redisService: RedisService
    ) { }

    async onModuleInit() {
        this.logger.log(`Starting Worker for Queue: [${flowExecutionQueue.name || 'unknown'}]`);

        const name = flowExecutionQueue.name || 'unknown';
        const redis = flowExecutionQueue.redis;
        
        await this.redisService.fullStalledJobsRecovery(name, redis);
       
        this.worker = new Worker({
            queue: flowExecutionQueue,
            concurrency: 10,
            maxAttempts: 3,
            blockingTimeoutSec: 10,
            stalledGracePeriod: 8000, 
            stalledInterval: 15000,
            maxStalledCount: 2,
            heartbeatMs: 3000,
            handler: async (job: ReservedJob) => {
                this.logger.log(`=== STARTING Job ${job.id} | Type: ${job.data.type} | Group: ${job.groupId}`);
                const { type, runId, resumeData } = job.data;

                try {
                    if (type === 'start' && runId) {
                        this.logger.log(`Executing startExecution for run ${runId}`);
                        await this.engineRunner.startExecution(runId);
                        this.logger.log(`=== SUCCESS: Finished job ${job.id} (run ${runId})`);
                    } else if (type === 'resume' && resumeData) {
                        this.logger.log(`Executing resumeFromWhatsappInteraction`);
                        await this.engineRunner.resumeFromWhatsappInteraction(
                            resumeData.originalMessageId,
                            resumeData.buttonText,
                            resumeData.buttonId
                        );
                        this.logger.log(`=== SUCCESS: Finished resume job ${job.id}`);
                    }
                } catch (error) {
                    this.logger.error(`=== ERROR processing job ${job.id}:`, error);
                    throw error; // rethrow to let groupmq handle retries
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

        this.logger.log("Flow Worker starting to listen for jobs...");
        this.worker.run();
    }

    onModuleDestroy() {
        this.logger.log("Stopping Flow Worker...");
        this.worker?.close();
    }
}


// [Nest] 21260  - 06/13/2026, 1:02:15 AM     LOG [RedisService] Starting full stalled jobs recueue: flow-execution
// [Nest] 21260  - 06/13/2026, 1:02:15 AM    WARN [RedisService] 🔴 ORPHANED JOB DETECTED: 98b6c34-a554-b27a40650cec in processing but not in active list of group admin:a6b43ddf-28df-49618f5dc47:flow
// [Nest] 21260  - 06/13/2026, 1:02:15 AM     LOG [RedisService] ✅ FIXED orphaned job 98b6af59a
// 554-b27a40650cec - restored to group admin:a6b43ddf-28df-4961-b457-873fc8f5dc47:flow
// [Nest] 21260  - 06/13/2026, 1:02:15 AM     LOG [RedisService] 🔧 Fixed 1 orphaned processing
// [Nest] 21260  - 06/13/2026, 1:02:15 AM     LOG [RedisService] 🔓 Removing stale group locks ce: flow-execution
// [Nest] 21260  - 06/13/2026, 1:02:15 AM     LOG [RedisService] ✅ Successfully removed 0 stalk
// s

// [Nest] 21260  - 06/13/2026, 1:02:15 AM     LOG [RedisService] ✓ Removed 0 stale locks for quxecution
// [Nest] 21260  - 06/13/2026, 1:02:15 AM   DEBUG [RedisService] Stalled jobs info - Processing locks: 0
// [Nest] 21260  - 06/13/2026, 1:02:15 AM     LOG [RedisService] ✓ Found 0 jobs in processing flow-execution
// [Nest] 21260  - 06/13/2026, 1:02:15 AM     LOG [RedisService] ✓ Found 0 groups with locks foow-execution
// [Nest] 21260  - 06/13/2026, 1:02:15 AM     LOG [RedisService] ⚡ Manually recovering stalledl
// ow-execution
// [Nest] 21260  - 06/13/2026, 1:02:15 AM     LOG [RedisService] ✅ No stalled jobs found
// [Nest] 21260  - 06/13/2026, 1:02:15 AM     LOG [RedisService] ✓ Recovered 0 stalled jobs forw-execution
// [Nest] 21260  - 06/13/2026, 1:02:15 AM     LOG [RedisService] ✅ Full recovery complete - que
// cution is ready!
// [Nest] 21260  - 06/13/2026, 1:02:17 AM     LOG [RedisService] Conne