import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { SubscriptionGuard } from 'common/subscription.guard';
import { MonthlyClosingService } from '../services/monthly-closing.service';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('monthly-closings')
export class MonthlyClosingController {
  constructor(private readonly monthlyService: MonthlyClosingService) { }

  @Get()
  async list(@Req() req: any, @Query() q: any) {
    return await this.monthlyService.listClosings(req.user, q);
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
  async getOne(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return await this.monthlyService.getClosing(req.user, id);
  }
}

