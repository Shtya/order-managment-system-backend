// webhooks.controller.ts
import { Controller, Post, Body, Headers, Param, HttpCode, BadRequestException, Logger } from "@nestjs/common";
import { EasyOrderService } from "src/stores/storesIntegrations/EasyOrderService";


@Controller("webhooks/:adminId/:provider")
export class OrderWebhooksController {
    private readonly logger = new Logger(OrderWebhooksController.name);

    constructor(private readonly easyOrderService: EasyOrderService) { }

    /**
     * Endpoint for New Order Webhook
     */
    @Post("orders/create")
    @HttpCode(200)
    async handleOrderCreate(
        @Param("adminId") adminId: string,
        @Param("provider") provider: string,
        @Headers("secret") secret: string,
        @Body() payload: any
    ) {
        if (!secret) throw new BadRequestException("Missing secret header");

        if (provider.trim().toLowerCase() === 'easy-order') {
            await this.easyOrderService.handleWebhookOrderCreate(
                Number(adminId),
                secret.trim(),
                payload
            );
        }
        return { success: true };
    }

    /**
     * Endpoint for Order Status Update Webhook
     */
    @Post("orders/status")
    @HttpCode(200)
    async handleOrderStatusUpdate(
        @Param("adminId") adminId: string,
        @Param("provider") provider: string,
        @Headers("secret") secret: string,
        @Body() payload: any
    ) {
        if (!secret) throw new BadRequestException("Missing secret header");

        if (provider.trim().toLowerCase() === 'easy-order') {
            await this.easyOrderService.handleWebhookStatusUpdate(
                Number(adminId),
                secret.trim(),
                payload
            );
        }

        return { success: true };
    }
}