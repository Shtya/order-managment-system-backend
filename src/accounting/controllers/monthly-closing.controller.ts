import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { SubscriptionGuard } from 'common/subscription.guard';
import { MonthlyClosingService } from '../services/monthly-closing.service';
import { Response } from 'express';
import { Permissions } from 'common/permissions.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('monthly-closings')
export class MonthlyClosingController {
  constructor(private readonly monthlyService: MonthlyClosingService) { }

  @Get()
  @Permissions('accounting.read')
  async list(@Req() req: any, @Query() q: any) {
    return await this.monthlyService.listClosings(req.user, q);
  }


  @Get('export')
  @Permissions('accounting.read')
  async exportShipmentsCityReport(
    @Req() req: any,
    @Res() res: Response,
    @Query() query: {
      storeId?: string;
      startDate?: string;
      endDate?: string;
      range?: string;
      search?: string;
    },
  ) {
    const buffer = await this.monthlyService.exportClosings(req.user, query);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=shipments-city-report-${Date.now()}.xlsx`);


    res.end(buffer);
  }

  @Get('export-detailed')
  @Permissions('accounting.read')
  async exportDetailedClosing(
    @Req() req: any,
    @Res() res: Response,
    @Query() query: {
      year: number;
      month: number;
    },
  ) {
    const buffer = await this.monthlyService.exportDetailedClosing(req.user, query);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=detailed-monthly-closing-${query.month}-${query.year}.xlsx`);

    res.end(buffer);
  }

  @Get('preview')
  @Permissions('accounting.read')
  async getPreview(
    @Req() req: any,
    @Query('year') year: number,
    @Query('month') month: number
  ) {
    return await this.monthlyService.getMonthPreview(req.user, { year, month });
  }

  @Post('close')
  @Permissions('accounting.update')
  async close(@Req() req: any, @Body() dto: { year: number; month: number }) {
    return await this.monthlyService.closeMonth(req.user, dto);
  }


  @Get('stats')
  @Permissions('accounting.read')
  async getFinancialStats(
    @Req() req: any
  ) {
    return await this.monthlyService.getMonthStats(req.user);
  }
  @Get(':id')
  @Permissions('accounting.read')
  async getOne(@Req() req: any, @Param('id') id: string) {
    return await this.monthlyService.getClosing(req.user, id);
  }
}

