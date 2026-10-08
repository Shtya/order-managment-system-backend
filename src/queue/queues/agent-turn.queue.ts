import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { Job, MetricsTime, Queue } from "bullmq";
import { randomUUID } from "crypto";
import { RedisService } from "common/redis/RedisService";
import { AgentRuntimeService } from "src/agents/agent-runtime.service";
import { AgentPauseCatchupService } from "src/agents/runtime/agent-pause-catchup.service";
import {
  AgentTurnJobs,
  AgentTurnJobData,
  AgentPlaygroundJobData,
  AgentTurnsJobData,
  QueueNames,
} from "../common/queue.constants";
import { AGENT_SESSION_TIMEOUT_MS } from "src/agents/runtime/agent-runtime.constants";
import { AgentSessionService } from "src/agents/runtime/agent-session.service";
import { AgentPlaygroundService } from "src/agents/runtime/agent-playground.service";
import {
  PLAYGROUND_GATHER_MAX_MS,
  PLAYGROUND_GATHER_MS,
  PLAYGROUND_TTL_SECONDS,
  playgroundLaneKeys,
  playgroundRedisKey,
} from "src/agents/runtime/agent-playground.session";

export type { AgentTurnJobData, AgentPlaygroundJobData };

/**
 * Per-conversation agent lane (architecture §8):
 * - every inbound message is pushed to `pending` (never dropped);
 * - `state` is the single source of truth: absent = idle,
 *   `scheduled:<jobId>` = delayed job gathering a burst, `active:<jobId>` = agent running;
 * - a burst waits SHORT_WAIT_MS after the last message, capped at MAX_WAIT_MS from the first;
 * - messages arriving while the agent runs are drained right after the current turn,
 *   inside the same job, with no extra wait.
 * All state transitions are Lua scripts so the webhook and the worker can't race.
 */
const SHORT_WAIT_MS = 3; // wait 0.8s after the last message
const MAX_WAIT_MS = 2500;  // but never wait more than 2.5s in total
// Safety net if a worker dies mid-turn: the lane unlocks by itself after this.
export const STATE_TTL_SECONDS = 10 * 60; // if something crashes, unlock after 10 minutes
const PENDING_TTL_SECONDS = 24 * 3600; // delete forgotten message lists after 1 day

const pauseCatchupJobId = (conversationId: string) => `agent-pause-catchup-${conversationId}`;
const pauseCatchupRetryJobId = (conversationId: string) => `agent-pause-catchup-${conversationId}-retry`;
const idleCloseJobId = (sessionId: string) => `agent-idle-${sessionId}`;

const agentTurnKeys = (conversationId: string) => ({
  pending: `agent-turn:pending:${conversationId}`,
  state: `agent-turn:state:${conversationId}`,
  firstAt: `agent-turn:first-at:${conversationId}`,
});

// KEYS: pending, state, firstAt | ARGV: messageId, newJobId, now, stateTtl, pendingTtl
// Returns {"new"} when the caller must create the job, otherwise {state, firstAt}.
const PUSH_SCRIPT = `
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[5])
local state = redis.call('GET', KEYS[2])
if not state then
  redis.call('SET', KEYS[2], 'scheduled:' .. ARGV[2], 'EX', ARGV[4])
  redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
  return {'new'}
end
return {state, redis.call('GET', KEYS[3]) or ARGV[3]}
`;

// KEYS: state, firstAt | ARGV: jobId, stateTtl
const CLAIM_SCRIPT = `
local state = redis.call('GET', KEYS[1])
if state ~= 'scheduled:' .. ARGV[1] and state ~= 'active:' .. ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], 'active:' .. ARGV[1], 'EX', ARGV[2])
redis.call('DEL', KEYS[2])
return 1
`;

// KEYS: pending
const DRAIN_SCRIPT = `
local ids = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('DEL', KEYS[1])
return ids
`;

// KEYS: state, pending | ARGV: jobId, stateTtl
// 1 = more messages arrived, keep going; 0 = lane released (or no longer ours).
const CONTINUE_OR_RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= 'active:' .. ARGV[1] then
  return 0
