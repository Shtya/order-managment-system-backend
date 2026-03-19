// orders/orders.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileFieldsInterceptor, FileInterceptor } from "@nestjs/platform-express";
import { Response } from "express";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { OrdersService } from "../services/orders.service";
import {
  CreateOrderDto,
  UpdateOrderDto,
  ChangeOrderStatusDto,
  UpdatePaymentStatusDto,
  AddOrderMessageDto,
  MarkMessagesReadDto,
  CreateStatusDto,
  UpdateStatusDto,
  UpsertOrderRetrySettingsDto,
  AutoAssignDto,
  ManualAssignManyDto,
  AutoPreviewDto,
  CreateManifestDto,
} from "dto/order.dto";
import { extname } from "path";
import { diskStorage } from "multer";
import { ScanLogType } from "entities/order.entity";


@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("orders")
export class OrdersController {
  constructor(private svc: OrdersService) { }

  // ✅ Get order statistics
  // @Permissions("orders.read")
  @Get("stats")
  stats(@Req() req: any) {
    return this.svc.getStats(req.user);
  }
  @Get("statuses")
  statuses(@Req() req: any) {
    return this.svc.getStatuses(req.user);
  }

  // employee-orders.controller.ts

  @Get("employee/orders/next")
  async getNextOrder(@Req() req: any) {
    return this.svc.getNextAssignedOrder(req.user);
  }


  @Permissions("orders.assign")
  @Post("assign-manual")
  async manualAssignOrders(@Req() req: any, @Body() dto: ManualAssignManyDto) {
    return this.svc.manualAssignMany(req.user, dto);
  }

  @Permissions("orders.assign")
  @Post("assign-auto")
  async assignAuto(@Req() req: any, @Body() dto: AutoAssignDto) {
    return this.svc.autoAssign(req.user, dto);
  }

  @Permissions("orders.assign")
  @Post('auto-assign-preview')
  async getAutoAssignPreview(
    @Req() req: any,
    @Body() dto: AutoPreviewDto
  ) {
    return await this.svc.getAutoPreview(req.user, dto);
  }

  @Post(':id/scan-preparation/:sku')
  async scanPreparation(
    @Param("id") id: string,
    @Param('sku') sku: string,
    @Req() req: any,
  ) {
    return await this.svc.scanItem(Number(id), sku, req.user);
  }


  @Post(':id/scan-shipping/:sku')
  async scanShipping(
    @Param("id") id: string,
    @Param('sku') sku: string,
    @Req() req: any,
  ) {
    return await this.svc.scanForShipping(Number(id), sku, req.user);
  }
  @Get(':id/scan-logs/:phase')
  async getScanLogs(
    @Param("id") id: string,
    @Param('phase') phase: ScanLogType,
    @Req() req) {
    return await this.svc.getOrderScanLogs(Number(id), phase, req.user);
  }

  @Permissions("orders.assign")
  @Get("free-orders/count")
  async getFreeOrdersCount(
    @Req() req: any,
    @Query('statusIds') statusIds?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    return this.svc.getFreeOrdersCount(req.user, {
      statusIds: statusIds
        ? statusIds.split(',').map(id => Number(id))
        : undefined,
      startDate: startDate ?? undefined,
      endDate: endDate ?? undefined,
    });
  }

  // @Permissions("orders.read")
  @Get('assigned')
  listMyAssigned(@Req() req: any, @Query('limit') limit: number) {
    return this.svc.listMyAssignedOrders(req.user, limit);
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
    return this.svc.getFreeOrders(req.user, {
      statusIds: statusIds
        ? statusIds.split(',').map(id => Number(id))
        : undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      cursor: cursor || undefined,
      limit: Number(limit ?? 20),
    });
  }


  // ✅ Get Employees Ordered By Lowest Active Assignments
  @Permissions("orders.assign")
  @Get("employees-by-load")
  async getEmployeesByLoad(
    @Req() req: any,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.getEmployeesByLoad(req.user, Number(limit ?? 20), cursor ? Number(cursor) : null);
  }

