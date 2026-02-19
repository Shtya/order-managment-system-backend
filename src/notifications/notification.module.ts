import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "entities/user.entity";
import { NotificationController } from "./notification.controller";
import { NotificationService } from "./notification.service";
import { NotificationSubscriber } from "./NotificationSubscriber";
import { Notification } from "entities/notifications.entity";

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, User]),
  ],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationSubscriber],
})
export class NotificationModule { }
