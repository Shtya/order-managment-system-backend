import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ExtraFeaturesService } from './extra-features.service';
import { PermissionsGuard } from 'common/permissions.guard';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { SubscriptionStatus } from 'entities/plans.entity';
import { AssignUserFeatureDto, UpdateFeatureDto } from 'dto/feature.dto';
import { Permissions } from 'common/permissions.decorator';
import { RequireSubscription } from 'common/require-subscription.decorator';
import { SubscriptionGuard } from 'common/subscription.guard';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('extra-features')
export class ExtraFeaturesController {
  constructor(private readonly extraFeaturesService: ExtraFeaturesService) {
  }

  @Permissions("extra-features.read")
  @Get()
  async list(@Req() req, @Query() q) {
    return await this.extraFeaturesService.list(req.user, q);
  }

  @Permissions("extra-features.read")
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

  @Permissions("extra-features.create")
  @Post('purchase-addon')
  async purchaseAddon(
    @Req() req: any,
    @Body('featureId', ParseIntPipe) featureId: string
  ) {

    return this.extraFeaturesService.purchaseFeature(req.user, featureId);;
  }

  @Permissions("extra-features.update")
  @Patch('features/:id')
  async updateFeature(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: string,
    @Body() dto: UpdateFeatureDto
  ) {
    return await this.extraFeaturesService.updateFeature(req.user, id, dto);
  }

  @Permissions("extra-features.read")
  @Get('features')
  async getAllFeatures() {
    return await this.extraFeaturesService.getAllFeaturesDefinitions();
  }

  @Permissions("extra-features.update")
  @Post('assign')
  async assignFeature(
    @Req() req,
    @Body() dto: AssignUserFeatureDto
  ) {
    return await this.extraFeaturesService.assignFeatureToUser(req.user, dto);
  }

  @Permissions("extra-features.read")
  @Get('user')
  async getUserFeatures(
    @Req() req: any,
  ) {
    return this.extraFeaturesService.getUserFeatures(req.user);
  }

}
