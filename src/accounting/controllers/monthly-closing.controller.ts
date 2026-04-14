import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { SubscriptionGuard } from 'common/subscription.guard';
import { MonthlyClosingService } from '../services/monthly-closing.service';
import { Response } from 'express';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('monthly-closings')
export class MonthlyClosingController {
  constructor(private readonly monthlyService: MonthlyClosingService) { }

  @Get()
  async list(@Req() req: any, @Query() q: any) {
    return await this.monthlyService.listClosings(req.user, q);
  }


  @Get('export')
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

  @Get('preview')
  async getPreview(
    @Req() req: any,
    @Query('year') year: number,
    @Query('month') month: number
  ) {
    return await this.monthlyService.getMonthPreview(req.user, { year, month });
  }

  @Post('close')
  async close(@Req() req: any, @Body() dto: { year: number; month: number }) {
    return await this.monthlyService.closeMonth(req.user, dto);
  }


  @Get('stats')
  async getFinancialStats(
    @Req() req: any
  ) {
    return await this.monthlyService.getMonthStats(req.user);
  }
  @Get(':id')
  async getOne(@Req() req: any, @Param('id', ParseIntPipe) id: string) {
    return await this.monthlyService.getClosing(req.user, id);
  }
}

