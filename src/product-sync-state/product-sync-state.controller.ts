import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ProductSyncStateService } from './product-sync-state.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { SubscriptionGuard } from 'common/subscription.guard';
import { RequireSubscription } from 'common/require-subscription.decorator';
import { Permissions } from 'common/permissions.decorator';
import { Response } from 'express';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('product-sync-state')
@RequireSubscription()
export class ProductSyncStateController {
  constructor(private readonly productSyncStateService: ProductSyncStateService) { }

  @Permissions("stores.read")
  @Get()
  async list(@Req() req: any, @Query() q: any) {
    return this.productSyncStateService.list(req.user, q);
  }

  @Permissions("stores.read")
  @Get("statistics")
  async getStatistics(@Req() req: any) {
    return this.productSyncStateService.getStatistics(req.user);
  }

  @Permissions("stores.read")
  @Get("export")
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.productSyncStateService.export(req.user, q);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=product_sync_state_${Date.now()}.xlsx`,
    );

    return res.send(buffer);
  }

  @Permissions("stores.read")
  @Get(":id")
  async getById(@Req() req: any, @Param("id") id: string) {
    return this.productSyncStateService.getById(req.user, id);
  }

  // ─── ERROR LOGS ──────────────────────────────────────────────────────────

  @Permissions("stores.read")
  @Get("logs/list")
  async listLogs(@Req() req: any, @Query() q: any) {
    return this.productSyncStateService.listLogs(req.user, q);
  }

  @Permissions("stores.read")
  @Get("logs/export")
  async exportLogs(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.productSyncStateService.exportLogs(req.user, q);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=product_sync_error_logs_${Date.now()}.xlsx`,
    );

    return res.send(buffer);
  }

  @Permissions("stores.read")
  @Get("logs/:id")
  async getLogById(@Req() req: any, @Param("id") id: string) {
    return this.productSyncStateService.getLogById(req.user, id);
  }
}
