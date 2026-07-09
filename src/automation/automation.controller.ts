import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AutomationService } from './automation.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { SubscriptionGuard } from 'common/subscription.guard';
import { Permissions } from 'common/permissions.decorator';
import { CreateAutomationDto, UpdateAutomationDto } from 'dto/automation.dto';
import { AutomationStatus } from 'entities/automation.entity';
import { Response } from 'express';
import { AutomationPreviewService, CreatePreviewInput, PreviewResumeInput } from './engine/automation-preview.service';
import { tenantId } from 'src/category/category.service';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('automation')
export class AutomationController {
  constructor(
    private readonly automationService: AutomationService,
    private readonly automationPreviewService: AutomationPreviewService,
  ) { }

  @Get('stats')
  @Permissions('automation.read')
  async getFlowsStats(@Req() req: any) {
    return this.automationService.getFlowsStats(req.user);
  }

  @Post('preview')
  @Permissions('automation.read')
  async createPreview(
    @Req() req: any,
    @Body() dto: CreatePreviewInput,
  ) {
    const adminId = tenantId(req.user);
    return this.automationPreviewService.createPreview(req.user, { ...dto, adminId });
  }

  @Get('preview/:previewId')
  @Permissions('automation.read')
  async getPreview(
    @Param('previewId') previewId: string,
  ) {
    return this.automationPreviewService.getPreview(previewId);
  }

  @Post('preview/:previewId/heartbeat')
  @Permissions('automation.read')
  async heartbeatPreview(
    @Param('previewId') previewId: string,
  ) {
    return this.automationPreviewService.touchPreview(previewId);
  }

  @Delete('preview/:previewId')
  @Permissions('automation.read')
  async deletePreview(
    @Param('previewId') previewId: string,
  ) {
    await this.automationPreviewService.deletePreview(previewId);

    return {
      success: true,
    };
  }

  @Post('preview/:previewId/resume')
  @Permissions('automation.read')
  async resumePreview(
    @Param('previewId') previewId: string,
    @Body() dto: PreviewResumeInput,
  ) {
    return this.automationPreviewService.resumePreview({
      previewId,
      buttonText: dto.buttonText,
      buttonId: dto.buttonId,
    });
  }

  @Get('export')
  @Permissions('automation.read')
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.automationService.export(req.user, q);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=automations_export_${Date.now()}.xlsx`);
    return res.send(buffer);
  }

  @Get('runs/export')
  @Permissions('automation.read')
  async exportRuns(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.automationService.exportRuns(req.user, q);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=automation_runs_export_${Date.now()}.xlsx`);
    return res.send(buffer);
  }

  @Post()
  @Permissions('automation.create')
  create(@Req() req: any, @Body() dto: CreateAutomationDto) {
    return this.automationService.create(req.user, dto);
  }

  @Get()
  @Permissions('automation.read')
  findAll(@Req() req: any, @Query() q: any) {
    return this.automationService.findAll(req.user, q);
  }

  @Get('runs/stats')
  @Permissions('automation.read')
  async getRunsStats(@Req() req: any) {
    return this.automationService.getRunsStats(req.user);
  }

  @Get('runs')
  @Permissions('automation.read')
  findAllRuns(@Req() req: any, @Query() q: any) {
    return this.automationService.findAllRuns(req.user, q);
  }

  @Get('runs/:id')
  @Permissions('automation.read')
  findOneRun(@Req() req: any, @Param('id') id: string) {
    return this.automationService.findOneRun(req.user, id);
  }

  @Post('runs/:id/retry')
  @Permissions('automation.update')
  retryRun(@Req() req: any, @Param('id') id: string, @Body() body?: { useLatestVersion?: boolean }) {
    return this.automationService.retryRun(req.user, id, body?.useLatestVersion);
  }

  @Get(':id')
  @Permissions('automation.read')
  findOne(@Req() req: any, @Param('id') id: string, @Query('version') version?: string) {
    return this.automationService.findOne(req.user, id, version);
  }

  @Delete(':id')
  @Permissions('automation.delete')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.automationService.delete(req.user, id);
  }

  @Put(':id')
  @Permissions('automation.update')
  update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateAutomationDto) {
    return this.automationService.update(req.user, id, dto);
  }


  @Post(':id/:status')
  @Permissions('automation.update')
  changeStatus(@Req() req: any, @Param('id') id: string, @Param('status') status: AutomationStatus) {
    return this.automationService.changeStatus(req.user, id, status);
  }
}
