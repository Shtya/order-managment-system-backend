import { Injectable } from "@nestjs/common";
import { RedisService } from "common/redis/RedisService";
import { ClientSettingsEntity } from "entities/clientSettings.entity";
import { DataSource, EntitySubscriberInterface, EventSubscriber, InsertEvent, UpdateEvent } from "typeorm";
import { ClientSettingsService } from "./client-settings.service";

@EventSubscriber()
@Injectable()
export class ClientSettingsSubscriber implements EntitySubscriberInterface<ClientSettingsEntity> {
    constructor(
        private dataSource: DataSource,
        private readonly redisService: RedisService,
    ) {
        this.dataSource.subscribers.push(this);
    }

    listenTo() {
        return ClientSettingsEntity;
    }

    async afterInsert(event: InsertEvent<ClientSettingsEntity>) {
        await this.syncToRedis(event.entity);
    }

    async afterUpdate(event: UpdateEvent<ClientSettingsEntity>) {
        // combine updated entity with original database entity to get full picture if needed
        const fullSettings = { ...event.databaseEntity, ...event.entity };
        await this.syncToRedis(fullSettings as ClientSettingsEntity);
    }

    private async syncToRedis(settings: ClientSettingsEntity) {
        if (settings && settings.adminId) {
            const cacheKey = `admin_settings:${settings.adminId}`;
            await this.redisService.set(cacheKey, settings, 3600 * 24); // Cache for 24 hours
            // Also update local memory cache in OrdersService
            ClientSettingsService.updateLocalCache(settings.adminId, settings);
        }
    }
}