import { forwardRef, Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "entities/user.entity";
import { NotificationController } from "./notification.controller";
import { NotificationService } from "./notification.service";
import { NotificationSubscriber } from "./NotificationSubscriber";
import { Notification } from "entities/notifications.entity";
import { ClientSettingsEntity } from "entities/clientSettings.entity";
import { WebSocketModule } from "common/websocket.module";
import { OrdersModule } from "src/orders/orders.module";

@Global()
@Module({
  imports: [
    forwardRef(() => OrdersModule),
    TypeOrmModule.forFeature([Notification, User, ClientSettingsEntity]),
    WebSocketModule,
  ],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationSubscriber],
  exports: [NotificationService],
})
export class NotificationModule {}
