import { forwardRef, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueNames } from './common/queue.constants';
import { AutoAssignmentQueueService, AutoAssignmentWorkerService } from './queues/auto-assignment.queue';
import { OrdersModule } from 'src/orders/orders.module';
import { OrderAssignmentModule } from 'src/order-assignment/order-assignment.module';


@Module({
  imports: [
    forwardRef(() => OrdersModule),
    forwardRef(() => OrderAssignmentModule),
    BullModule.registerQueue({
     name: QueueNames.AUTO_ASSIGNMENT,
    }),
  ],
  providers: [AutoAssignmentQueueService, AutoAssignmentWorkerService],
  exports: [AutoAssignmentQueueService, AutoAssignmentWorkerService],
})
export class QueueModule {}