import {
    EntitySubscriberInterface,
    EventSubscriber,
    UpdateEvent,
    DataSource,
    InsertEvent,
    TransactionCommitEvent,
} from 'typeorm';

import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { OrderEntity } from 'entities/order.entity';
import { TriggerDispatcherService } from 'src/automation/engine/triggerDispatcher.service';
import { TriggerEntityType, TriggerType } from 'entities/automation.entity';

@EventSubscriber()
@Injectable()
export class OrderSubscriber implements EntitySubscriberInterface<OrderEntity> {
    constructor(
        private dataSource: DataSource,
        @Inject(forwardRef(() => TriggerDispatcherService))
        private readonly triggerDispatcher: TriggerDispatcherService,
    ) {
        // Register this subscriber in the TypeORM lifecycle
        this.dataSource.subscribers.push(this);
    }

    listenTo() {
        return OrderEntity;
    }

    async afterInsert(event: InsertEvent<OrderEntity>) {
        const order = event.entity;
        // console.log("[OrderSubscriber] After insert called for order id:", order?.id);

        if (!order) {
            // console.log("[OrderSubscriber] No order entity, skipping");
            return;
        }

        // Load full order with required relations INSIDE the current transaction
        const fullOrder = await event.manager.findOne(OrderEntity, {
            where: { id: order.id },
            relations: ['status', 'items', 'items.variant', "items.variant.product"],
        });

        if (!fullOrder) {
            // console.log("[OrderSubscriber] Failed to load full order after insert, skipping");
            return;
        }
        // console.log(`[OrderSubscriber] Loaded full order ${fullOrder.id}, queuing post-commit task`);

        const runAfterCommit = async () => {
            // console.log(`[OrderSubscriber] Post-commit task running for ORDER_CREATED on order ${fullOrder.id}`);
            // 🚀 Dispatch automation trigger
            await this.triggerDispatcher.dispatch({
                type: TriggerType.ORDER_CREATED,
                entityType: TriggerEntityType.ORDER,
                entityId: fullOrder.id,
                adminId: fullOrder.adminId,
                payload: fullOrder,
            });
            // console.log(`[OrderSubscriber] ORDER_CREATED trigger dispatched for order ${fullOrder.id}`);
        };

        if (event.queryRunner) {
            if (!event.queryRunner.data.postCommitTasks) {
                event.queryRunner.data.postCommitTasks = [];
            }
            // console.log(`[OrderSubscriber] Adding post-commit task for order ${fullOrder.id}`);
            event.queryRunner.data.postCommitTasks.push(runAfterCommit);
        } else {
            // console.log(`[OrderSubscriber] No active transaction, running immediately for order ${fullOrder.id}`);
            // No active transaction, run immediately
            await runAfterCommit();
        }
    }

    // TypeORM hook that automatically runs after a transaction successfully commits
    async afterTransactionCommit(event: TransactionCommitEvent) {
        const tasks = event.queryRunner.data?.postCommitTasks;

        if (tasks && tasks.length > 0) {
            for (let i = 0; i < tasks.length; i++) {
                const task = tasks[i];
                try {
                    // console.log(`[OrderSubscriber] Executing post-commit task ${i + 1} of ${tasks.length}`);
                    await task();
                } catch (error) {
                    // Catch errors here so one failing background dispatch 
                    // doesn't crash the loop or throw unhandled exceptions
                    console.error(`[OrderSubscriber] Error executing post-commit task ${i + 1}:`, error);
                }
            }
            // Clear the tasks to prevent memory leaks or duplicate executions
            event.queryRunner.data.postCommitTasks = [];
            // console.log(`[OrderSubscriber] All post-commit tasks executed and cleared`);
        }
    }
}
