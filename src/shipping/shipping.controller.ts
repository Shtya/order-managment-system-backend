import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { ShippingCompaniesService } from "./shipping.service";
import { CreateShippingCompanyDto, UpdateShippingCompanyDto } from "dto/shipping.dto";
import { Permissions } from "common/permissions.decorator";

// shipping-companies.controller.ts
@Controller('shipping-companies')
@UseGuards(JwtAuthGuard)
export class ShippingCompaniesController {
    constructor(private readonly service: ShippingCompaniesService) { }

    @Post()
    @Permissions("shipping-companies.create")
    create(@Req() req, @Body() dto: CreateShippingCompanyDto) {
        return this.service.create(req.user, dto);
    }

    @Get()
    @Permissions("shipping-companies.read")
    findAll(@Req() req, @Query() q: any) {
        return this.service.list(req.user, q);
    }

    @Get(':id')
    @Permissions("shipping-companies.read")
    findOne(@Req() req, @Param("id") id: string) {
        return this.service.get(req.user, Number(id));
    }

    @Patch(':id')
    @Permissions("shipping-companies.update")
    update(@Req() req, @Param("id") id: string, @Body() dto: UpdateShippingCompanyDto) {
        return this.service.update(req.user, Number(id), dto);
    }

    @Delete(':id')
    @Permissions("shipping-companies.delete")
    remove(@Req() req, @Param("id") id: string) {
        return this.service.remove(req.user, Number(id));
    }
}