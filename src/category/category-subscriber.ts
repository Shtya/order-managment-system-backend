import {
    EntitySubscriberInterface,
    EventSubscriber,
    InsertEvent,
    UpdateEvent,
    RemoveEvent,
    DataSource,
} from 'typeorm';
import { CategoryEntity } from 'entities/categories.entity';
import { Injectable, Logger } from '@nestjs/common';
import { StoresService } from 'src/stores/stores.service';

@EventSubscriber()
@Injectable() // Ensure it's injectable
export class CategorySubscriber implements EntitySubscriberInterface<CategoryEntity> {

    constructor(
        private dataSource: DataSource, // Inject the DataSource
        private readonly storesService: StoresService,
    ) {
        // THIS IS THE MISSING PIECE:
        // This manually registers this instance into the TypeORM lifecycle
        this.dataSource.subscribers.push(this);
    }

    listenTo() {
        return CategoryEntity;
    }

    /**
     * Called AFTER a category is inserted into the database.
     */
    async afterInsert(event: InsertEvent<CategoryEntity>) {
        await this.storesService.syncCategoryToAllStores(event.entity);
    }

    /**
     * Called AFTER an update is saved to the database.
     */
    async afterUpdate(event: UpdateEvent<CategoryEntity>) {
        await this.storesService.syncCategoryToAllStores(event.entity as CategoryEntity, event.databaseEntity?.slug);
    }
}