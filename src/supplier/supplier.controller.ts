import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { SuppliersService } from "./supplier.service";
import { CreateSupplierDto, UpdateSupplierDto, UpdateSupplierFinancialsDto } from "dto/supplier.dto";
import * as ExcelJS from "exceljs";

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("suppliers")
export class SuppliersController {
  constructor(private suppliersService: SuppliersService) {}

  @Permissions("suppliers.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.suppliersService.list(req.user, q);
  }

  @Permissions("suppliers.read")
  @Get("stats")
  stats(@Req() req: any) {
    return this.suppliersService.getStats(req.user);
  }

  @Permissions("suppliers.read")
  @Get("export")
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const records = await this.suppliersService.export(req.user, q);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("الموردين");

    // Add headers
    const headers = Object.keys(records[0] || {});
    worksheet.addRow(headers);

    // Add data
    records.forEach((record) => {
      worksheet.addRow(Object.values(record));
    });

    // Style headers
    worksheet.getRow(1).font = { bold: true };
    worksheet.columns.forEach((column) => {
      column.width = 20;
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="suppliers.xlsx"');

    await workbook.xlsx.write(res);
    res.end();
  }

  @Permissions("suppliers.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.suppliersService.get(req.user, Number(id));
  }

  @Permissions("suppliers.create")
  @Post()
  create(@Req() req: any, @Body() dto: CreateSupplierDto) {
    return this.suppliersService.create(req.user, dto);
  }

  @Permissions("suppliers.update")
  @Patch(":id")
  update(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliersService.update(req.user, Number(id), dto);
  }

  @Permissions("suppliers.update")
  @Patch(":id/financials")
  updateFinancials(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateSupplierFinancialsDto) {
    return this.suppliersService.updateFinancials(req.user, Number(id), dto);
  }

  @Permissions("suppliers.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.suppliersService.remove(req.user, Number(id));
  }
}