import { Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { Permissions } from 'common/permissions.decorator';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';



@Controller('notifications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class NotificationController {
    constructor(private readonly svc: NotificationService) { }

    @Get()
    @Permissions("notifications.read")
    async getMyNotifications(@Req() req: any, @Query() q: any) {
        return this.svc.list(req.user, q);
    }

    @Patch(':id/read')
    @Permissions("notifications.read")
    async markAsRead(@Req() req: any, @Param('id') id: number) {
        return this.svc.markAsRead(Number(req.user?.id), id);
    }

    @Post('read-all')
    @Permissions("notifications.read")
    async markAllRead(@Req() req: any) {
        return this.svc.markAllAsRead(Number(req.user?.id));
    }
}