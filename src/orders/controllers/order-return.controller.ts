import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { PermissionsGuard } from "common/permissions.guard";
import { JwtAuthGuard } from "src/auth/jwt-auth.guard";
import { OrderReturnService } from "../services/order-return.service";
import { CreateReturnDto } from "dto/order.dto";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@Controller("order-returns")
@RequireSubscription()
export class OrderReturnsController {
    constructor(private svc: OrderReturnService) { }

    @Post('return-request')
    @Permissions("return-request.create")
    async create(@Body() createReturnDto: CreateReturnDto, @Req() req) {
        return this.svc.createReturnRequest(createReturnDto, req.user);
    }
}