end
if redis.call('LLEN', KEYS[2]) > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return 1
end
redis.call('DEL', KEYS[1])
return 0
`;

// KEYS: state | ARGV: expected
const CLEAR_IF_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

@Injectable()
export class AgentTurnQueueService {
  private readonly logger = new Logger(AgentTurnQueueService.name);

  constructor(
    @InjectQueue(QueueNames.AGENT_TURNS)
    private readonly agentTurnsQueue: Queue<AgentTurnsJobData>,
    private readonly redisService: RedisService,
  ) {}

  async enqueueMessage(data: AgentTurnJobData & { messageId: string }) {
    const { messageId, ...jobData } = data;
    if (!jobData.adminId || !jobData.conversationId || !messageId) return;

    const keys = agentTurnKeys(jobData.conversationId);
    // BullMQ custom job IDs cannot contain ":".
    const newJobId = `agent-turn-${jobData.conversationId}-${randomUUID()}`;

    const [state, firstAtRaw] = (await this.redisService.redisClient.eval(
      PUSH_SCRIPT,
      3,
      keys.pending,
      keys.state,
      keys.firstAt,
      messageId,
      newJobId,
      String(Date.now()),
      String(STATE_TTL_SECONDS),
      String(PENDING_TTL_SECONDS),
    )) as [string, string?];

    if (state === "new") {
      try {
        await this.agentTurnsQueue.add(AgentTurnJobs.PROCESS_TURN, jobData, {
          jobId: newJobId,
          delay: SHORT_WAIT_MS,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: 100,
        });
      } catch (error) {
        await this.redisService.redisClient.eval(
          CLEAR_IF_SCRIPT,
          1,
          keys.state,
          `scheduled:${newJobId}`,
        );
        throw error;
      }
      return;
    }

    if (state.startsWith("scheduled:")) {
      await this.slideDelay(
        state.slice("scheduled:".length),
        Number(firstAtRaw) || Date.now(),
      );
    }
    // "active:<jobId>": the running worker drains this message before it releases the lane.
  }

  async enqueuePlayground(data: AgentPlaygroundJobData, inboundJson: string) {
    if (!data.adminId || !data.dashboardUserId || !data.hashId || !inboundJson) return "idle";

    const keys = playgroundLaneKeys(playgroundRedisKey(data.adminId, data.dashboardUserId));
    const newJobId = `pg-turn-${data.dashboardUserId}-${randomUUID()}`;

    const [state, firstAtRaw] = (await this.redisService.redisClient.eval(
      PUSH_SCRIPT,
      3,
      keys.pending,
      keys.state,
      keys.firstAt,
      inboundJson,
      newJobId,
      String(Date.now()),
      String(STATE_TTL_SECONDS),
      String(PLAYGROUND_TTL_SECONDS),
    )) as [string, string?];

    if (state === "new") {
      try {
        await this.agentTurnsQueue.add(AgentTurnJobs.PROCESS_PLAYGROUND, data, {
          jobId: newJobId,
          delay: PLAYGROUND_GATHER_MS,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: 100,
        });
      } catch (error) {
        await this.redisService.redisClient.eval(
          CLEAR_IF_SCRIPT,
          1,
          keys.state,
          `scheduled:${newJobId}`,
        );
        throw error;
      }
      return "new";
    }

    if (state.startsWith("scheduled:")) {
      await this.slideDelay(
        state.slice("scheduled:".length),
        Number(firstAtRaw) || Date.now(),
        PLAYGROUND_GATHER_MS,
        PLAYGROUND_GATHER_MAX_MS,
      );
      return "scheduled";
    }

    return "active";
  }

  async enqueueTaskStart(data: AgentTurnJobData, delayMs = 0) {
    if (!data.adminId || !data.conversationId || !data.taskId) return;
    const jobId = `agent-task-start-${data.conversationId}-${data.taskId}`;
    const existing = await this.agentTurnsQueue.getJob(jobId);
    if (existing) {
      try {
        await existing.remove();
      } catch {
        // Already running; a duplicate start is harmless because the task is already open.
      }
    }
    await this.agentTurnsQueue.add(AgentTurnJobs.TASK_START, data, {
      jobId,
      delay: Math.max(0, delayMs),
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: 50,
    });
  }

  async schedulePauseCatchup(data: AgentTurnJobData, pausedUntil: Date) {
    if (!data.adminId || !data.conversationId) return;
    const delay = Math.max(0, pausedUntil.getTime() - Date.now());
    await this.removePauseCatchupJobs(data.conversationId);
    try {
      await this.agentTurnsQueue.add(AgentTurnJobs.PAUSE_CATCHUP, data, {
        jobId: pauseCatchupJobId(data.conversationId),
        delay,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 50,
      });
    } catch (error) {
      this.logger.debug(
        `Could not schedule pause catch-up for ${data.conversationId}: ${error?.message}`,
      );
      await this.agentTurnsQueue.add(AgentTurnJobs.PAUSE_CATCHUP, data, {
        jobId: pauseCatchupRetryJobId(data.conversationId),
        delay,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 50,
      });
    }
  }

  async scheduleIdleClose(data: {
    adminId: string;
    conversationId: string;
    sessionId: string;
    providerId?: string | null;
  }) {
    if (!data.sessionId) return;
    const jobId = idleCloseJobId(data.sessionId);
    const existing = await this.agentTurnsQueue.getJob(jobId);
    if (existing) {
      try {
        await existing.remove();
      } catch {
        // Job already active; a second close is a no-op if the session is ended.
      }
    }
    await this.agentTurnsQueue.add(
      AgentTurnJobs.CLOSE_IDLE_SESSION,
      {
        adminId: data.adminId,
        accountId: null,
        conversationId: data.conversationId,
        sessionId: data.sessionId,
        providerId: data.providerId ?? null,
      },
      {
        jobId,
        delay: AGENT_SESSION_TIMEOUT_MS,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 20,
      },
    );
  }

  private async removePauseCatchupJobs(conversationId: string) {
    for (const jobId of [pauseCatchupJobId(conversationId), pauseCatchupRetryJobId(conversationId)]) {
      const existing = await this.agentTurnsQueue.getJob(jobId);
      if (!existing) continue;
      try {
        await existing.remove();
      } catch {
        // Active job of this catch-up; a retry job is added instead.
      }
    }
  }

  private async slideDelay(
    jobId: string,
    firstAt: number,
    shortWaitMs = SHORT_WAIT_MS,
    maxWaitMs = MAX_WAIT_MS,
  ) {
    const job = await this.agentTurnsQueue.getJob(jobId);
    if (!job) return;

    const remaining = maxWaitMs - (Date.now() - firstAt);
    try {
      if (remaining <= 0) {
        await job.promote();
      } else {
        await job.changeDelay(Math.min(shortWaitMs, remaining));
      }
    } catch (error) {
      // The job already left the delayed state; the worker picks the message up anyway.
      this.logger.debug(
        `Could not reschedule agent turn ${jobId}: ${error?.message}`,
      );
    }
  }
}

@Processor(QueueNames.AGENT_TURNS, {
  concurrency: 20,
  metrics: {
    maxDataPoints: MetricsTime.ONE_WEEK * 2,
  },
})
export class AgentTurnWorkerService extends WorkerHost {
  private readonly logger = new Logger(AgentTurnWorkerService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(forwardRef(() => AgentRuntimeService))
    private readonly agentRuntime: AgentRuntimeService,
    @Inject(forwardRef(() => AgentPauseCatchupService))
    private readonly pauseCatchup: AgentPauseCatchupService,
    @Inject(forwardRef(() => AgentTurnQueueService))
    private readonly agentTurnQueue: AgentTurnQueueService,
    @Inject(forwardRef(() => AgentSessionService))
    private readonly sessions: AgentSessionService,
    @Inject(forwardRef(() => AgentPlaygroundService))
    private readonly playground: AgentPlaygroundService,
  ) {
    super();
  }

  async process(job: Job<AgentTurnsJobData>): Promise<any> {
    if (job.name === AgentTurnJobs.PROCESS_PLAYGROUND) {
      return this.processPlayground(job as Job<AgentPlaygroundJobData>);
    }

    const data = job.data as AgentTurnJobData;

    if (job.name === AgentTurnJobs.CLOSE_IDLE_SESSION) {
      if (!data.sessionId) return { closed: false };
      const closed = await this.sessions.closeIdleIfDue(data.sessionId, data.providerId);
      return { closed };
    }

    if (job.name === AgentTurnJobs.TASK_START) {
      await this.agentRuntime.runTurn({
        adminId: data.adminId,
        accountId: data.accountId,
        conversationId: data.conversationId,
        messageIds: [],
        taskId: data.taskId,
      });
      return { taskStart: true };
    }

    if (job.name === AgentTurnJobs.PAUSE_CATCHUP) {
      const result = await this.pauseCatchup.run(data);
      if (result.rescheduleUntil) {
        setTimeout(() => {
          this.agentTurnQueue
            .schedulePauseCatchup(data, result.rescheduleUntil!)
            .catch((error) =>
              this.logger.error(
                `Failed to reschedule pause catch-up for ${data.conversationId}: ${error?.message}`,
                error?.stack,
              ),
            );
        }, 0);
        return result;
      }
      for (const messageId of result.messageIds) {
        await this.agentTurnQueue.enqueueMessage({
          adminId: data.adminId,
          accountId: result.accountId,
          conversationId: data.conversationId,
          messageId,
          catchUp: true,
        });
      }
      return result;
    }

    const { adminId, accountId, conversationId, catchUp } = data;
    const keys = agentTurnKeys(conversationId);
    const redis = this.redisService.redisClient;

    const claimed = await redis.eval(
      CLAIM_SCRIPT,
      2,
      keys.state,
      keys.firstAt,
      job.id,
      String(STATE_TTL_SECONDS),
    );
    if (claimed !== 1) {
      this.logger.debug(`Skipping stale agent turn job ${job.id}`);
      return { skipped: true };
    }

    let turns = 0;
    try {
      let more = true;
      while (more) {
        const messageIds = (await redis.eval(
          DRAIN_SCRIPT,
          1,
          keys.pending,
        )) as string[];

        if (messageIds.length) {
          turns++;
          try {
            await this.agentRuntime.runTurn({
              adminId,
              accountId,
              conversationId,
              messageIds,
              catchUp: !!catchUp,
            });
          } catch (error) {
            // Not rethrown: retrying a half-finished turn could send duplicate replies.
            this.logger.error(
              `Agent turn failed for conversation ${conversationId}: ${error?.message}`,
              error?.stack,
            );
          }
        }

        more =
          (await redis.eval(
            CONTINUE_OR_RELEASE_SCRIPT,
            2,
            keys.state,
            keys.pending,
            job.id,
            String(STATE_TTL_SECONDS),
          )) === 1;
      }
    } catch (error) {
      await redis.eval(CLEAR_IF_SCRIPT, 1, keys.state, `active:${job.id}`);
      throw error;
    }

    return { turns };
  }

  private async processPlayground(job: Job<AgentPlaygroundJobData>) {
    const { adminId, dashboardUserId, hashId } = job.data;
    if (!adminId || !dashboardUserId || !hashId) return { skipped: true };

    const keys = playgroundLaneKeys(playgroundRedisKey(adminId, dashboardUserId));
    const redis = this.redisService.redisClient;
    const claimed = await redis.eval(
      CLAIM_SCRIPT,
      2,
      keys.state,
      keys.firstAt,
      job.id,
      String(STATE_TTL_SECONDS),
    );
    if (claimed !== 1) {
      this.logger.debug(`Skipping stale playground job ${job.id}`);
      return { skipped: true };
    }

    try {
      return await this.playground.runLane(adminId, dashboardUserId, hashId, job.id!);
    } catch (error) {
      await redis.eval(CLEAR_IF_SCRIPT, 1, keys.state, `active:${job.id}`);
      throw error;
    }
  }
}
