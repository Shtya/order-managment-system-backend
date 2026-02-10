import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { StoresService } from "./stores.service";
import { CreateStoreDto, UpdateStoreDto } from "dto/stores.dto";


@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("stores")
export class StoresController {
  constructor(private storesService: StoresService) { }

  @Permissions("stores.update") // Requires update permissions
  @Post(":id/sync")
  async syncStore(@Req() req: any, @Param("id") id: string) {
    return this.storesService.manualSync(req.user, Number(id));
  }

  @Permissions("stores.read")
  @Get()
  async list(@Req() req: any, @Query() q: any) {
    return this.storesService.list(req.user, q);
  }

  @Permissions("stores.read")
  @Get(":id")
  async get(@Req() req: any, @Param("id") id: string) {
    return this.storesService.get(req.user, Number(id));
  }


  @Permissions("stores.create")
  @Post()
  async create(@Req() req: any, @Body() dto: CreateStoreDto) {
    return this.storesService.create(req.user, dto);
  }

  @Permissions("stores.update")
  @Patch(":id")
  async update(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateStoreDto) {
    return this.storesService.update(req.user, Number(id), dto);
  }
  @Permissions("stores.read")
  @Get("check-code/:code")
  async checkCode(@Req() req: any, @Param("code") code: string) {
    const exists = await this.storesService.checkCodeExists(req.user, code);
    return { exists };
  }

  @Permissions("stores.delete")
  @Delete(":id")
  async remove(@Req() req: any, @Param("id") id: string) {
    return this.storesService.remove(req.user, Number(id));
  }
}
