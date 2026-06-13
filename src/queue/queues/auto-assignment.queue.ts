import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { QueueNames } from "../common/queue.constants";
import { Job, JobsOptions, Queue } from "bullmq";
import { AssignmentMode, TimeUnit } from "entities/order.entity";
import { OrdersService } from "src/orders/services/orders.service";
import { v4 as uuidv4 } from 'uuid';
import { OrderAssignmentService } from "src/order-assignment/order-assignment.service";
import { createHash } from 'crypto';


@Injectable()
export class AutoAssignmentQueueService {
    constructor(
        @InjectQueue(QueueNames.AUTO_ASSIGNMENT)
        private readonly autoAssignmentQueue: Queue,
        @Inject(forwardRef(() => OrdersService))
        protected readonly ordersService: OrdersService,
    ) { }

    async addAutoAssignmentJob(
        data: { adminId: string; orderIds: string[] },
        opts?: JobsOptions,
    ) {
        if (!data?.adminId || !data?.orderIds?.length) return;

        // ⚙️ Load settings (move this outside if you want pure queue layer separation)
        const settings = await this.ordersService.getCachedSettings(data.adminId); // or inject OrdersService
        const assignmentMode = settings.assignmentMode;

        if (assignmentMode === AssignmentMode.DISABLED) {
            return;
        }

        // ⏱ delay calculation
        let delayMs = 0;

        if (assignmentMode === AssignmentMode.DELAYED) {
            const { assignmentDelay, assignmentDelayUnit } = settings;

            const unitMultiplier = {
                [TimeUnit.MINUTES]: 60 * 1000,
                [TimeUnit.HOURS]: 60 * 60 * 1000,
                [TimeUnit.DAYS]: 24 * 60 * 60 * 1000,
            };

            delayMs = assignmentDelay * (unitMultiplier[assignmentDelayUnit] || 0);
        }
        const orderHash = createHash('sha1')
            .update([...data.orderIds].sort().join(','))
            .digest('hex');
        // 🔑 idempotency key (prevents duplicate enqueue per admin batch)
        const jobId = opts?.jobId ?? `auto-assignment:${data.adminId}:${orderHash}`;

        return this.autoAssignmentQueue.add(
            'auto-assignment',
            {
                adminId: data.adminId,
                orderIds: data.orderIds,
            },
            {
                jobId,
                delay: delayMs,
                ...opts,
            },
        );
    }
}

@Processor(QueueNames.AUTO_ASSIGNMENT, {
    concurrency: 5
})
export class AutoAssignmentWorkerService extends WorkerHost {
    private readonly logger = new Logger(AutoAssignmentWorkerService.name);

    constructor(
        private readonly orderAssignmentService: OrderAssignmentService,
    ) {
        super()
    }


    async process(job: Job<{ adminId: string; orderIds: string[] }>) {
        const { adminId, orderIds } = job.data;

        this.logger.debug(
            `Processing Assignment Job for Admin: ${adminId} | Orders: ${orderIds?.length}`,
        );

        try {
            await this.orderAssignmentService.processAutoAssignment(
                adminId,
                orderIds,
            );
        } catch (err) {
            this.logger.error(
                `Failed auto-assignment for admin ${adminId}`,
                err instanceof Error ? err.stack : err,
            );
            throw err; // triggers retry (BullMQ handles it)
        }
    }
}