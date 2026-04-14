import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";
import { StoresService } from "./stores.service";
import { CreateStoreDto, UpdateStoreDto } from "dto/stores.dto";
import { Response } from "express";


@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller("stores")
@RequireSubscription()
export class StoresController {
  constructor(private storesService: StoresService) { }

  @Permissions("stores.update") // Requires update permissions
  @Post(":id/sync")
  async syncStore(@Req() req: any, @Param("id") id: string) {
    return this.storesService.manualSync(req.user, id);
  }

  @Permissions("stores.read")
  @Get('providers')
  providers() {
    return this.storesService.listProviders();
  }


  // List failed orders
  @Permissions("stores.read")
  @Get("failed-orders")
  async listFailedOrders(@Req() req: any, @Query() q: any) {
    return this.storesService.listFailedOrders(req.user, q);
  }

  // Retry failed order
  @Permissions("stores.update")
  @Post("failed-orders/:id/retry")
  async retryFailedOrder(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    return this.storesService.queueRetryFailedOrder(req.user, id);
  }

  // Failed orders statistics
  @Permissions("stores.read")
  @Get("failed-orders/statistics")
  async failedOrdersStatistics(@Req() req: any) {
    return this.storesService.getFailedOrdersStatistics(req.user);
  }

  @Permissions("stores.read")
  @Get("failed-orders/export")
  async exportFailedOrders(
    @Req() req: any,
    @Query() q: any,
    @Res() res: Response,
  ) {
    const buffer = await this.storesService.exportFailedOrders(
      req.user,
      q,
    );

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=failed_orders_${Date.now()}.xlsx`,
    );

    return res.send(buffer);
  }

  @Permissions("stores.read")
  @Get()
  async list(@Req() req: any, @Query() q: any) {
    return this.storesService.list(req.user, q);
  }

  @Permissions("stores.read")
  @Get("integrations")
  async integrations(@Req() req: any) {
    return this.storesService.listWithCredentials(req.user);
  }

  @Permissions("stores.read")
  @Get(":id")
  async get(@Req() req: any, @Param("id") id: string) {
    return this.storesService.get(req.user, id);
  }


  @Permissions("stores.create")
  @Post()
  async create(@Req() req: any, @Body() dto: CreateStoreDto) {
    return this.storesService.create(req.user, dto);
  }

  @Permissions("stores.update")
  @Patch(":id")
  async update(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateStoreDto) {
    return this.storesService.update(req.user, id, dto);
  }

  @Permissions("stores.update")
  @Post(":id/regenerate-secrets")
  async regenerateSecrets(@Req() req: any, @Param("id") id: string) {
    return this.storesService.regenerateWebhookSecrets(req.user, id);
  }
  // @Permissions("stores.read")
  // @Get("check-code/:code")
  // async checkCode(@Req() req: any, @Param("code") code: string) {
  //   const exists = await this.storesService.checkCodeExists(req.user, code);
  //   return { exists };
  // }

  @Permissions("stores.delete")
  @Delete(":id")
  async remove(@Req() req: any, @Param("id") id: string) {
    return this.storesService.remove(req.user, id);
  }


}
