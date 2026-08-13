// webhooks.controller.ts
import { Controller, Post, Body, Headers, Param, HttpCode, BadRequestException, Logger, Req, Get, Query, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { EasyOrderService } from "src/stores/storesIntegrations/EasyOrderService";
import { ShopifyService } from "src/stores/storesIntegrations/ShopifyService"
import { StoresService } from "./stores.service";
import { SkipThrottle } from '@nestjs/throttler';


@SkipThrottle({ default: true })
@Controller("stores/webhooks")
export class StoreWebhooksController {
    private readonly logger = new Logger(StoreWebhooksController.name);

    constructor(
        private readonly storesService: StoresService,
        private readonly shopifyService: ShopifyService
    ) { }

    @Post('easyorder/callback')
    @HttpCode(200)
    async handleEasyOrdersAuth(
        @Query('adminId') adminId: string,
        @Query('storeId') internalStoreId: string,
        @Body() body: { api_key: string; store_id: string },
    ) {
        this.logger.log(
            `Received EasyOrders credentials for store: ${body.store_id}${internalStoreId
                ? ` (internal store ${internalStoreId})`
                : ''
            }`,
        );

        return this.storesService.saveEasyOrdersCredentials(adminId, {
            apiKey: body.api_key,
            storeId: body.store_id,
            internalStoreId,
        });
    }


    @Get(':adminId/shopify/init')
    async handleInit(
        @Param('adminId') adminId: string,
        @Query() query: Record<string, any>,
        @Res() res: Response
    ) {
        const result = await this.shopifyService.Init(query, adminId);

        // This tells the browser to go to your React Dashboard
        return res.redirect(result.url);
    }

    /**
     * Multi-store Shopify OAuth init. The :storeId segment identifies the exact
     * Shopify store to initialize (forwarded into the OAuth query so ShopifyService
     * resolves it instead of the legacy single-store fallback).
     */
    @Get(':adminId/:storeId/shopify/init')
    async handleInitWithStore(
        @Param('adminId') adminId: string,
        @Param('storeId') internalStoreId: string,
        @Query() query: Record<string, any>,
        @Res() res: Response
    ) {
        const result = await this.shopifyService.Init({ ...query, internalStoreId }, adminId);

        // This tells the browser to go to your React Dashboard
        return res.redirect(result.url);
    }
    /**
     * Endpoint for New Order Webhook
     * The :target segment is flexible: it may be a provider enum
     * (e.g. "easyorder") for a single store, or a store id (uuid) for
     * multi-store addressing.
     */
    @Post(":adminId/:target/orders/create")
    @HttpCode(200)
    async handleOrderCreate(
        @Param('adminId') adminId: string,
        @Param('target') target: string,
        @Headers() headers: Record<string, any>,
        @Req() req: any,
        @Body() body: any,
    ) {
        return await this.storesService.handleWebhookOrderCreate(target, body, headers, adminId, req);
    }

    /**
     * Endpoint for Order Status Update Webhook
     * The :target segment is flexible (provider enum or store id).
     */
    @Post(':adminId/:target/orders/status')
    @HttpCode(200)
    async handleOrderStatusUpdate(
        @Param('adminId') adminId: string,
        @Param('target') target: string,
        @Headers() headers: Record<string, any>,
        @Req() req: any,
        @Body() body: any,
    ) {
        return await this.storesService.handleWebhookOrderUpdate(target, body, headers, adminId, req);
    }
}




