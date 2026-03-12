import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ExtraFeaturesService } from './extra-features.service';
import { PermissionsGuard } from 'common/permissions.guard';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { SubscriptionStatus } from 'entities/plans.entity';
import { AssignUserFeatureDto, UpdateFeatureDto } from 'dto/feature.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('extra-features')
export class ExtraFeaturesController {
  constructor(private readonly extraFeaturesService: ExtraFeaturesService) {
  }

  @Get()
  async list(@Req() req, @Query() q) {
    return await this.extraFeaturesService.list(req.user, q);
  }

  @Get('export')
  async export(@Req() req, @Query() q, @Res() res) {
    const buffer = await this.extraFeaturesService.exportExtraFeatures(req.user, q);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="extra_features_${Date.now()}.xlsx"`,
      'Content-Length': buffer.byteLength,
    });
    res.end(buffer);
  }

  @Post('purchase-addon')
  async purchaseAddon(
    @Req() req: any,
    @Body('featureId', ParseIntPipe) featureId: number
  ) {

    return this.extraFeaturesService.purchaseFeature(req.user, featureId);;
  }

  @Patch('features/:id')
  async updateFeature(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFeatureDto
  ) {
    return await this.extraFeaturesService.updateFeature(req.user, id, dto);
  }

  @Get('features')
  async getAllFeatures() {
    return await this.extraFeaturesService.getAllFeaturesDefinitions();
  }

  @Post('assign')
  async assignFeature(
    @Req() req,
    @Body() dto: AssignUserFeatureDto
  ) {
    return await this.extraFeaturesService.assignFeatureToUser(req.user, dto);
  }

  @Get('user')
  async getUserFeatures(
    @Req() req: any,
  ) {
    return this.extraFeaturesService.getUserFeatures(req.user);
  }

}
