import {
    EntitySubscriberInterface,
    EventSubscriber,
    UpdateEvent,
    DataSource,
    InsertEvent,
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
        console.log("After update called")
        const previousOrder = event.databaseEntity;
        const currentOrder = event.entity;

        if (!previousOrder || !currentOrder) {
            return;
        }

        const oldStatusId = previousOrder.statusId || previousOrder.status?.id;
        const newStatusId = currentOrder.statusId || currentOrder.status?.id;

        // إذا تغيرت القيمة فعلياً، أو إذا اعتبره TypeORM عموداً محدثاً
        const isStatusChanged = oldStatusId !== newStatusId

        if (isStatusChanged) {
            // event.entity contains the updated fields
            const fullOrder = await event.manager.findOne(OrderEntity, {
                where: { id: event.entity.id },
                relations: ['status', 'items', 'items.variant', "items.variant.product"],
            });

            if (!fullOrder) return;


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

            // try {

            //     const settings = await this.ordersService.getSettings({ adminId: fullOrder.adminId, manager: event.manager });
            //     const newStatus = await this.ordersService.findStatusById(newStatusId, fullOrder.adminId, event.manager);

            //     if (settings.stockDeductionStrategy === StockDeductionStrategy.ON_CONFIRMATION && newStatus.code === OrderStatus.CONFIRMED) {
            //         await this.ordersService.deductStockForOrder(event.manager, fullOrder);
            //     } else if (settings.stockDeductionStrategy === StockDeductionStrategy.ON_SHIPMENT && newStatus.code === OrderStatus.SHIPPED) {
            //         await this.ordersService.deductStockForOrder(event.manager, fullOrder);
            //     }
            // } catch (error) {
            //     console.error("Error in stock deduction logic:", error);
            // }

            try {
                if (fullOrder.externalId) {
                    await this.storesService.syncOrderStatus(fullOrder, newStatusId);
                }

            } catch (error) {
                console.error("Error in store synchronization:", error);
            }
        }
    }


    async afterInsert(event: InsertEvent<OrderEntity>) {
        const order = event.entity;

        if (!order) {
            return;
        }

        // Load full order with required relations
        const fullOrder = await event.manager.findOne(OrderEntity, {
            where: { id: order.id },
            relations: ['status', 'items', 'items.variant', "items.variant.product"],
        });

        if (!fullOrder) {
            return;
        }

        // 🚀 Dispatch automation trigger
        await this.triggerDispatcher.dispatch({
            type: TriggerType.ORDER_CREATED,

            entityType: TriggerEntityType.ORDER,

            entityId: fullOrder.id,

            adminId: fullOrder.adminId,

            payload: fullOrder,
        });

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