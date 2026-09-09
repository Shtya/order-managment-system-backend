import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { Job, Queue } from "bullmq";
import { ClientImportJobs, QueueNames } from "../common/queue.constants";
import { ClientService } from "src/clients/clients.service";

export type ClientImportJobData = {
  adminId: string;
  userId?: string;
  filePath: string;
};

@Injectable()
export class ClientImportQueueService {
  private readonly logger = new Logger(ClientImportQueueService.name);

  constructor(
    @InjectQueue(QueueNames.CLIENT_IMPORT)
    private readonly clientImportQueue: Queue,
  ) {}

  async enqueueImport(adminId: string, userId: string | undefined, filePath: string) {
    if (!adminId || !filePath) return;

    await this.clientImportQueue.add(
      ClientImportJobs.IMPORT,
      { adminId, userId, filePath } satisfies ClientImportJobData,
      {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }
}

@Processor(QueueNames.CLIENT_IMPORT, {
  concurrency: 1,
})
export class ClientImportWorkerService extends WorkerHost {
  private readonly logger = new Logger(ClientImportWorkerService.name);

  constructor(
    @Inject(forwardRef(() => ClientService))
    private readonly clientService: ClientService,
  ) {
    super();
  }

  async process(job: Job<ClientImportJobData>) {
    const { adminId, userId, filePath } = job.data;
    this.logger.log(
      `Importing clients for admin ${adminId} | Job: ${job.id}`,
    );
    await this.clientService.processBulkImport(adminId, userId, filePath);
  }
}
