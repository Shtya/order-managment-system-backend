import {
    EntitySubscriberInterface,
    EventSubscriber,
    UpdateEvent,
    DataSource,
    InsertEvent,
    TransactionCommitEvent,
} from 'typeorm';

import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { OrderEntity, OrderFlowPath, OrderRetrySettingsEntity, OrderStatus, PaymentStatus, StockDeductionStrategy } from 'entities/order.entity';
import { Repository } from 'typeorm';
import { StoresService } from 'src/stores/stores.service';
import { ShippingService } from 'src/shipping/shipping.service';
import { OrdersService } from 'src/orders/services/orders.service';
import { NotificationService } from 'src/notifications/notification.service';
import { NotificationType } from 'entities/notifications.entity';
import { TriggerDispatcherService } from 'src/automation/engine/triggerDispatcher.service';
import { TriggerEntityType, TriggerType } from 'entities/automation.entity';
import { RedisService } from 'common/redis/RedisService';

@EventSubscriber()
@Injectable()
export class OrderSubscriber implements EntitySubscriberInterface<OrderEntity> {
    constructor(
        private dataSource: DataSource,
        @Inject(forwardRef(() => StoresService))
        private readonly storesService: StoresService,
        @Inject(forwardRef(() => TriggerDispatcherService))
        private readonly triggerDispatcher: TriggerDispatcherService,
        @Inject(forwardRef(() => ShippingService))
        private readonly shippingService: ShippingService,
        @Inject(forwardRef(() => OrdersService))
        private readonly ordersService: OrdersService,
        private readonly notificationService: NotificationService,
    ) {
        // Register this subscriber in the TypeORM lifecycle
        this.dataSource.subscribers.push(this);
    }

    listenTo() {
        return OrderEntity;
    }

    /**
     * Called AFTER an order is updated.
     * We track the change of 'status' specifically.
     */
    async afterUpdate(event: UpdateEvent<OrderEntity>) {
        // Check if the status column was actually updated
        // console.log("[OrderSubscriber] After update called for order id:", event.entity?.id);
        const previousOrder = event.databaseEntity;
        const currentOrder = event.entity;

        if (!previousOrder || !currentOrder) {
            // console.log("[OrderSubscriber] Missing previous or current order, skipping");
            return;
        }

        const oldStatusId = previousOrder.statusId || previousOrder.status?.id;
        const newStatusId = currentOrder.statusId || currentOrder.status?.id;

        // إذا تغيرت القيمة فعلياً، أو إذا اعتبره TypeORM عموداً محدثاً
        const isStatusChanged = oldStatusId !== newStatusId
        // console.log(`[OrderSubscriber] Status changed: ${isStatusChanged} (old: ${oldStatusId}, new: ${newStatusId}) for order ${currentOrder.id}`);

        if (isStatusChanged) {
            // event.entity contains the updated fields
            const fullOrder = await event.manager.findOne(OrderEntity, {
                where: { id: event.entity.id },
                relations: ['store','status', 'items', 'items.variant', "items.variant.product"],
            });

            if (!fullOrder) {
                // console.log("[OrderSubscriber] Failed to load full order, skipping");
                return;
            }
            // console.log(`[OrderSubscriber] Loaded full order ${fullOrder.id}, queuing post-commit task`);

            const runAfterCommit = async () => {
                // console.log(`[OrderSubscriber] Post-commit task running for ORDER_UPDATED on order ${fullOrder.id}`);
                await this.triggerDispatcher.dispatch({
                    type: TriggerType.ORDER_UPDATED,

                    entityType: TriggerEntityType.ORDER,

                    entityId: fullOrder.id,

                    adminId: fullOrder.adminId,

                    payload: {
                        ...fullOrder,

                        previousStatusId: oldStatusId,
                        currentStatusId: newStatusId,
                    },
                });
                // console.log(`[OrderSubscriber] ORDER_UPDATED trigger dispatched for order ${fullOrder.id}`);

                try {
                    if (fullOrder.externalId) {
                        await this.storesService.syncOrderStatus(fullOrder, newStatusId);
                    }

                } catch (error) {
                    console.error("Error in store synchronization:", error);
                }
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

@EventSubscriber()
@Injectable()
export class OrderSettingsSubscriber implements EntitySubscriberInterface<OrderRetrySettingsEntity> {
    constructor(
        private dataSource: DataSource,
        private readonly redisService: RedisService,
    ) {
        this.dataSource.subscribers.push(this);
    }

    listenTo() {
        return OrderRetrySettingsEntity;
    }

    async afterInsert(event: InsertEvent<OrderRetrySettingsEntity>) {
        await this.syncToRedis(event.entity);
    }

    async afterUpdate(event: UpdateEvent<OrderRetrySettingsEntity>) {
        // combine updated entity with original database entity to get full picture if needed
        const fullSettings = { ...event.databaseEntity, ...event.entity };
        await this.syncToRedis(fullSettings as OrderRetrySettingsEntity);
    }

    private async syncToRedis(settings: OrderRetrySettingsEntity) {
        if (settings && settings.adminId) {
            const cacheKey = `admin_settings:${settings.adminId}`;
            await this.redisService.set(cacheKey, settings, 3600 * 24); // Cache for 24 hours
            // Also update local memory cache in OrdersService
            OrdersService.updateLocalCache(settings.adminId, settings);
        }
    }
}