import { Injectable, OnModuleInit } from "@nestjs/common";
import { Notification } from "entities/notifications.entity";

import {
    EntitySubscriberInterface,
    InsertEvent,
    DataSource,
} from "typeorm";

@Injectable()
export class NotificationSubscriber
    implements EntitySubscriberInterface<Notification>, OnModuleInit {
    constructor(
        private readonly dataSource: DataSource,
        // private readonly chatGateway: ChatGateway,
    ) { }

    // Tell TypeORM which entity we listen to
    listenTo(): Function {
        return Notification;
    }

    // This will be called by TypeORM when a Notification is inserted
    async afterInsert(event: InsertEvent<Notification>) {
        const notif = event.entity;
        if (!notif || !notif.userId) return;

        // try {
        //     this.chatGateway.emitNewNotification(notif.userId, notif);
        // } catch (err) {
        //     // log but don't crash DB operation
        //     console.error('NotificationSubscriber emit error', err);
        // }
    }

    // Register this instance with TypeORM's DataSource so it actually receives events
    onModuleInit() {
        // Avoid double-registering
        const alreadyRegistered = this.dataSource.subscribers.some(
            (s) => (s as any).constructor === this.constructor,
        );
        if (!alreadyRegistered) {
            this.dataSource.subscribers.push(this as any);
        }
    }
}
