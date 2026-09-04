import {
  DataSource,
  EntitySubscriberInterface,
  EventSubscriber,
  InsertEvent,
  RemoveEvent,
  TransactionCommitEvent,
  UpdateEvent,
} from "typeorm";
import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { OrderAssignmentEntity } from "entities/assignment.entity";
import { TagAutomationEvaluator } from "src/tags/tag-automation.evaluator";

@EventSubscriber()
@Injectable()
export class OrderAssignmentSubscriber
  implements EntitySubscriberInterface<OrderAssignmentEntity>
{
  constructor(
    private dataSource: DataSource,
    @Inject(forwardRef(() => TagAutomationEvaluator))
    private readonly tagAutomationEvaluator: TagAutomationEvaluator,
  ) {
    this.dataSource.subscribers.push(this);
  }

  listenTo() {
    return OrderAssignmentEntity;
  }

  async afterInsert(event: InsertEvent<OrderAssignmentEntity>) {
    await this.queueEvaluate(event);
  }

  async afterUpdate(event: UpdateEvent<OrderAssignmentEntity>) {
    await this.queueEvaluate(event);
  }

  async afterRemove(event: RemoveEvent<OrderAssignmentEntity>) {
    await this.queueEvaluate(event);
  }

  async afterTransactionCommit(event: TransactionCommitEvent) {
    const tasks = event.queryRunner.data.assignmentSubscriberTasks ?? [];
    if (!tasks.length) return;

    for (const task of tasks) {
      try {
        await task();
      } catch (error) {
        console.error(
          "[OrderAssignmentSubscriber] Post-commit tag evaluate failed:",
          error,
        );
      }
    }

    event.queryRunner.data.assignmentSubscriberTasks = [];
    event.queryRunner.data.assignmentEvaluateOrderIds = new Set();
  }

  private async queueEvaluate(event: {
    entity?: Partial<OrderAssignmentEntity> | null;
    databaseEntity?: Partial<OrderAssignmentEntity> | null;
    entityId?: any;
    manager: InsertEvent<OrderAssignmentEntity>["manager"];
    queryRunner: InsertEvent<OrderAssignmentEntity>["queryRunner"];
  }) {
    const orderId = await this.resolveOrderId(event);
    if (!orderId) return;

    const run = async () => {
      await this.tagAutomationEvaluator.evaluateOrder(orderId);
    };

    const queryRunner = event.queryRunner;
    if (!queryRunner) {
      await run();
      return;
    }

    if (!queryRunner.data.assignmentEvaluateOrderIds) {
      queryRunner.data.assignmentEvaluateOrderIds = new Set();
    }
    if (queryRunner.data.assignmentEvaluateOrderIds.has(orderId)) return;
    queryRunner.data.assignmentEvaluateOrderIds.add(orderId);

    if (!queryRunner.data.assignmentSubscriberTasks) {
      queryRunner.data.assignmentSubscriberTasks = [];
    }
    queryRunner.data.assignmentSubscriberTasks.push(run);
  }

  private async resolveOrderId(event: {
    entity?: Partial<OrderAssignmentEntity> | null;
    databaseEntity?: Partial<OrderAssignmentEntity> | null;
    entityId?: any;
    manager: InsertEvent<OrderAssignmentEntity>["manager"];
  }) {
    const orderId =
      event.entity?.orderId || event.databaseEntity?.orderId || null;
    if (orderId) return orderId;

    const id =
      event.entity?.id ||
      event.databaseEntity?.id ||
      (typeof event.entityId === "string" ? event.entityId : event.entityId?.id);
    if (!id) return null;

    const row = await event.manager.findOne(OrderAssignmentEntity, {
      where: { id },
      select: {
        id: true,
        orderId: true
      },
    });
    return row?.orderId || null;
  }
}
