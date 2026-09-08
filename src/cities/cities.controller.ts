import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { CitiesService } from "./cities.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/permissions.guard";
import { SubscriptionGuard } from "../../common/subscription.guard";
import { Permissions } from "../../common/permissions.decorator";
import { UpdateCityTenantConfigDto } from "dto/cities.dto";

@Controller("cities")
export class CitiesController {
  constructor(private readonly citiesService: CitiesService) {}

  @Get()
  findAll() {
    return this.citiesService.findAllWithProviders();
  }

  @Get("my-config")
  @UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
  @Permissions("city.read")
  findAllWithConfig(@Req() req: any, @Query() q: any) {
    return this.citiesService.findAllWithTenantConfig(req.user, q);
  }

  @Get("export")
  @UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
  @Permissions("city.read")
  async export(@Req() req: any, @Query() q: any, @Res() res: any) {
    const buffer = await this.citiesService.exportCitiesConfig(req.user, q);
    res.set({
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="cities_config_${Date.now()}.xlsx"`,
      "Content-Length": buffer.byteLength,
    });
    res.end(buffer);
  }

  @Get(":cityId/areas")
  findAreas(@Param("cityId") cityId: string) {
    return this.citiesService.findAreas(cityId);
  }

  @Post(":cityId/config")
  @UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
  @Permissions("city.update")
  upsertConfig(
    @Req() req: any,
    @Param("cityId") cityId: string,
    @Body() dto: UpdateCityTenantConfigDto,
  ) {
    return this.citiesService.upsertTenantConfig(req.user, cityId, dto);
  }

  @Delete(":cityId/config")
  @UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
  @Permissions("city.update")
  deleteConfig(@Req() req: any, @Param("cityId") cityId: string) {
    return this.citiesService.deleteTenantConfig(req.user, cityId);
  }
}