  @Get('manifests')
  async listManifests(
    @Query() q: any,
    @Req() req: any,
  ) {
    return await this.svc.listManifests(req.user, q);
  }
  @Get('logs')
  async logs(
    @Query() q: any,
    @Req() req: any,
  ) {
    return await this.svc.listLogs(req.user, q);
  }
  @Get('logs/export')
  async logsExport(
    @Query() q: any,
    @Req() req: any,
    @Res() res: Response
  ) {
    const buffer = await this.svc.exportLogs(req.user, q);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=orders_export_${Date.now()}.xlsx`);

    return res.send(buffer);
  }

  @Post("manifests")
  async createManifest(
    @Body() dto: CreateManifestDto,
    @Req() req: any
  ) {
    // req.user is passed as 'me' to the service
    return await this.svc.createManifest(dto, req.user);
  }
  @Post("manifests/return")
  async createManifestReturn(
    @Body() dto: CreateManifestDto,
    @Req() req: any
  ) {
    // req.user is passed as 'me' to the service
    return await this.svc.createReturnManifest(dto, req.user);
  }

  @Get(':id/manifests/scan-logs')
  async getManifestLogs(
    @Param("id") id: string,
    @Req() req: any,
  ) {
    return await this.svc.getManifestScanLogs(Number(id), req.user);
  }

  @Patch(':id/mark-manifest-printed')
  async markPrinted(
    @Param("id") id: string,
    @Req() req: any,
  ) {
    return await this.svc.markAsPrinted(Number(id), req.user);
  }

  @Get('manifests/:id')
  async getDetail(
    @Param("id") id: string,
    @Req() req: any,
  ) {
    return await this.svc.getManifestDetail(Number(id), req.user);
  }

  @Get('stats/returns-summary')
  async getReturnsSummary(@Req() req: any,) {
    return await this.svc.getReturnsSummaryStats(req?.user);
  }

  @Get('stats/shipping-summary')
  async getShippingSummary(@Req() req: any) {
    return await this.svc.getShippingSummary(req.user);
  }
  @Get('stats/rejected-orders')
  async getRejectedOrdersStats(@Req() req: any) {
    return await this.svc.getRejectedOrdersStats(req.user);
  }

  @Get('stats/logs')
  async getLogOperationalStats(@Req() req: any) {
    return await this.svc.getLogOperationalStats(req.user);
  }

  @Get('stats/print-lifecycle-summary')
  async getPrintLifecycleSummary(@Req() req: any) {
    return await this.svc.getPrintLifecycleStats(req.user);
  }

  @Get('stats/preparation-summary')
  async getPreparationSummary(@Req() req: any) {
    return await this.svc.getPreparationStats(req.user);
  }

  @Post('bulk-print')
  async bulkPrint(@Req() req: any, @Body() body: { orderNumbers: string[] }) {
    return this.svc.bulkPrint(req.user, body.orderNumbers);
  }

  // @Permissions("orders.confirm") // Adjust permission as needed
  @Put(':id/confirm-status')
  changeConfirmationStatus(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: ChangeOrderStatusDto,
    @Ip() ipAddress: string
  ) {
    return this.svc.changeConfirmationStatus(req.user, Number(id), dto, ipAddress);
  }

  // ✅ List orders with filters
  @Permissions("orders.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.svc.list(req.user, q);
  }

  // ✅ Export orders to Excel
  @Permissions("orders.read")
  @Get("export")
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.svc.exportOrders(req.user, q);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=orders_export_${Date.now()}.xlsx`);

