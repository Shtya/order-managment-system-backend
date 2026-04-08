import {
    EntitySubscriberInterface,
    EventSubscriber,
    UpdateEvent,
    DataSource,
} from 'typeorm';
import { Injectable } from '@nestjs/common';
import { PurchaseInvoiceEntity } from 'entities/purchase.entity';

@EventSubscriber()
@Injectable()
export class PurchaseSubscriber implements EntitySubscriberInterface<PurchaseInvoiceEntity> {
    constructor(
        private dataSource: DataSource,
    ) {
        this.dataSource.subscribers.push(this);
    }

    listenTo() {
        return PurchaseInvoiceEntity;
    }

    async beforeUpdate(event: UpdateEvent<PurchaseInvoiceEntity>) {
        const isStatusChanged = event.updatedColumns.some(
            (column) => column.propertyName === 'status'
        );

        if (isStatusChanged && event.entity) {
            event.entity.statusUpdateDate = new Date();
        }
    }
}
