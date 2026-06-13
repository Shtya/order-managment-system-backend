import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, JobsOptions } from 'bullmq';
import { QueueNames } from './common/queue.constants';
import { AssignmentMode, TimeUnit } from 'entities/order.entity';
import { v4 as uuidv4 } from 'uuid';
@Injectable()
export class QueueService {
    constructor(
        @InjectQueue(QueueNames.AUTO_ASSIGNMENT) private readonly autoAssignmentQueue: Queue,
    ) { }

  
}