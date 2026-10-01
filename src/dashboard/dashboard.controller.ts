import { Controller, Get, Query, Req, Res, UseGuards } from "@nestjs/common";
import { DashboardService } from "./dashboard.service";
import { AiDashboardService } from "./ai-dashboard.service";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Response } from "express";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller("dashboard")
@RequireSubscription()
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly aiDashboard: AiDashboardService,
  ) {}

  @Permissions("dashboard.read")
  @Get("summary")
  async getSummary(@Req() req: any, @Query() q: any) {
    return this.dashboardService.getSummary(req.user, q);
  }

  @Permissions("dashboard.read")
  @Get("trend")
  async getTrend(@Query() query, @Req() req) {
    return this.dashboardService.getTrends(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("top-products")
  async getTopProducts(@Req() req, @Query() query) {
    return this.dashboardService.getTopProducts(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("profit-report")
  async getProfitReport(
    @Req() req,
    @Query("storeId") storeId?: string,
    @Query("range") range?: string,
  ) {
    return this.dashboardService.getProfitReport(req.user, { storeId, range });
  }

  @Permissions("dashboard.read")
  @Get("profit-report/export")
  async exportProfitReport(
    @Req() req: any,
    @Query() q: any,
    @Res() res: Response,
  ) {
    const buffer = await this.dashboardService.exportProfitExcel(req.user, q);

    const filename = `profit_report_${new Date().toISOString().split("T")[0]}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    return res.send(buffer);
  }

  @Permissions("dashboard.read")
  @Get("orders/stats")
  async getOrderAnalysis(@Req() req: any, @Query() query) {
    return this.dashboardService.getOrderAnalysisStats(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("orders/trend")
  async getOrderTrend(@Req() req: any, @Query() query) {
    return this.dashboardService.getOrdersTrends(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("orders/top-areas")
  async getTopAreasReport(@Req() req: any, @Query() query) {
    return this.dashboardService.getTopAreasReport(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("orders/top-areas/export")
  async exportTopAreasReport(
    @Req() req: any,
    @Query() query,
    @Res() res: Response,
  ) {
    const buffer = await this.dashboardService.exportTopAreasReport(
      req.user,
      query,
    );

    const filename = `top_areas_report_${new Date().toISOString().split("T")[0]}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    return res.send(buffer);
  }

  @Permissions("dashboard.read")
  @Get("orders/top-products/export")
  async exportTopProductsReport(
    @Req() req: any,
    @Query() query,
    @Res() res: Response,
  ) {
    const buffer = await this.dashboardService.exportTopProductsReport(
      req.user,
      query,
    );

    const filename = `top_products_report_${new Date().toISOString().split("T")[0]}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    return res.send(buffer);
  }

  @Permissions("dashboard.read")
  @Get("employees/stats")
  async getEmployeeStats(
    @Req() req: any,
    @Query()
    filters: {
      storeId?: string;
      startDate?: string;
      endDate?: string;
      range?: string;
    },
  ) {
    return this.dashboardService.getEmployeePerformance(req.user, filters);
  }

  @Permissions("dashboard.read")
  @Get("employees/stats/export")
  async exportEmployeeStats(
    @Req() req: any,
    @Query() query: any,
    @Res() res: Response,
  ) {
    const buffer = await this.dashboardService.exportEmployeePerformance(
      req.user,
      query,
    );

    const filename = `employee_performance_${new Date().toISOString().split("T")[0]}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    return res.send(buffer);
  }

  @Get("employees/stats/summary")
  async getEmployeeAnalysisStats(@Req() req: any, @Query() query) {
    return this.dashboardService.getEmployeeAnalysisStats(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("advanced-stats")
  async getAdvancedStats(
    @Req() req: any,
    @Query()
    filters: {
      storeId?: string;
      shippingCompanyId?: string;
      assignedUserId?: string;
      productIds?: string | string[];
      cityId?: string;
      startDate?: string;
      endDate?: string;
      range?: string;
    },
  ) {
    return this.dashboardService.getAdvancedStats(req.user, filters);
  }

  @Permissions("dashboard.read")
  @Get("weekly-trend")
  async getWeeklyTrend(
    @Req() req: any,
    @Query()
    filters: {
      storeId?: string;
      shippingCompanyId?: string;
      assignedUserId?: string;
      productIds?: string | string[];
      cityId?: string;
    },
  ) {
    return this.dashboardService.getWeeklyTrend(req.user, filters);
  }

  @Permissions("dashboard.read")
  @Get("top-cities-stats")
  async getTopCitiesStats(
    @Req() req: any,
    @Query()
    filters: {
      storeId?: string;
      shippingCompanyId?: string;
      assignedUserId?: string;
      productIds?: string | string[];
      startDate?: string;
      endDate?: string;
      range?: string;
      limit?: number;
    },
  ) {
    return this.dashboardService.getTopCitiesStats(req.user, filters);
  }

  @Permissions("dashboard.read")
  @Get("top-products-stats")
  async getTopProductsStats(
    @Req() req: any,
    @Query()
    filters: {
      storeId?: string;
      shippingCompanyId?: string;
      assignedUserId?: string;
      cityId?: string;
      startDate?: string;
      endDate?: string;
      range?: string;
      limit?: number;
    },
  ) {
    return this.dashboardService.getTopProductsStats(req.user, filters);
  }

  @Permissions("dashboard.read")
  @Get("ai/overview")
  aiOverview(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.overview(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/tokens/over-time")
  aiTokensOverTime(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.tokensOverTime(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/tokens/by-agent")
  aiTokensByAgent(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.tokensByAgent(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/tokens/by-model")
  aiTokensByModel(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.tokensByModel(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/cost/over-time")
  aiCostOverTime(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.costOverTime(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/cost/by-agent")
  aiCostByAgent(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.costByAgent(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/cost/by-model")
  aiCostByModel(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.costByModel(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/cost/by-media-type")
  aiCostByMediaType(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.costByMediaType(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/cost/breakdown")
  aiCostBreakdown(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.costBreakdown(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/credits")
  aiCredits(@Req() req: any) {
    return this.aiDashboard.credits(req.user);
  }

  @Permissions("dashboard.read")
  @Get("ai/agents")
  aiAgents(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.agentsTable(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/media/summary")
  aiMediaSummary(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.mediaSummary(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/media/over-time")
  aiMediaOverTime(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.mediaOverTime(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/tools/summary")
  aiToolsSummary(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.toolsSummary(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/sessions/export")
  async aiSessionsExport(
    @Req() req: any,
    @Query() query: any,
    @Res() res: Response,
  ) {
    const csv = await this.aiDashboard.exportSessions(req.user, query);
    const filename = `ai-sessions-${new Date().toISOString().split("T")[0]}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
    return res.send(csv);
  }

  @Permissions("dashboard.read")
  @Get("ai/sessions")
  aiSessions(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.sessions(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/customers/top")
  aiTopCustomers(@Req() req: any, @Query() query: any) {
    return this.aiDashboard.topCustomers(req.user, query);
  }

  @Permissions("dashboard.read")
  @Get("ai/filters")
  aiFilters(@Req() req: any) {
    return this.aiDashboard.filters(req.user);
  }
}
