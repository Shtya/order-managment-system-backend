import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { OrderAssignmentService } from './order-assignment.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { SubscriptionGuard } from 'common/subscription.guard';
import { Permissions } from 'common/permissions.decorator';
import { Response } from 'express';
import { AutoAssignDto, AutoPreviewDto, CreateAutoAssignRuleDto, ManualAssignManyDto, RunAutoAssignmentDto, UpdateAutoAssignRuleDto } from 'dto/order-assignment.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('order-assignment')
export class OrderAssignmentController {
  constructor(private readonly orderAssignmentService: OrderAssignmentService) {

  }

  // ✅ Get Employees Ordered By Lowest Active Assignments
  @Permissions("orders.assign")
  @Get("employees-by-load")
  async getEmployeesByLoad(
    @Req() req: any,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('role') role?: string,
  ) {
    return this.orderAssignmentService.getEmployeesByLoad(req.user, Number(limit ?? 20), cursor ? Number(cursor) : null, role ? role : undefined);
  }


  @Permissions("orders.assign")
  @Get("free-orders")
  async getFreeOrders(
    @Req() req: any,
    @Query('statusIds') statusIds?: string, // comma separated
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.orderAssignmentService.getFreeOrders(req.user, {
      statusIds: statusIds
        ? statusIds.split(',').map(id => id)
        : undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      cursor: cursor || undefined,
      limit: Number(limit ?? 20),
    });
  }


  // employee-orders.controller.ts

  @Permissions("orders.confirm-incoming")
  @Get("employee/orders/next")
  async getNextOrder(@Req() req: any) {
    return this.orderAssignmentService.getNextAssignedOrder(req.user);
  }


  @Permissions("orders.assign")
  @Post("assign-manual")
  async manualAssignOrders(@Req() req: any, @Body() dto: ManualAssignManyDto) {
    return this.orderAssignmentService.manualAssignMany(req.user, dto);
  }

  @Permissions("orders.assign")
  @Post("assign-auto")
  async assignAuto(@Req() req: any, @Body() dto: AutoAssignDto) {
    return this.orderAssignmentService.autoAssign(req.user, dto);
  }

  @Permissions("orders.assign")
  @Post('auto-assign-preview')
  async getAutoAssignPreview(
    @Req() req: any,
    @Body() dto: AutoPreviewDto
  ) {
    return await this.orderAssignmentService.getAutoPreview(req.user, dto);
  }

  @Permissions("orders.confirm-incoming")
  @Get('assigned')
  listMyAssigned(@Req() req: any, @Query() q: any) {
    return this.orderAssignmentService.listMyAssignedOrders(req.user, q);
  }

  @Permissions("orders.confirm-incoming")
  @Get("assigned/export")
  async exportMyAssignedOrders(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.orderAssignmentService.exportMyAssignedOrders(req.user, q);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=orders_export_${Date.now()}.xlsx`);

    return res.send(buffer);
  }

  @Permissions("orders.assign")
  @Get("free-orders/count")
  async getFreeOrdersCount(
    @Req() req: any,
    @Query('statusIds') statusIds?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    return this.orderAssignmentService.getFreeOrdersCount(req.user, {
      statusIds: statusIds
        ? statusIds.split(',').map(id => id)
        : undefined,
      startDate: startDate ?? undefined,
      endDate: endDate ?? undefined,
    });
  }

  // =========================================================================
  // AUTO ASSIGN RULES MANAGEMENT
  // =========================================================================

  @Permissions("orders.assign")
  @Get('rules')
  listRules(@Req() req: any, @Query() q: any) {
    return this.orderAssignmentService.listAutoAssignRules(req.user, q);
  }

  @Permissions("orders.assign")
  @Post('rules')
  createRule(@Req() req: any, @Body() dto: CreateAutoAssignRuleDto) {
    return this.orderAssignmentService.createAutoAssignRule(req.user, dto);
  }

  @Permissions("orders.assign")
  @Get("rules/export")
  async exportRules(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.orderAssignmentService.exportAutoAssignRules(req.user, q);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=auto_assign_rules_${Date.now()}.xlsx`);

    return res.send(buffer);
  }

  @Permissions("orders.assign")
  @Get('rules/stats')
  getRulesStats(@Req() req: any) {
    return this.orderAssignmentService.getAutoAssignRulesStats(req.user);
  }

  @Permissions("orders.assign")
  @Get('rules/:id')
  getRuleDetails(@Req() req: any, @Param('id') id: string) {
    return this.orderAssignmentService.getAutoAssignRuleDetails(req.user, id);
  }

  @Permissions("orders.assign")
  @Patch('rules/:id')
  updateRule(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateAutoAssignRuleDto) {
    return this.orderAssignmentService.updateAutoAssignRule(req.user, id, dto);
  }

  @Permissions("orders.assign")
  @Post('rules/:id/toggle')
  toggleRuleActive(@Req() req: any, @Param('id') id: string) {
    return this.orderAssignmentService.toggleAutoAssignRuleActive(req.user, id);
  }

  @Permissions("orders.assign")
  @Delete('rules/:id')
  deleteRule(@Req() req: any, @Param('id') id: string) {
    return this.orderAssignmentService.deleteAutoAssignRule(req.user, id);
  }

  @Permissions("orders.assign")
  @Delete("assignments")
  removeActiveAssignments(
    @Req() req: any,
    @Body("orderIds") orderIds: string[],
  ) {
    return this.orderAssignmentService.removeActiveAssignments(
      req.user,
      orderIds,
    );
  }

  @Permissions("orders.assign")
  @Get("active-stats")
  getAssignmentStats(@Req() req: any) {
    return this.orderAssignmentService.getAssignmentStats(req.user);
  }
}
