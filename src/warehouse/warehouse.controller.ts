import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";
import { WarehousesService } from "./warehouse.service";
import { CreateWarehouseDto, UpdateWarehouseDto } from "dto/warehouse.dto";
import {
  CreateStorageLocationDto,
  UpdateStorageLocationDto,
} from "dto/storage-location.dto";
import { PrivateGuard } from "common/private.guard";
import { Response } from "express";

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller("warehouses")
@RequireSubscription()
export class WarehousesController {
  constructor(private wh: WarehousesService) {}

  @Permissions("warehouses.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.wh.list(req.user, q);
  }

  @Get("export")
  @Permissions("warehouses.read")
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.wh.export(req.user, q);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=warehouses.xlsx",
    );
    res.send(buffer);
  }

  @Permissions("warehouses.read")
  @Get("stats")
  stats(@Req() req: any) {
    return this.wh.stats(req.user);
  }

  @Permissions("warehouses.locations.read")
  @Get("locations/stats")
  locationStats(@Req() req: any, @Query("warehouseId") warehouseId?: string) {
    return this.wh.locationStats(req.user, warehouseId);
  }

  @Permissions("warehouses.locations.read")
  @Get("locations")
  listLocations(@Req() req: any, @Query() q: any) {
    return this.wh.listLocations(req.user, q);
  }

  @Get("locations/export")
  @Permissions("warehouses.read")
  async exportLocations(
    @Req() req: any,
    @Query() q: any,
    @Res() res: Response,
  ) {
    const buffer = await this.wh.exportLocations(req.user, q);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", "attachment; filename=locations.xlsx");
    res.send(buffer);
  }

  @Permissions("warehouses.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.wh.get(req.user, id);
  }

  @Permissions("warehouses.create")
  @Post()
  create(@Req() req: any, @Body() dto: CreateWarehouseDto) {
    return this.wh.create(req.user, dto);
  }

  @Permissions("warehouses.update")
  @Patch(":id")
  update(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: UpdateWarehouseDto,
  ) {
    return this.wh.update(req.user, id, dto);
  }

  @Permissions("warehouses.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.wh.remove(req.user, id);
  }

  @Permissions("warehouses.update")
  @Post(":id/toggle-status")
  toggleStatus(@Req() req: any, @Param("id") id: string) {
    return this.wh.toggleStatus(req.user, id);
  }

  @Permissions("warehouses.locations.create")
  @Post(":warehouseId/locations")
  createLocation(
    @Req() req: any,
    @Param("warehouseId") warehouseId: string,
    @Body() dto: CreateStorageLocationDto,
  ) {
    return this.wh.createLocation(req.user, warehouseId, dto);
  }

  @Permissions("warehouses.locations.update")
  @Patch(":warehouseId/locations/:locationId")
  updateLocation(
    @Req() req: any,
    @Param("warehouseId") warehouseId: string,
    @Param("locationId") locationId: string,
    @Body() dto: UpdateStorageLocationDto,
  ) {
    return this.wh.updateLocation(req.user, warehouseId, locationId, dto);
  }

  @Permissions("warehouses.locations.delete")
  @Delete(":warehouseId/locations/:locationId")
  removeLocation(
    @Req() req: any,
    @Param("warehouseId") warehouseId: string,
    @Param("locationId") locationId: string,
  ) {
    return this.wh.removeLocation(req.user, warehouseId, locationId);
  }

  @Permissions("warehouses.locations.update")
  @Post(":warehouseId/locations/:locationId/toggle-status")
  toggleLocationStatus(
    @Req() req: any,
    @Param("warehouseId") warehouseId: string,
    @Param("locationId") locationId: string,
  ) {
    return this.wh.toggleLocationStatus(req.user, warehouseId, locationId);
  }
}
