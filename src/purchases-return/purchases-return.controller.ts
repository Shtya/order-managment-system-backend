// purchases-return/purchases-return.controller.ts
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { PurchaseReturnsService } from "./purchases-return.service";
import { CreatePurchaseReturnDto, UpdatePurchaseReturnDto, UpdatePurchaseReturnStatusDto } from "dto/purchase_return.dto";

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("purchases-return")
export class PurchaseReturnsController {
  constructor(private svc: PurchaseReturnsService) {}

  @Permissions("purchase_returns.read")
  @Get("stats")
  stats(@Req() req: any) {
    return this.svc.stats(req.user);
  }

  @Permissions("purchase_returns.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.svc.list(req.user, q);
  }

  @Permissions("purchase_returns.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.svc.get(req.user, Number(id));
  }

  @Permissions("purchase_returns.create")
  @Post()
  create(@Req() req: any, @Body() dto: CreatePurchaseReturnDto) {
    return this.svc.create(req.user, dto);
  }

  @Permissions("purchase_returns.update")
  @Patch(":id")
  update(@Req() req: any, @Param("id") id: string, @Body() dto: UpdatePurchaseReturnDto) {
    return this.svc.update(req.user, Number(id), dto);
  }

  @Permissions("purchase_returns.update")
  @Patch(":id/status")
  updateStatus(@Req() req: any, @Param("id") id: string, @Body() dto: UpdatePurchaseReturnStatusDto) {
    return this.svc.updateStatus(req.user, Number(id), dto.status);
  }

  @Permissions("purchase_returns.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.svc.remove(req.user, Number(id));
  }
}
