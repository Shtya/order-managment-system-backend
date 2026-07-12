import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, JobsOptions } from 'bullmq';
import { QueueNames } from './common/queue.constants';
@Injectable()
export class QueueService {
    constructor(
        @InjectQueue(QueueNames.AUTO_ASSIGNMENT) private readonly autoAssignmentQueue: Queue,
    ) { }

  
}