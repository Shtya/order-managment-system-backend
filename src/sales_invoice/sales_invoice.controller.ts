// sales-invoices/sales-invoices.controller.ts
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
 import {
  CreateSalesInvoiceDto,
  UpdateSalesInvoiceDto,
  UpdateSalesPaymentStatusDto,
} from "dto/sales_invoice.dto";
import { SalesInvoicesService } from "./sales_invoice.service";

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("sales-invoices")
export class SalesInvoicesController {
  constructor(private svc: SalesInvoicesService) {}

  // ✅ for dashboard cards
  @Permissions("sales_invoices.read")
  @Get("stats")
  stats(@Req() req: any) {
    return this.svc.stats(req.user);
  }

  @Permissions("sales_invoices.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.svc.list(req.user, q);
  }

  @Permissions("sales_invoices.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.svc.get(req.user, Number(id));
  }

  @Permissions("sales_invoices.create")
  @Post()
  create(@Req() req: any, @Body() dto: CreateSalesInvoiceDto) {
    return this.svc.create(req.user, dto);
  }

  @Permissions("sales_invoices.update")
  @Patch(":id")
  update(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateSalesInvoiceDto) {
    return this.svc.update(req.user, Number(id), dto);
  }

  @Permissions("sales_invoices.update")
  @Patch(":id/payment-status")
  updatePaymentStatus(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateSalesPaymentStatusDto) {
    return this.svc.updatePaymentStatus(req.user, Number(id), dto.paymentStatus);
  }

  @Permissions("sales_invoices.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.svc.remove(req.user, Number(id));
  }
}
