import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";
import { CancelCausesService } from "./cancel-causes.service";
import {
  CreateCancelCauseDto,
  ReviewCancelCauseDto,
  UpdateCancelCauseDto,
} from "dto/cancel-cause.dto";

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller("cancel-causes")
@RequireSubscription()
export class CancelCausesController {
  constructor(private readonly cancelCausesService: CancelCausesService) {}

  @Permissions("cancel-causes.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.cancelCausesService.list(req.user, q);
  }

  @Permissions("cancel-causes.read", "cancel-causes.getonly")
  @Get("selectable")
  selectable(@Req() req: any, @Query() q: any) {
    return this.cancelCausesService.listSelectable(req.user, q);
  }

  @Permissions("cancel-causes.read", "orders.read")
  @Get("order/:orderId/history")
  orderHistory(
    @Req() req: any,
    @Param("orderId") orderId: string,
    @Query() q: any,
  ) {
    return this.cancelCausesService.listOrderHistory(req.user, orderId, q);
  }

  @Permissions("cancel-causes.read", "products.read")
  @Get("product/:productId/causes")
  productCauses(
    @Req() req: any,
    @Param("productId") productId: string,
    @Query() q: any,
  ) {
    return this.cancelCausesService.getProductCauseBreakdown(
      req.user,
      productId,
      q,
    );
  }

  @Permissions("cancel-causes.review")
  @Get("pending")
  pending(@Req() req: any, @Query() q: any) {
    return this.cancelCausesService.listPending(req.user, q);
  }

  @Permissions("cancel-causes.read")
  @Get("export")
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.cancelCausesService.export(req.user, q);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=cancel_causes_${Date.now()}.xlsx`,
    );
    res.send(buffer);
  }

  @Permissions("cancel-causes.statistics")
  @Get("statistics")
  statistics(@Req() req: any, @Query() q: any) {
    return this.cancelCausesService.getOverviewStatistics(req.user, q);
  }
  
  @Permissions("cancel-causes.statistics")
  @Get("statistics/by-cause")
  byCause(@Req() req: any, @Query() q: any) {
    return this.cancelCausesService.getByCauseStatistics(req.user, q);
  }

  @Permissions("cancel-causes.statistics")
  @Get("statistics/top")
  top(@Req() req: any, @Query() q: any) {
    return this.cancelCausesService.getTopStatistics(req.user, q);
  }

  @Permissions("cancel-causes.statistics")
  @Get("statistics/top-this-month")
  topThisMonth(@Req() req: any, @Query() q: any) {
    return this.cancelCausesService.getTopThisMonth(req.user, q);
  }

  @Permissions("cancel-causes.statistics")
  @Get("statistics/top-products")
  topProducts(@Req() req: any, @Query() q: any) {
    return this.cancelCausesService.getTopCancelledProducts(req.user, q);
  }

  @Permissions("cancel-causes.statistics")
  @Get("statistics/trend")
  trend(@Req() req: any, @Query() q: any) {
    return this.cancelCausesService.getTrend(req.user, q);
  }

  @Permissions("cancel-causes.statistics")
  @Get("statistics/by-employee")
  byEmployee(@Req() req: any, @Query() q: any) {
    return this.cancelCausesService.getByEmployee(req.user, q);
  }

  @Permissions("cancel-causes.statistics")
  @Get("statistics/sla")
  sla(@Req() req: any, @Query() q: any) {
    return this.cancelCausesService.getSlaStatistics(req.user, q);
  }

  @Permissions("cancel-causes.statistics")
  @Get("statistics/custom-vs-predefined")
  customVsPredefined(@Req() req: any, @Query() q: any) {
    return this.cancelCausesService.getCustomVsPredefined(req.user, q);
  }

  @Permissions("cancel-causes.statistics")
  @Get("statistics/pending-review")
  pendingReviewStats(@Req() req: any) {
    return this.cancelCausesService.getPendingReviewStats(req.user);
  }

  @Permissions("cancel-causes.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.cancelCausesService.get(req.user, id);
  }

  @Permissions("cancel-causes.create")
  @Post()
  create(@Req() req: any, @Body() dto: CreateCancelCauseDto) {
    return this.cancelCausesService.create(req.user, dto);
  }

  @Permissions("cancel-causes.update")
  @Patch(":id")
  update(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: UpdateCancelCauseDto,
  ) {
    return this.cancelCausesService.update(req.user, id, dto);
  }

  @Permissions("cancel-causes.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.cancelCausesService.remove(req.user, id);
  }

  @Permissions("cancel-causes.review")
  @Post(":id/accept")
  accept(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: ReviewCancelCauseDto,
  ) {
    return this.cancelCausesService.accept(req.user, id, dto);
  }

  @Permissions("cancel-causes.review")
  @Post(":id/reject")
  reject(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: ReviewCancelCauseDto,
  ) {
    return this.cancelCausesService.reject(req.user, id, dto);
  }
}