    return res.send(buffer);
  }


  // ✅ Bulk upload: download template (matches CreateOrderDto, no IDs)
  @Permissions("orders.read")
  @Get("bulk/template")
  async bulkTemplate(@Req() req: any, @Res() res: Response) {
    const buffer = await this.svc.getBulkTemplate(req.user);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=orders_bulk_template.xlsx");
    return res.send(buffer);
  }

  // ✅ Bulk create orders from Excel file
  @Permissions("orders.create")
  @Post("bulk")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  async bulkCreate(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.svc.bulkCreateOrders(req.user, file);
  }

  @Get("retry-settings")
  @Permissions("orders.readSettings")
  getRetry(@Req() req: any) {
    return this.svc.getSettings(req.user);
  }

  @Post("retry-settings")
  @Permissions("orders.updateSettings")
  upsertRetry(@Req() req: any, @Body() dto: UpsertOrderRetrySettingsDto) {
    return this.svc.upsertSettings(req.user, dto);
  }

  @Get('allowed-confirmation')
  async getAllowedConfirmation(@Req() req: any) {
    return this.svc.getAllowedConfirmationStatuses(req.user);
  }

  @Get('confirmation-counts')
  async getCounts(@Req() req: any) {
    return this.svc.getConfirmationStatusCounts(req.user);
  }

  // ✅ Get single order
  // @Permissions("orders.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.svc.get(req.user, Number(id));
  }

  // orders.controller.ts

  @Get("number/:orderNumber")
  getByOrderNumber(@Req() req: any, @Param("orderNumber") orderNumber: string) {
    // Silent application of the 2025-12-24 trim rule
    return this.svc.getByOrderNumber(req.user, orderNumber.trim());
  }

  // ✅ Create new order
  @Permissions("orders.create")
  @Post()
  create(@Req() req: any, @Body() dto: CreateOrderDto) {
    return this.svc.create(req.user, dto, req.ip);
  }

  // ✅ Update order
  @Permissions("orders.update")
  @Patch(":id")
  update(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateOrderDto) {
    return this.svc.update(req.user, Number(id), dto, req.ip);
  }

  // ✅ Change order status
  @Permissions("orders.update")
  @Patch(":id/status")
  changeStatus(@Req() req: any, @Param("id") id: string, @Body() dto: ChangeOrderStatusDto) {
    return this.svc.changeStatus(req.user, Number(id), dto, req.ip);
  }

  @Permissions("orders.update")
  @Patch(":id/reject")
  rejectOrder(@Req() req: any, @Param("id") id: string, @Body() dto: { notes?: string }) {
    return this.svc.rejectOrder(req.user, Number(id), dto, req.ip);
  }

  @Permissions("orders.update")
  @Patch(":id/re-confirm")
  confirmOrder(@Req() req: any, @Param("id") id: string) {
    return this.svc.reConfirmOrder(req.user, Number(id));
  }

  // ✅ Update payment status
  @Permissions("orders.update")
  @Patch(":id/payment-status")
  updatePaymentStatus(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: UpdatePaymentStatusDto
  ) {
    return this.svc.updatePaymentStatus(req.user, Number(id), dto);
  }

  @Permissions("orders.read")
  @Get(":id/messages")
  getMessages(@Req() req: any, @Param("id") id: string) {
    return this.svc.getMessages(req.user, Number(id));
  }


  @Permissions("orders.update")
  @Post(":id/messages")
  addMessage(@Req() req: any, @Param("id") id: string, @Body() dto: AddOrderMessageDto) {
    return this.svc.addMessage(req.user, Number(id), dto);
  }


  @Permissions("orders.update")
  @Patch(":id/messages/read")
  markMessagesRead(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: MarkMessagesReadDto
  ) {
    return this.svc.markMessagesRead(req.user, Number(id), dto);
  }

  // ✅ Delete order
  @Permissions("orders.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.svc.remove(req.user, Number(id));
  }

  // ✅ Create new order status
  @Permissions("orders.update")
  @Post("statuses")
  createStatus(@Req() req: any, @Body() dto: CreateStatusDto) {
    return this.svc.createStatus(req.user, dto);
  }

  // ✅ Update order status
  @Permissions("orders.update")
  @Patch("statuses/:id")
  updateStatus(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: UpdateStatusDto
  ) {
    return this.svc.updateStatus(req.user, Number(id), dto);
  }

  // ✅ Delete order status
  @Permissions("orders.update")
  @Delete("statuses/:id")
  removeStatus(@Req() req: any, @Param("id") id: string) {
    return this.svc.removeStatus(req.user, Number(id));
  }



}