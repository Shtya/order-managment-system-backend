import {
    EntitySubscriberInterface,
    EventSubscriber,
    UpdateEvent,
    DataSource,
} from 'typeorm';
import { Injectable } from '@nestjs/common';
import { PurchaseReturnInvoiceEntity } from 'entities/purchase_return.entity';

@EventSubscriber()
@Injectable()
export class PurchaseReturnSubscriber implements EntitySubscriberInterface<PurchaseReturnInvoiceEntity> {
    constructor(
        private dataSource: DataSource,
    ) {
        this.dataSource.subscribers.push(this);
    }

    listenTo() {
        return PurchaseReturnInvoiceEntity;
    }

    async beforeUpdate(event: UpdateEvent<PurchaseReturnInvoiceEntity>) {
        const isStatusChanged = event.updatedColumns.some(
            (column) => column.propertyName === 'status'
        );

        if (isStatusChanged && event.entity) {
            event.entity.statusUpdateDate = new Date();
        }
    }
}
