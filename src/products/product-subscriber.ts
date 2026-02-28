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
    private readonly logger = new Logger('VariantSubscriber');
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

        // 1. Identify what columns changed in this update
        const updatedColumns = event.updatedColumns.map(col => col.propertyName);

        // 2. [2025-12-24] Check if the update was ONLY the externalId.
        // If so, stop here to prevent a sync loop.
        const isOnlyExternalIdUpdate =
            updatedColumns.length === 1 &&
            updatedColumns.includes('externalId');

        if (isOnlyExternalIdUpdate) {
            return; // Do nothing, this was likely a sync-back from the provider
        }

        // 4. Proceed with sync
        const product = await event.manager.findOne(ProductEntity, {
            where: { id: variant.productId },
            relations: ['store'] // Ensure store relation is available
        });

        if (product?.storeId) {
            // [2025-12-24] Trim slug before passing to service
            const cleanSlug = product.slug?.trim();
            this.logger.log(`[Subscriber] Triggering sync for variant update: ${variant.sku?.trim()}`);

            await this.storesService.syncProductToStore({
                ...product,
                slug: cleanSlug
            });
        }
    }

}