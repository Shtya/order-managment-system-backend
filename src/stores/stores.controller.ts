import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";
import { StoresService } from "./stores.service";
import { CreateStoreDto, IntegrateDto, UpdateStoreDto } from "dto/stores.dto";
import { Response } from "express";
import { StoreProvider } from "entities/stores.entity";
import { minutes, Throttle } from "@nestjs/throttler";


@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("stores")
@RequireSubscription()
export class StoresController {
  constructor(private storesService: StoresService) { }

  // @Permissions("stores.update") // Requires update permissions
  // @Post(":id/sync")
  // async syncStore(@Req() req: any, @Param("id") id: string) {
  //   return this.storesService.manualSync(req.user, id);
  // }
  //sync from store endpoint
  @Throttle({ default: { limit: 3, ttl: minutes(1) } }) 
  @Permissions("stores.update") // Requires update permissions
  @Post(":id/sync")
  async syncFromStore(@Req() req: any, @Param("id") id: string) {
    return this.storesService.manualSyncFromStore(req.user, id);
  }

  @Permissions("stores.update")
  @Throttle({ default: { limit: 20, ttl: minutes(1) } }) 
  @Post(":id/sync-products")
  async syncSpecificProducts(
    @Req() req: any,
    @Param("id") id: string,
    @Body("productIds") productIds: string[]
  ) {
    return this.storesService.manualSyncSpecificProducts(req.user, id, productIds);
  }


  @Permissions("stores.read")
  @Get('providers')
  providers() {
    return this.storesService.listProviders();
  }


  // List failed orders
  @Permissions("orders.read")
  @Get("failed-orders")
  async listFailedOrders(@Req() req: any, @Query() q: any) {
    return this.storesService.listFailedOrders(req.user, q);
  }

  // Retry failed order
  @Permissions("orders.restoreFailed")
  @Post("failed-orders/:id/retry")
  async retryFailedOrder(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    return this.storesService.retryFailedOrder(req.user, id);
  }

  // Update failed order payload
  @Permissions("orders.update")
  @Patch("failed-orders/:id")
  async updateFailedOrderPayload(
    @Req() req: any,
    @Param("id") id: string,
    @Body() payload: any,
  ) {
    return this.storesService.updateFailedOrderPayload(req.user, id, payload);
  }

  // Failed orders statistics
  @Permissions("orders.read")
  @Get("failed-orders/statistics")
  async failedOrdersStatistics(@Req() req: any) {
    return this.storesService.getFailedOrdersStatistics(req.user);
  }

  @Permissions("orders.read")
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

  // get external product by slug
  @Permissions("stores.read")
  @Get("external/:provider")
  async getExternalProductById(@Req() req: any, @Param("provider") provider: StoreProvider, @Query("id") id: string) {
    return this.storesService.getFullProductById(req.user, provider, id);
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

  @Permissions("stores.create")
  @Post("integrations")
  async integrate(@Req() req: any, @Body() dto: IntegrateDto) {
    return await this.storesService.upsertIntegrate(req.user, dto);
  }

  @Patch(":provider/cancel-integration")
  async cancelIntegration(@Req() req: any, @Param("provider") provider: StoreProvider) {
    return this.storesService.cancelIntegration(req.user, provider);
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


  // Get failed order details with diagnostics
  @Permissions("orders.read")
  @Get("failed-orders/:id")
  async getFailedOrderDetail(@Req() req: any, @Param("id") id: string) {
    return this.storesService.getFailedOrderDetail(req.user, id);
  }
}
