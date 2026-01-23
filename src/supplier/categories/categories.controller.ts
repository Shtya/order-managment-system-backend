import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
 import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator"; 
import { SupplierCategoriesService } from "./categories.service";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { CreateSupplierCategoryDto, UpdateSupplierCategoryDto } from "../../../dto/supplier.dto";
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("supplier-categories")
export class SupplierCategoriesController {
  constructor(private categoriesService: SupplierCategoriesService) {}

  @Permissions("suppliers.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.categoriesService.list(req.user, q);
  }

  @Permissions("suppliers.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.categoriesService.get(req.user, Number(id));
  }

  @Permissions("suppliers.create")
  @Post()
  create(@Req() req: any, @Body() dto: CreateSupplierCategoryDto) {
    return this.categoriesService.create(req.user, dto);
  }

  @Permissions("suppliers.update")
  @Patch(":id")
  update(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateSupplierCategoryDto) {
    return this.categoriesService.update(req.user, Number(id), dto);
  }

  @Permissions("suppliers.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.categoriesService.remove(req.user, Number(id));
  }
}