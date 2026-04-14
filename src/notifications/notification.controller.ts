import {
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { NotificationService } from "./notification.service";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";

@Controller("notifications")
@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@RequireSubscription()
export class NotificationController {
  constructor(private readonly svc: NotificationService) { }

  @Get()
  async getMyNotifications(@Req() req: any, @Query() q: any) {
    return this.svc.list(req.user, q);
  }

  @Patch(":id/read")
  async markAsRead(@Req() req: any, @Param("id") id: string) {
    return this.svc.markAsRead(req.user?.id, id);
  }

  @Post("read-all")
  async markAllRead(@Req() req: any) {
    return this.svc.markAllAsRead(req.user?.id);
  }

  @Get("unread-count")
  async getUnreadCount(@Req() req: any) {
    return this.svc.getUnreadCount(req.user?.id);
  }
}
