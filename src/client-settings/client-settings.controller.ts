import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ClientSettingsService } from './client-settings.service';
import { SubscriptionGuard } from 'common/subscription.guard';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { Permissions } from 'common/permissions.decorator';
import { UpsertClientSettingsDto } from 'dto/client-settings.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('client-settings')
export class ClientSettingsController {
  constructor(private readonly clientSettingsService: ClientSettingsService) {
  }


  @Get("")
  @Permissions("orders.readSettings")
  getRetry(@Req() req: any) {
    return this.clientSettingsService.getSettings(req.user);
  }

  @Post("")
  @Permissions("orders.updateSettings")
  upsertRetry(@Req() req: any, @Body() dto: UpsertClientSettingsDto) {
    return this.clientSettingsService.upsertSettings(req.user, dto);
  }
}
