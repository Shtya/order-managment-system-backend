import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { Permissions } from 'common/permissions.decorator';
import { RequireSubscription } from 'common/require-subscription.decorator';
import { SubscriptionGuard } from 'common/subscription.guard';
import { SmsService } from './sms.service';
import { CreateIntegrationDto, CreateSenderDto, SendSmsDto, UpdateIntegrationDto, UpdateSenderDto } from 'dto/sms.dto';
import { Response } from 'express';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('sms')
@RequireSubscription()
export class SmsController {
  constructor(private readonly smsService: SmsService) {}

  // ─── Providers ───────────────────────────────────────────────

  @Permissions('sms.providers.read')
  @Get('providers')
  listProviders() {
    return this.smsService.listProviders();
  }

  // ─── Integrations ────────────────────────────────────────────

  @Permissions('sms.integrations.read')
  @Get('integrations')
  listIntegrations(@Req() req: any) {
    return this.smsService.listIntegrations(req.user);
  }

  @Permissions('sms.integrations.read')
  @Get('integrations/active')
  listActiveIntegrations(@Req() req: any) {
    return this.smsService.listActiveIntegrations(req.user);
  }

  @Permissions('sms.integrations.read')
  @Get('integrations/:provider')
  getIntegration(@Req() req: any, @Param('provider') provider: string) {
    return this.smsService.getIntegration(req.user, provider);
  }

  @Permissions('sms.integrations.create')
  @Post('integrations')
  integrate(@Req() req: any, @Body() dto: CreateIntegrationDto) {
    return this.smsService.integrate(req.user, dto);
  }

  // @Permissions('sms.integrations.update')
  // @Patch('integrations/:provider')
  // updateIntegration(@Req() req: any, @Param('provider') provider: string, @Body() dto: UpdateIntegrationDto) {
  //   return this.smsService.updateIntegration(req.user, provider, dto);
  // }

  @Permissions('sms.integrations.update')
  @Post('integrations/:provider/toggle-active')
  toggleIntegrationActive(@Req() req: any, @Param('provider') provider: string) {
    return this.smsService.toggleIntegrationActive(req.user, provider);
  }

  @Permissions('sms.senders.read')
  @Get('integrations/:id/default-sender')
  getDefaultSenderForIntegration(@Req() req: any, @Param('id') id: string) {
    return this.smsService.getDefaultSenderForIntegration(req.user, id);
  }

  // ─── Senders ─────────────────────────────────────────────────

  @Permissions('sms.senders.read')
  @Get('senders/stats')
  senderStats(@Req() req: any) {
    return this.smsService.senderStats(req.user);
  }

  @Permissions('sms.senders.read')
  @Get('senders')
  listSenders(@Req() req: any, @Query() q: any) {
    return this.smsService.listSenders(req.user, q);
  }

  @Permissions('sms.senders.read')
  @Get('senders/export')
  async exportSenders(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.smsService.exportSenders(req.user, q);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=sms-senders.xlsx');
    res.send(buffer);
  }

  @Permissions('sms.senders.create')
  @Post('senders')
  createSender(@Req() req: any, @Body() dto: CreateSenderDto) {
    return this.smsService.createSender(req.user, dto);
  }

  @Permissions('sms.senders.update')
  @Patch('senders/:id')
  updateSender(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateSenderDto) {
    return this.smsService.updateSender(req.user, id, dto);
  }

  @Permissions('sms.senders.delete')
  @Delete('senders/:id')
  deleteSender(@Req() req: any, @Param('id') id: string) {
    return this.smsService.deleteSender(req.user, id);
  }

  @Permissions('sms.senders.update')
  @Post('senders/:id/set-default')
  setSenderDefault(@Req() req: any, @Param('id') id: string) {
    return this.smsService.setSenderDefault(req.user, id);
  }

  @Permissions('sms.senders.update')
  @Post('senders/:id/toggle-active')
  toggleSenderActive(@Req() req: any, @Param('id') id: string) {
    return this.smsService.toggleSenderActive(req.user, id);
  }

  // ─── Send SMS ────────────────────────────────────────────────

  @Permissions('sms.send')
  @Post('send/:provider')
  sendSms(@Req() req: any, @Param('provider') provider: string, @Body() dto: SendSmsDto) {
    return this.smsService.sendSms(req.user, provider, dto);
  }

  // ─── Logs ────────────────────────────────────────────────────

  @Permissions('sms.logs.read')
  @Get('logs/stats')
  logStats(@Req() req: any) {
    return this.smsService.logStats(req.user);
  }

  @Permissions('sms.logs.read')
  @Get('logs')
  listLogs(@Req() req: any, @Query() q: any) {
    return this.smsService.listLogs(req.user, q);
  }

  @Permissions('sms.logs.read')
  @Get('logs/export')
  async exportLogs(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.smsService.exportLogs(req.user, q);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=sms-logs.xlsx');
    res.send(buffer);
  }

  @Permissions('sms.logs.read')
  @Get('logs/:id')
  getLog(@Req() req: any, @Param('id') id: string) {
    return this.smsService.getLog(req.user, id);
  }

  @Permissions('sms.logs.resend')
  @Post('logs/:id/resend')
  resendLog(@Req() req: any, @Param('id') id: string) {
    return this.smsService.resendLog(req.user, id);
  }
}
