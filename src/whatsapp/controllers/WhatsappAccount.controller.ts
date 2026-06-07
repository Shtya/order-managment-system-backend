import { Controller, Get, Patch, Param, Query, Req, Res, UseGuards, Delete } from '@nestjs/common';
import { Response } from 'express';
import { WhatsappAccountService } from '../services/WhatsappAccount.service';
import { Permissions } from 'common/permissions.decorator';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { SubscriptionGuard } from 'common/subscription.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('whatsapp-accounts')
export class WhatsappAccountController {
  constructor(private readonly svc: WhatsappAccountService) { }

  @Permissions("whatsapp.read")
  @Get('stats')
  async getStats(@Req() req: any) {
    return await this.svc.getStats(req.user);
  }

  // 1. Get all accounts with pagination & filters
  @Permissions("whatsapp.read")
  @Get()
  async getAll(@Req() req: any, @Query() q: any) {
    return await this.svc.list(req.user, q);
  }

  // 2. Export to Excel
  @Permissions("whatsapp.read")
  @Get("export")
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.svc.exportAccounts(req.user, q);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=whatsapp_export_${Date.now()}.xlsx`,
    );

    return res.send(buffer);
  }

  // 3. Get single account
  @Permissions("whatsapp.read")
  @Get(":id")
  async getOne(@Req() req: any, @Param("id") id: string) {
    return await this.svc.findOne(req.user, id);
  }

  // 4. Toggle Active Status
  @Permissions("whatsapp.update_account")
  @Patch(":id/toggle-active")
  async toggleActive(@Req() req: any, @Param("id") id: string) {
    return await this.svc.toggleActive(req.user, id);
  }

  @Permissions("whatsapp.delete_account")
  @Delete(":id")
  async delete(@Req() req: any, @Param("id") id: string) {
    return await this.svc.delete(req.user, id);
  }
}