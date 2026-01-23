import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { StoresService } from "./stores.service";
import { CreateStoreDto, UpdateStoreDto } from "dto/stores.dto";

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("stores")
export class StoresController {
  constructor(private stores: StoresService) {}

  @Permissions("stores.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.stores.list(req.user, q);
  }

  @Permissions("stores.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.stores.get(req.user, Number(id));
  }

  @Permissions("stores.create")
  @Post()
  create(@Req() req: any, @Body() dto: CreateStoreDto) {
    return this.stores.create(req.user, dto);
  }

  @Permissions("stores.update")
  @Patch(":id")
  update(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateStoreDto) {
    return this.stores.update(req.user, Number(id), dto);
  }

  @Permissions("stores.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.stores.remove(req.user, Number(id));
  }
}
