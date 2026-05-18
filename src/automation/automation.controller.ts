import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AutomationService } from './automation.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { SubscriptionGuard } from 'common/subscription.guard';
import { Permissions } from 'common/permissions.decorator';
import { CreateAutomationDto, UpdateAutomationDto } from 'dto/automation.dto';
import { AutomationStatus } from 'entities/automation.entity';
import { Response } from 'express';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('automation')
export class AutomationController {
  constructor(private readonly automationService: AutomationService) { }

  @Get('export')
  @Permissions('automation.read')
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.automationService.export(req.user, q);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=automations_export_${Date.now()}.xlsx`);
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
