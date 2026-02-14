import {
    EntitySubscriberInterface,
    EventSubscriber,
    InsertEvent,
    DataSource,
} from 'typeorm';
import { StoreEntity } from 'entities/stores.entity';
import { Injectable } from '@nestjs/common';
import { EasyOrderService } from './storesIntegrations/EasyOrderService';

@EventSubscriber()
@Injectable()
export class StoreSubscriber implements EntitySubscriberInterface<StoreEntity> {
    constructor(
        private dataSource: DataSource,
        private readonly easyOrderService: EasyOrderService,
    ) {
        this.dataSource.subscribers.push(this);
    }

    listenTo() {
        return StoreEntity;
    }

    async afterInsert(event: InsertEvent<StoreEntity>) {
        const store = event.entity;

        this.easyOrderService.syncFullStore(store);
    }
}