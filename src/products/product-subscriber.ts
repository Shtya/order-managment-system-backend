// subscribers/product.subscriber.ts
import {
    EntitySubscriberInterface,
    EventSubscriber,
    InsertEvent,
    UpdateEvent,
    RemoveEvent,
    DataSource,
} from 'typeorm';
import { Injectable, Logger } from '@nestjs/common';
import { ProductEntity, ProductVariantEntity } from 'entities/sku.entity';
import { StoresService } from 'src/stores/stores.service';

@EventSubscriber()
@Injectable()
export class ProductSubscriber implements EntitySubscriberInterface<ProductEntity> {
    private readonly logger = new Logger(ProductSubscriber.name);

    constructor(
        private dataSource: DataSource,
        private readonly storesService: StoresService,
    ) {
        this.dataSource.subscribers.push(this);
    }

    listenTo() {
        return ProductEntity;
    }

    async afterInsert(event: InsertEvent<ProductEntity>) {
        // Only sync if assigned to a specific store
        if (event.entity.storeId) {
            await this.storesService.syncProductToStore(event.entity);
        }
    }

    async afterUpdate(event: UpdateEvent<ProductEntity>) {
        const entity = event.entity as ProductEntity;
        if (entity.storeId) {
            await this.storesService.syncProductToStore(entity, event.databaseEntity?.slug);
        }
    }

}

// subscribers/variant.subscriber.ts
@EventSubscriber()
@Injectable()
export class VariantSubscriber implements EntitySubscriberInterface<ProductVariantEntity> {
    constructor(
        private dataSource: DataSource,
        private readonly storesService: StoresService,
    ) {
        this.dataSource.subscribers.push(this);
    }

    listenTo() { return ProductVariantEntity; }

    async afterInsert(event: InsertEvent<ProductVariantEntity>) {
        const variant = event.entity as ProductVariantEntity;

        // We need the parent product to know which store to sync to
        const product = await event.manager.findOne(ProductEntity, {
            where: { id: variant.productId }
        });

        if (product?.storeId) {
            await this.storesService.syncProductToStore(product);
        }
    }

    async afterUpdate(event: UpdateEvent<ProductVariantEntity>) {
        const variant = event.entity as ProductVariantEntity;

        // We need the parent product to know which store to sync to
        const product = await event.manager.findOne(ProductEntity, {
            where: { id: variant.productId }
        });

        if (product?.storeId) {
            await this.storesService.syncProductToStore(product);
        }
    }


}