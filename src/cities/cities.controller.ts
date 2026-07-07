import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { CitiesService } from './cities.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/permissions.guard';
import { SubscriptionGuard } from '../../common/subscription.guard';
import { Permissions } from '../../common/permissions.decorator';
import { UpdateCityTenantConfigDto } from 'dto/cities.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('cities')
export class CitiesController {
  constructor(private readonly citiesService: CitiesService) {}

  @Get()
  findAll(@Req() req: any) {
    return this.citiesService.findAllWithProviders();
  }

  @Get(':cityId/areas')
  findAreas(@Req() req: any, @Param('cityId') cityId: string) {
    return this.citiesService.findAreas(cityId);
  }

  @Get('my-config')
  @Permissions('city.read')
  findAllWithConfig(@Req() req: any, @Query() q: any) {
    return this.citiesService.findAllWithTenantConfig(req.user, q);
  }

  @Get('export')
  @Permissions('city.read')
  async export(@Req() req: any, @Query() q: any, @Res() res: any) {
    const buffer = await this.citiesService.exportCitiesConfig(req.user, q);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="cities_config_${Date.now()}.xlsx"`,
      'Content-Length': buffer.byteLength,
    });
    res.end(buffer);
  }

  @Post(':cityId/config')
  @Permissions('city.update')
  upsertConfig(
    @Req() req: any,
    @Param('cityId') cityId: string,
    @Body() dto: UpdateCityTenantConfigDto
  ) {
    return this.citiesService.upsertTenantConfig(req.user, cityId, dto);
  }

  @Delete(':cityId/config')
  @Permissions('city.update')
  deleteConfig(@Req() req: any, @Param('cityId') cityId: string) {
    return this.citiesService.deleteTenantConfig(req.user, cityId);
  }
}
