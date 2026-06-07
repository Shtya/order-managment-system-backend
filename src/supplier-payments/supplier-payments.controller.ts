import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { SupplierPaymentsService } from './supplier-payments.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PermissionsGuard } from 'common/permissions.guard';
import { SubscriptionGuard } from 'common/subscription.guard';
import { CreateSupplierPaymentDto, SupplierPaymentFilterDto } from 'dto/supplier_payments.dto';
import { Response } from 'express';
import { Permissions } from 'common/permissions.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller('supplier-payments')
export class SupplierPaymentsController {
    constructor(private readonly supplierPaymentsService: SupplierPaymentsService) { }

    @Post()
    @Permissions("suppliers.update")
    async create(@Req() req: any, @Body() dto: CreateSupplierPaymentDto) {
        return await this.supplierPaymentsService.create(req.user, dto);
    }

    @Get()
    async findAll(@Req() req: any, @Query() q: SupplierPaymentFilterDto) {
        return await this.supplierPaymentsService.findAll(req.user, q);
    }

    @Get('export')
    @Permissions("suppliers.read")
    async export(@Req() req: any, @Res() res: Response, @Query() q: SupplierPaymentFilterDto) {
        const buffer = await this.supplierPaymentsService.export(req.user, q);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=supplier-payments-${Date.now()}.xlsx`);
        res.end(buffer);
    }

    @Get('stats')
    @Permissions("suppliers.read")
    async getStats(@Req() req: any) {
        return await this.supplierPaymentsService.getStats(req.user);
    }

    @Get(':id')
    @Permissions("suppliers.read")
    async findOne(@Req() req: any, @Param('id') id: string) {
        return await this.supplierPaymentsService.findOne(req.user, id);
    }
}
