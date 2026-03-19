import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { PermissionsGuard } from "common/permissions.guard";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { OrderReturnService } from "../services/order-return.service";
import { CreateReturnDto } from "dto/order.dto";

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller("order-returns")
export class OrderReturnsController {
    constructor(private svc: OrderReturnService) { }
    @Post('return-request')
    async create(@Body() createReturnDto: CreateReturnDto, @Req() req) {
        return this.svc.createReturnRequest(createReturnDto, req.user);
    }
}