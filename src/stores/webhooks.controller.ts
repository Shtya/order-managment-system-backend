// webhooks.controller.ts
import { Controller, Post, Body, Headers, Param, HttpCode, BadRequestException, Logger, Req, Get, Query, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { EasyOrderService } from "src/stores/storesIntegrations/EasyOrderService";
import { ShopifyService } from "src/stores/storesIntegrations/ShopifyService"
import { StoresService } from "./stores.service";

@Controller("stores/webhooks")
export class StoreWebhooksController {
    private readonly logger = new Logger(StoreWebhooksController.name);

    constructor(
        private readonly storesService: StoresService,
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
    /**
     * Endpoint for New Order Webhook
     */
    @Post(":adminId/:provider/orders/create")
    @HttpCode(200)
    async handleOrderCreate(
        @Param('adminId') adminId: string,
        @Param('provider') provider: string,
        @Headers() headers: Record<string, any>,
        @Req() req: any,
        @Body() body: any,
    ) {
        return await this.storesService.handleWebhookOrderCreate(provider, body, headers, adminId, req);
    }

    /**
     * Endpoint for Order Status Update Webhook
     */
    @Post(':provider/orders/status')
    @HttpCode(200)
    async handleOrderStatusUpdate(
        @Param('provider') provider: string,
        @Headers() headers: Record<string, any>,
        @Req() req: any,
        @Body() body: any,
    ) {
        return await this.storesService.handleWebhookOrderUpdate(provider, body, headers, req);
    }
}




