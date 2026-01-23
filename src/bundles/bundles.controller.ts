// --- File: src/bundles/bundles.controller.ts ---
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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { BundlesService } from "./bundles.service";
import { CreateBundleDto, UpdateBundleDto } from "dto/bundle.dto";

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("bundles")
export class BundlesController {
  constructor(private bundles: BundlesService) {}

  @Permissions("products.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.bundles.list(req.user, q);
  }

  @Permissions("products.read")
  @Get("by-sku/:sku")
  getBySku(@Req() req: any, @Param("sku") sku: string) {
    return this.bundles.getBySku(req.user, sku);
  }

  @Permissions("products.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.bundles.get(req.user, Number(id));
  }

  @Permissions("products.create")
  @Post()
  create(@Req() req: any, @Body() dto: CreateBundleDto) {
    return this.bundles.create(req.user, dto);
  }

  @Permissions("products.update")
  @Patch(":id")
  update(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateBundleDto) {
    return this.bundles.update(req.user, Number(id), dto);
  }

  @Permissions("products.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.bundles.remove(req.user, Number(id));
  }
}
