import {
    EntitySubscriberInterface,
    EventSubscriber,
    UpdateEvent,
    InsertEvent, // 🚀 Import InsertEvent
    DataSource,
    TransactionCommitEvent,
    EntityManager,
    QueryRunner,
} from 'typeorm';
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';

import { OrderEntity } from 'entities/order.entity';
import { TriggerDispatcherService } from 'src/automation/engine/triggerDispatcher.service';
import { TriggerEntityType, TriggerType } from 'entities/automation.entity';
import { ShipmentEntity } from 'entities/shipping.entity';

@EventSubscriber()
@Injectable()
export class ShipmentSubscriber implements EntitySubscriberInterface<ShipmentEntity> {
    private readonly logger = new Logger(ShipmentSubscriber.name);
    
    constructor(
        private dataSource: DataSource,
        @Inject(forwardRef(() => TriggerDispatcherService))
        private readonly triggerDispatcher: TriggerDispatcherService,
    ) {
        this.dataSource.subscribers.push(this);
    }

    listenTo() {
        return ShipmentEntity;
    }

    // 🚀 NEW: Handle newly created shipments
    async afterInsert(event: InsertEvent<ShipmentEntity>) {
        const shipment = event.entity;
        this.logger.log('afterInsert', JSON.stringify(shipment));

        if (!shipment || !shipment.orderId || !shipment.status) return;

        // Queue the task for the newly inserted shipment
        this.queueShipmentTrigger(event.queryRunner, event.manager, shipment.orderId);
    }

    // EXISTING: Handle updated shipments
    async afterUpdate(event: UpdateEvent<ShipmentEntity>) {
        const updatedShipment = event.entity as Partial<ShipmentEntity>;
        const previousShipment = event.databaseEntity;
        
        this.logger.log('afterUpdate', JSON.stringify(updatedShipment), JSON.stringify(previousShipment));
        
        if (!updatedShipment) return;

        // Check if shipment status actually changed (handles bulk update missing previousShipment edge case)
        const newStatus = updatedShipment.status;
        const oldStatus = previousShipment?.status;
        const hasStatusChanged = !previousShipment || (newStatus && oldStatus !== newStatus);

        if (hasStatusChanged) {
            const orderId = updatedShipment.orderId || previousShipment?.orderId;
            if (!orderId) return;

            // Queue the task for the updated shipment
            this.queueShipmentTrigger(event.queryRunner, event.manager, orderId);
        }
    }

    // 🚀 NEW: Reusable helper method to queue the dispatch task
    private queueShipmentTrigger(queryRunner: QueryRunner, manager: EntityManager, orderId: string) {
        const runAfterCommit = async () => {
            try {
                const fullOrder = await manager
                    .getRepository(OrderEntity)
                    .createQueryBuilder('order')
                    .leftJoinAndSelect('order.status', 'status')
                    .leftJoinAndSelect('order.items', 'items')
                    .leftJoinAndSelect('items.variant', 'variant')
                    .leftJoinAndSelect('variant.product', 'product')
                    .leftJoinAndSelect(
                        "order.shipments", 
                        "shipment",
                        `shipment.id = (SELECT s.id FROM shipments s WHERE s."trackingNumber" = "order"."trackingNumber" ORDER BY s."created_at" DESC LIMIT 1)`
                    )
                    .where('order.id = :orderId', { orderId })
                    .getOne();

                if (fullOrder) {
                    await this.triggerDispatcher.dispatch({
                        type: TriggerType.SHIPMENT_UPDATED, 
                        entityType: TriggerEntityType.ORDER,
                        entityId: fullOrder.id,
                        adminId: fullOrder.adminId,
                        payload: fullOrder,
                    });
                }
            } catch (error) {
                this.logger.error('[ShipmentSubscriber] Error dispatching SHIPMENT_UPDATED trigger:', error);
            }
        };

        if (queryRunner) {
            if (!queryRunner.data.shipmentSubscriberTasks) {
                queryRunner.data.shipmentSubscriberTasks = [];
            }
            queryRunner.data.shipmentSubscriberTasks.push(runAfterCommit);
        } else {
            // No active transaction, run immediately
            runAfterCommit().catch(err => this.logger.error(err));
        }
    }

    // Runs after transaction commits
    async afterTransactionCommit(event: TransactionCommitEvent) {
        const tasks = event.queryRunner.data.shipmentSubscriberTasks;

        if (tasks && tasks.length > 0) {
            for (const task of tasks) {
                try {
                    await task();
                } catch (error) {
                    this.logger.error('[ShipmentSubscriber] Post-commit task failed:', error);
                }
            }
            // Clear queue to prevent duplicate runs
            event.queryRunner.data.shipmentSubscriberTasks = [];
        }
    }
}