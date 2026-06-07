import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AccountingService } from '../services/accounting.service';
import { AccountingStatsDto, CloseSupplierPeriodDto } from 'dto/accounting.dto';
import { SubscriptionGuard } from 'common/subscription.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { Permissions } from 'common/permissions.decorator';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { Response } from 'express';


@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('accounting')
export class AccountingController {
  constructor(private readonly accountingService: AccountingService) {
  }

  @Get('stats')
  @Permissions('accounting.read')
  async getStats(
    @Req() req: any,
    @Query() query: AccountingStatsDto
  ) {

    return await this.accountingService.getStats(req.user, query);
  }

  @Get('last-expenses')
  @Permissions('accounting.read')
  async getLastExpenses(@Req() req: any, @Query() query: AccountingStatsDto) {
    return await this.accountingService.getLastExpenses(req.user, query);
  }

  @Get('trend')
  @Permissions('accounting.read')
  async getTrend(@Query() query, @Req() req) {
    return this.accountingService.getExpensesTrend(req.user, query);
  }

  @Get('suppliers-balances')
  @Permissions('accounting.read')
  async getSuppliersBalances(
    @Req() req: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return await this.accountingService.getTopSuppliersBalances(req.user, {
      startDate,
      endDate,
    });
  }

  @Get('shipments-city-report')
  @Permissions('accounting.read')
  async getShipmentsCityReport(
    @Req() req: any,
    @Query() query: {
      storeId?: string;
      startDate?: string;
      endDate?: string;
      range?: string;
      page?: number;
      limit?: number;
      search?: string;
    },
  ) {

    return await this.accountingService.getShipmentsCityReport(req.user, query);
  }

  @Get('shipments-city-report/export')
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
    const buffer = await this.accountingService.exportShipmentsCityReport(req.user, query);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=shipments-city-report-${Date.now()}.xlsx`);


    res.end(buffer);
  }


  @Get('shipments-summary')
  @Permissions('accounting.read')
  async getShipmentsSummary(@Req() req: any) {
    return this.accountingService.getShipmentPerformanceSummary(req.user);
  }

  @Post('supplier-closings/close')
  @Permissions('accounting.update')
  async closeSupplierPeriod(
    @Req() req: any,
    @Body() dto: CloseSupplierPeriodDto
  ) {

    return await this.accountingService.closeSupplierPeriod(
      req.user,
      dto.supplierId,
      dto.startDate,
      dto.endDate
    );
  }

  @Get('supplier-closings/closings')
  @Permissions('accounting.read')
  async listClosings(@Req() req: any, @Query() query: any) {
    return await this.accountingService.listSupplierClosings(req.user, query);
  }

  @Get('supplier-closings/financial-stats')
  @Permissions('accounting.read')
  async getFinancialStats(
    @Req() req: any
  ) {
    return await this.accountingService.getSupplierPeriodPreview(req.user, null, null, null);
  }

  @Get('supplier-closings/supplier-preview')
  @Permissions('accounting.read')
  async getPreview(
    @Req() req: any,
    @Query('supplierId') supplierId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string
  ) {
    return await this.accountingService.getSupplierPeriodPreview(req.user, supplierId, startDate, endDate);
  }
  @Get('supplier-closings/:id')
  @Permissions('accounting.read')
  async getOne(@Req() req: any, @Param('id') id: string) {
    return await this.accountingService.getSupplierClosing(req.user, id);
  }
}
