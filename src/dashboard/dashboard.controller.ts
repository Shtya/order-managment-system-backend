import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { Response } from 'express';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) { }

  @Get('summary')
  async getSummary(
    @Req() req: any,
    @Query() q: any
  ) {
    return this.dashboardService.getSummary(req.user, q);
  }

  @Get('trend')
  async getTrend(@Query() query, @Req() req) {
    return this.dashboardService.getTrends(req.user, query);
  }

  @Get('top-products')
  async getTopProducts(
    @Req() req,
    @Query() query
  ) {
    return this.dashboardService.getTopProducts(req.user, query);
  }

  @Get('profit-report')
  async getProfitReport(
    @Req() req,
    @Query('storeId') storeId?: number,
    @Query('range') range?: string,
  ) {
    return this.dashboardService.getProfitReport(req.user, { storeId, range });
  }

  @Get('profit-report/export')
  async exportProfitReport(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.dashboardService.exportProfitExcel(req.user, q);

    const filename = `profit_report_${new Date().toISOString().split('T')[0]}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    return res.send(buffer);
  }

  @Get('orders/stats')
  async getOrderAnalysis(@Req() req: any, @Query() query) {
    return this.dashboardService.getOrderAnalysisStats(req.user, query);
  }


  @Get('orders/trend')
  async getOrderTrend(@Req() req: any, @Query() query) {
    return this.dashboardService.getOrdersTrends(req.user, query);
  }

  @Get('orders/top-areas')
  async getTopAreasReport(@Req() req: any, @Query() query) {
    return this.dashboardService.getTopAreasReport(req.user, query);
  }

  @Get('orders/top-areas/export')
  async exportTopAreasReport(@Req() req: any, @Query() query, @Res() res: Response) {
    const buffer = await this.dashboardService.exportTopAreasReport(req.user, query);

    const filename = `top_areas_report_${new Date().toISOString().split('T')[0]}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    return res.send(buffer);
  }

  @Get('employees/stats')
  async getEmployeeStats(
    @Req() req: any,
    @Query() filters: { storeId?: number; startDate?: string; endDate?: string; range?: string }
  ) {
    return this.dashboardService.getEmployeePerformance(req.user, filters);
  }

  @Get('employees/stats/export')
  async exportEmployeeStats(@Req() req: any, @Query() query: any, @Res() res: Response) {
    const buffer = await this.dashboardService.exportEmployeePerformance(req.user, query);

    const filename = `employee_performance_${new Date().toISOString().split('T')[0]}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    return res.send(buffer);
  }

  @Get('employees/stats/summary')
  async getEmployeeAnalysisStats(@Req() req: any, @Query() query) {
    return this.dashboardService.getEmployeeAnalysisStats(req.user, query);
  }
}