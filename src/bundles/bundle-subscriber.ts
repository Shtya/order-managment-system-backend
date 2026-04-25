import { Injectable, Logger } from "@nestjs/common";
import { DataSource, EntitySubscriberInterface, EventSubscriber, InsertEvent, UpdateEvent } from "typeorm";
import { BundleEntity } from "entities/bundle.entity";
import { StoresService } from "src/stores/stores.service";

@EventSubscriber()
@Injectable()
export class BundleSubscriber implements EntitySubscriberInterface<BundleEntity> {
    private readonly logger = new Logger(BundleSubscriber.name);

    constructor(
        private dataSource: DataSource,
        private readonly storesService: StoresService,
    ) {
        this.dataSource.subscribers.push(this);
    }

    listenTo() {
        return BundleEntity;
    }

    async afterInsert(event: InsertEvent<BundleEntity>) {
        const entity = event.entity as BundleEntity;
        if (!entity.isActive) return;

        // Only sync if assigned to a specific store
        if (entity.storeId) {
            await this.storesService.syncBundleToStore(event.entity, null);
        }
    }

    async afterUpdate(event: UpdateEvent<BundleEntity>) {
        const entity = event.entity as BundleEntity;

        if (!entity.storeId) return;

        const oldEntity = event.databaseEntity;
        const { adminId, variantId, storeId } = oldEntity;
        const store = await this.storesService.getStoreById({ adminId }, storeId);
        await this.storesService.syncBundleToStore(
            entity,
            { adminId, oldMainVaraintId: variantId, oldStoreId: storeId, oldStoreType: store?.provider });
    }


}
