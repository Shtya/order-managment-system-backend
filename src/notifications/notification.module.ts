import { forwardRef, Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "entities/user.entity";
import { NotificationController } from "./notification.controller";
import { NotificationService } from "./notification.service";
import { NotificationSubscriber } from "./NotificationSubscriber";
import { Notification } from "entities/notifications.entity";
import { OrderRetrySettingsEntity } from "entities/order.entity";
import { WebSocketModule } from "common/websocket.module";

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, User, OrderRetrySettingsEntity]),
    WebSocketModule,
  ],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationSubscriber],
  exports: [NotificationService],
})
export class NotificationModule {}
