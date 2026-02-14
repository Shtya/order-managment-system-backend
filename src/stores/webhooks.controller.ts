// webhooks.controller.ts
import { Controller, Post, Body, Headers, Param, HttpCode, BadRequestException, Logger, Req, Get, Query, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { EasyOrderService } from "src/stores/storesIntegrations/EasyOrderService";
import { ShopifyService } from "src/stores/storesIntegrations/ShopifyService";

@Controller("webhooks")
export class StoreWebhooksController {
    private readonly logger = new Logger(StoreWebhooksController.name);

    constructor(
        private readonly easyOrderService: EasyOrderService,
        private readonly shopifyService: ShopifyService
    ) { }

    @Get('shopify/init')
    async handleInit(
        @Query() query: Record<string, any>,
        @Res() res: Response
    ) {
        const result = await this.shopifyService.Init(query);

        // This tells the browser to go to your React Dashboard
        return res.redirect(result.url);
    }

    @Post('shopify/order-create')
    async handleCreate(
        @Query() query: Record<string, any>,
        @Body() Body,
        @Res() res: Response
    ) {
        console.log()
    }
    @Post('shopify/order-status')
    async handleStatus(
        @Query() query: Record<string, any>,
        @Res() res: Response
    ) {

    }
    /**
     * Endpoint for New Order Webhook
     */
    @Post(":adminId/:provider/orders/create")
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
    @Post(":adminId/:provider/orders/status")
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


