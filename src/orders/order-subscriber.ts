import {
    EntitySubscriberInterface,
    EventSubscriber,
    UpdateEvent,
    DataSource,
} from 'typeorm';

import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { OrderEntity } from 'entities/order.entity';
import { EasyOrderService } from 'src/stores/storesIntegrations/EasyOrderService';
import { StoresService } from 'src/stores/stores.service';

@EventSubscriber()
@Injectable()
export class OrderSubscriber implements EntitySubscriberInterface<OrderEntity> {
    constructor(
        private dataSource: DataSource,
        @Inject(forwardRef(() => StoresService))
        private readonly storesService: StoresService,
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
        const isStatusChanged = event.updatedColumns.some(
            (column) => column.propertyName === 'status'
        );

        if (isStatusChanged && event.entity) {
            // event.entity contains the updated fields
            const fullOrder = await event.manager.findOne(OrderEntity, {
                where: { id: event.entity.id }
            });

            if (fullOrder && fullOrder.externalId) {
                await this.storesService.syncOrderStatus(fullOrder);
            }
        }
    }
}