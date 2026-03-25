import { Body, Controller, Get, Patch, Req, UseGuards } from "@nestjs/common";
import { AdminSettingsService } from "./admin-settings.service";
import { UpdateAdminSettingsDto } from "dto/adminSettings.dto";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";

@Controller("admin-settings")
export class AdminSettingsController {
  constructor(private readonly settingsService: AdminSettingsService) {}
  
  @Get()
  async getSettings() {
    return await this.settingsService.getSettings();
  }
  
  @Patch()
  @UseGuards(JwtAuthGuard)
  async updateSettings(@Body() dto: UpdateAdminSettingsDto, @Req() req: any) {
    return await this.settingsService.updateSettings(dto, req.user);
  }
}
