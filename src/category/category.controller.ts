import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { CategoriesService } from "./category.service";
import { CreateCategoryDto, UpdateCategoryDto } from "dto/category.dto";

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("categories")
export class CategoriesController {
  constructor(private cats: CategoriesService) {}

  @Permissions("categories.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.cats.list(req.user, q);
  }

  @Permissions("categories.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.cats.get(req.user, Number(id));
  }

  @Permissions("categories.create")
  @Post()
  create(@Req() req: any, @Body() dto: any) {
    return this.cats.create(req.user, dto);
  }

  @Permissions("categories.update")
  @Patch(":id")
  update(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateCategoryDto) {
    return this.cats.update(req.user, Number(id), dto);
  }

  @Permissions("categories.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.cats.remove(req.user, Number(id));
  }
}
