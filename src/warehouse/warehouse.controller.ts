import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";
import { WarehousesService } from "./warehouse.service";
import { CreateWarehouseDto, UpdateWarehouseDto } from "dto/warehouse.dto";

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller("warehouses")
@RequireSubscription()
export class WarehousesController {
	constructor(private wh: WarehousesService) { }

	@Permissions("warehouses.read")
	@Get()
	list(@Req() req: any, @Query() q: any) {
		return this.wh.list(req.user, q);
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
	update(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateWarehouseDto) {
		return this.wh.update(req.user, id, dto);
	}

	@Permissions("warehouses.delete")
	@Delete(":id")
	remove(@Req() req: any, @Param("id") id: string) {
		return this.wh.remove(req.user, id);
	}
}
