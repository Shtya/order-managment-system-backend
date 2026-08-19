import {
  EntitySubscriberInterface,
  EventSubscriber,
  UpdateEvent,
  DataSource,
  InsertEvent,
  TransactionCommitEvent,
} from "typeorm";

import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { OrderEntity } from "entities/order.entity";
import { TriggerDispatcherService } from "src/automation/engine/triggerDispatcher.service";
import { TriggerEntityType, TriggerType } from "entities/automation.entity";

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
      relations: ["status", "items", "items.variant", "items.variant.product"],
    });

    if (!fullOrder) {
      // console.log("[OrderSubscriber] Failed to load full order after insert, skipping");
      return;
    }
    // console.log(`[OrderSubscriber] Loaded full order ${fullOrder.id}, queuing post-commit task`);

    const runAfterCommit = async () => {
      await this.triggerDispatcher.dispatch({
        type: TriggerType.ORDER_CREATED,
        entityType: TriggerEntityType.ORDER,
        entityId: fullOrder.id,
        adminId: fullOrder.adminId,
        payload: fullOrder,
      });
    };

    if (event.queryRunner) {
      // 🚀 USE A UNIQUE NAMESPACE HERE
      if (!event.queryRunner.data.orderSubscriberTasks) {
        event.queryRunner.data.orderSubscriberTasks = [];
      }
      event.queryRunner.data.orderSubscriberTasks.push(runAfterCommit);
    } else {
      await runAfterCommit();
    }
  }

  // TypeORM hook that automatically runs after a transaction successfully commits
  async afterTransactionCommit(event: TransactionCommitEvent) {
    const orderTasks = event.queryRunner.data.orderSubscriberTasks ?? [];
    const postCommitTasks = event.queryRunner.data.postCommitTasks ?? [];

    const allTasks = [...orderTasks, ...postCommitTasks];

    if (allTasks.length === 0) {
      return;
    }

    for (const task of allTasks) {
      try {
        await task();
      } catch (error) {
        console.error("[OrderSubscriber] Post-commit task failed:", error);
      }
    }

    // Clear the queues
    event.queryRunner.data.orderSubscriberTasks = [];
    event.queryRunner.data.postCommitTasks = [];
  }
}
